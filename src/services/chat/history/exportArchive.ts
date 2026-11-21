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
  options?: { full?: boolean; appSettings?: AppSettingsFile }
): Promise<Blob> => {
  const full = options?.full === true
  const manifest: Manifest = full
    ? { export_format_version: FULL_FORMAT_VERSION, archive_kind: 'full' }
    : { export_format_version: EXPORT_FORMAT_VERSION }
  const entries = [{ name: MANIFEST_PATH, blob: json(manifest) }]
  const fileEntries: { name: string; blob: Blob }[] = []
  const index: SessionIndexEntry[] = []
  const originals = new Map<string, Blob | undefined>()
  for await (const session of sessions) {
    for (const message of session.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        if (!originals.has(file.id) && (full || file.isImage)) {
          originals.set(file.id, await db.loadFile(file.id))
        }
      }
    }
    const files = new Map<string, Blob>()
    const data = toSessionFile(
      session,
      ({ id, name, isImage }) => {
        const blob = originals.get(id)
        if (!blob || (!full && !isImage)) {
          return null
        }
        const path = full ? fullFilePath(id) : imagePath(session.id, id, name)
        files.set(path, blob)
        return path
      },
      full
    )
    entries.push({ name: sessionPath(session.id), blob: json(data) })
    for (const [name, blob] of files) {
      fileEntries.push({ name, blob })
    }
    index.push(toIndexEntry(data))
  }
  entries.push({ name: INDEX_PATH, blob: json(index) })
  if (full && options?.appSettings) {
    entries.push({ name: APP_SETTINGS_PATH, blob: json(options.appSettings) })
  }
  return writeArchive(entries.concat(fileEntries))
}
