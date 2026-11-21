// 聊天服务回归的边界替身：内存 IndexedDB、Keystore 关闭、翻译透传。
// fetch / localStorage / document 由测试文件在编译前设置全局替身。
// saveSession 支持按开关注入事务失败（模拟配额/存储错误）；错误只记录不抛，
// 与生产的 console.error 日志行为一致。
const sessions = new Map()
const files = new Map()
const runtime = { sessions, files, rejectCompletedSave: false, errors: [] }
exports.runtime = runtime
exports.loadSession = async (id) => structuredClone(sessions.get(id))
exports.loadSessionSummaries = async () =>
  [...sessions.values()].map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }))
exports.saveSession = async (session) => {
  if (runtime.rejectCompletedSave && session.messages.at(-1)?.status === 'done') {
    throw new DOMException('Fixture: completed transaction cannot be committed', 'QuotaExceededError')
  }
  sessions.set(session.id, structuredClone(session))
}
exports.loadFile = async (id) => files.get(id)
exports.reportStorageError = (action) => (error) => {
  runtime.errors.push({ action, error })
}
exports.clearStaging = async () => {}
exports.commitStaging = async () => []
exports.addStagingSession = async () => {}
exports.saveStagingFiles = async () => {}
exports.updateStagingFileTypes = async () => {}
exports.renameSession = async () => {}
exports.deleteSession = async () => {}
exports.secureCredentialsAvailable = false
exports.readSecureApiKey = async () => null
exports.writeSecureApiKey = async () => {}
exports.translate = (key) => key
exports.isTranslationKey = () => true
