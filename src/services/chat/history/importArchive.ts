import * as db from '../db.js'
import { BackupError, fail } from './errors.js'
import type { ArchiveKind, AppSettingsFile, SessionIndexEntry } from './format.js'
import {
  APP_SETTINGS_PATH,
  INDEX_PATH,
  MANIFEST_PATH,
  USER_PATH,
  fullFilesDir,
  parseSessionPath,
  sessionFilesDir,
} from './paths.js'
import {
  checkManifest,
  readAppSettings,
  readSessionFile,
  readSessionIndex,
} from './schema.js'
import { toLocalSession } from './toLocal.js'
import {
  ArchiveError,
  isZipFile,
  readArchive,
  readEntry,
  skipEntry,
  type ArchiveEntry,
} from './zipReader.js'

/** 从原件字节补充图片 MIME；无法识别时为空字符串，图片身份仍由归档的 is_image 决定。 */
const imageType = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

const readJson = async (entry: ArchiveEntry): Promise<unknown> => {
  const text = await (await readEntry(entry)).text()
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

/**
 * 检查 ZIP 格式、首个 manifest 条目及格式版本，返回识别出的归档类型。
 * 校验失败时保留正在生成的回答和现有暂存数据。
 */
export const checkArchiveFormat = async (file: File): Promise<ArchiveKind> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  try {
    for await (const entry of readArchive(file)) {
      if (entry.path !== MANIFEST_PATH) {
        fail('backupUnrecognized')
      }
      return checkManifest(await readJson(entry))
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  return fail('backupUnrecognized')
}

/**
 * 流式导入：manifest → user（不导入）→ 全部会话 JSON → index → app_settings（仅完整备份，不导入）
 * → 全部附件（v3 每会话目录的图片 / v4 files/ 下全部附件）。
 * 也支持会话与附件交错排列、index 位于末尾的条目顺序。
 * 会话读完立即暂存，只保留附件路径映射；附件全部读完后逐会话回填 MIME，不改变图片身份。
 * 写入导入暂存存储；调用方负责先清空暂存，成功后替换正式数据，失败时清理暂存。
 * 返回完整备份携带的应用设置（legacy 与损坏的 app_settings 均为 null）。
 */
export const importArchive = async (file: File): Promise<AppSettingsFile | null> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  const imported = new Set<string>()
  const images = new Map<string, { id: string; mimeType: string }>()
  /** 已保存的原件：文件 ID → MIME。同一附件出现在多个条目时只保存一次。 */
  const stored = new Map<string, string>()
  let kind: ArchiveKind | null = null
  let settings: AppSettingsFile | null = null
  let index: SessionIndexEntry[] | undefined
  let currentSessionId: string | undefined

  const saveFile = async (entry: ArchiveEntry, id: string, mimeType: string) => {
    if (stored.has(id)) {
      await skipEntry(entry)
      return
    }
    const data = await readEntry(entry)
    const type = mimeType || imageType(new Uint8Array(await data.slice(0, 16).arrayBuffer()))
    await db.saveStagingFiles([{ id, blob: new Blob([data], { type }) }])
    stored.set(id, type)
  }

  try {
    for await (const entry of readArchive(file)) {
      const { path } = entry
      const sessionId = parseSessionPath(path)
      if (kind === null) {
        if (path !== MANIFEST_PATH) {
          fail('backupUnrecognized')
        }
        kind = checkManifest(await readJson(entry))
      } else if (path === USER_PATH && !index && imported.size === 0) {
        // 账号信息（已脱敏）不导入；文件可能缺失。
        await skipEntry(entry)
      } else if (sessionId !== null && !index) {
        const local = toLocalSession(readSessionFile(await readJson(entry)))
        if (local.session.id !== sessionId || imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        imported.add(sessionId)
        currentSessionId = sessionId
        for (const [entryPath, info] of local.images) {
          images.set(entryPath, info)
        }
        await db.addStagingSession(local.session)
      } else if (path === INDEX_PATH && !index) {
        index = readSessionIndex(await readJson(entry))
      } else if (path === APP_SETTINGS_PATH && index) {
        // 仅完整备份携带；设置在会话替换成功后由调用方应用
        settings = readAppSettings(await readJson(entry))
      } else if (index && kind === 'full' && path.startsWith(fullFilesDir)) {
        // 没有被引用的条目不保存，引用了但缺失的附件只展示文件名。
        const info = images.get(path)
        await (info === undefined ? skipEntry(entry) : saveFile(entry, info.id, info.mimeType))
      } else if (
        index
          ? imported.has(/^chat_sessions\/([^/]+)_files\//.exec(path)?.[1] ?? '')
          : currentSessionId && path.startsWith(sessionFilesDir(currentSessionId))
      ) {
        const info = images.get(path)
        await (info === undefined ? skipEntry(entry) : saveFile(entry, info.id, info.mimeType))
      } else {
        fail('backupIncomplete')
      }
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  if (kind === null) {
    fail('backupUnrecognized')
  }
  // index 只列出成功写出的会话，与会话文件一一对应。
  const listed = new Set(index?.map((entry) => entry.id))
  if (
    !index ||
    listed.size !== index.length ||
    listed.size !== imported.size ||
    [...imported].some((id) => !listed.has(id))
  ) {
    fail('backupIncomplete')
  }
  await db.updateStagingFileTypes(stored)
  return kind === 'full' ? settings : null
}
