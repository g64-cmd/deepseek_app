// 聊天服务回归的边界替身：内存 IndexedDB、Keystore 关闭、翻译透传。
// fetch / localStorage / document 由测试文件在编译前设置全局替身。
const sessions = new Map()
const files = new Map()
exports.runtime = { sessions, files }
exports.loadSession = async (id) => structuredClone(sessions.get(id))
exports.loadSessionSummaries = async () =>
  [...sessions.values()].map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }))
exports.saveSession = async (session) => { sessions.set(session.id, structuredClone(session)) }
exports.loadFile = async (id) => files.get(id)
exports.reportStorageError = () => (error) => { throw error }
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
