import * as db from '../db.js'
import type { Session } from '../types.js'
import {
  EXPORT_FORMAT_VERSION,
  FULL_FORMAT_VERSION,
  type AppSettingsFile,
  type Manifest,
  type SessionIndexEntry,
} from './format.js'
import {
  APP_SETTINGS_PATH,
  INDEX_PATH,
  MANIFEST_PATH,
  fullFilePath,
  imagePath,
  sessionPath,
} from './paths.js'
import { toIndexEntry, toSessionFile } from './toArchive.js'
import { writeArchive } from './zipWriter.js'

const json = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' })

/**
 * 生成导出 ZIP。
 * 兼容格式（v3）：manifest → 全部会话 JSON → index → 全部图片（每会话目录各一份，仅本地有原件的图片）。
 * 完整备份（v4，options.full）：manifest(kind=full) → 会话 JSON（含 model/effort/usage 与附件 MIME）
 * → index → app_settings.json（调用方构造，不含 API Key）→ files/ 下全部附件原件（含非图片）。
 */
export const exportArchive = async (
  sessions: Iterable<Session> | AsyncIterable<Session>,
  options?: { full?: boolean; appSettings?: AppSettingsFile; originals?: ReadonlyMap<string, Blob> }
): Promise<Blob> => {
  const full = options?.full === true
  const manifest: Manifest = full
    ? { export_format_version: FULL_FORMAT_VERSION, archive_kind: 'full' }
    : { export_format_version: EXPORT_FORMAT_VERSION }
  const entries = [{ name: MANIFEST_PATH, blob: json(manifest) }]
  // 条目按最终路径全局去重：v4 的 files/{id} 会被多个会话共享引用，v3 路径含会话 ID 天然互异
  const fileEntries = new Map<string, Blob>()
  const index: SessionIndexEntry[] = []
  const originals = new Map<string, Blob | undefined>()
  for await (const session of sessions) {
    for (const message of session.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        if (!originals.has(file.id) && (full || file.isImage)) {
          // 保存失败时原件可能只在内存中；优先使用导出开始时捕获的 Blob。
          originals.set(file.id, options?.originals?.get(file.id) ?? (await db.loadFile(file.id)))
        }
      }
    }
    const data = toSessionFile(
      session,
      ({ id, name, isImage }) => {
        const blob = originals.get(id)
        if (!blob || (!full && !isImage)) {
          return null
        }
        const path = full ? fullFilePath(id) : imagePath(session.id, id, name)
        fileEntries.set(path, blob)
        return path
      },
      full
    )
    entries.push({ name: sessionPath(session.id), blob: json(data) })
    index.push(toIndexEntry(data))
  }
  entries.push({ name: INDEX_PATH, blob: json(index) })
  if (full && options?.appSettings) {
    entries.push({ name: APP_SETTINGS_PATH, blob: json(options.appSettings) })
  }
  return writeArchive([...entries, ...[...fileEntries].map(([name, blob]) => ({ name, blob }))])
}
