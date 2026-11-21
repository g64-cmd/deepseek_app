/** ZIP 条目名。条目顺序固定：manifest → user（可能缺失）→ 全部会话 JSON → index → app_settings（仅完整备份）→ 全部附件。 */

export const MANIFEST_PATH = 'manifest.json'
export const USER_PATH = 'user.json'
export const INDEX_PATH = 'chat_session_index.json'
export const APP_SETTINGS_PATH = 'app_settings.json'

export const sessionPath = (sessionId: string) => `chat_sessions/${sessionId}.json`

/** 会话自己的图片目录，带结尾斜杠 */
export const sessionFilesDir = (sessionId: string) => `chat_sessions/${sessionId}_files/`

/** 完整备份的全部附件目录，带结尾斜杠 */
export const fullFilesDir = 'files/'

/** 完整备份的附件条目：files/{file_id}；文件 ID 已排除路径分隔符（本地生成的 UUID） */
export const fullFilePath = (fileId: string) => `${fullFilesDir}${safeName(fileId)}`.normalize('NFC')

/** files/ 目录下的文件 ID；其他条目返回 null */
export const parseFullFilePath = (path: string): string | null =>
  path.startsWith(fullFilesDir) && path.length > fullFilesDir.length
    ? path.slice(fullFilesDir.length)
    : null

/** 会话 JSON 条目对应的会话 ID；其他条目返回 null */
export const parseSessionPath = (path: string): string | null =>
  /^chat_sessions\/([^/]+)\.json$/.exec(path)?.[1] ?? null

/** 安全路径片段：路径分隔符映射为 _，空值、. 与 .. 映射为 unnamed */
const safeName = (name: string) => {
  const result = name.replace(/[/\\]/g, '_')
  return result === '' || result === '.' || result === '..' ? 'unnamed' : result
}

/** chat_sessions/{session_id}_files/{file_id}_{file_name}；与 ZIP 读写端一致使用 NFC。 */
export const imagePath = (sessionId: string, fileId: string, fileName: string) =>
  `${sessionFilesDir(sessionId)}${safeName(fileId)}_${safeName(fileName)}`.normalize('NFC')
