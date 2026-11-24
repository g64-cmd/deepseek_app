const sessions = new Map(),
  files = new Map(),
  stagedSessions = new Map(),
  stagedFiles = new Map()
const runtime = {
  sessions,
  files,
  rejectCompletedSave: false,
  rejectAllSaves: false,
  errors: [],
  deferSaves: false,
  saves: [],
  saveAttempts: [],
  manualRenames: false,
  deferLoads: false,
  loads: [],
  renames: [],
}
exports.runtime = runtime
exports.loadSession = async (id) =>
  runtime.deferLoads
    ? new Promise((resolve, reject) => runtime.loads.push({ id, resolve, reject }))
    : structuredClone(sessions.get(id))
exports.loadSessionSummaries = async () =>
  [...sessions.values()].map(({ id, title, createdAt, updatedAt }) => ({
    id,
    title,
    createdAt,
    updatedAt,
  }))
const commit = (session, originals = []) => {
  if (
    runtime.rejectAllSaves ||
    (runtime.rejectCompletedSave && session.messages.at(-1)?.status === 'done')
  )
    throw new DOMException('Fixture transaction failure', 'QuotaExceededError')
  sessions.set(session.id, structuredClone(session))
  for (const file of originals) files.set(file.id, file.blob)
}
exports.saveSession = async (session, originals = []) => {
  const snapshot = structuredClone(session)
  runtime.saveAttempts.push({ snapshot, originals })
  if (!runtime.deferSaves) return commit(snapshot, originals)
  return new Promise((resolve, reject) => {
    runtime.saves.push({ snapshot, originals, resolve, reject })
  })
}
runtime.commitNextSave = async () => {
  const task = runtime.saves.shift()
  if (!task) throw new Error('No pending save')
  try {
    commit(task.snapshot, task.originals)
    task.resolve()
  } catch (error) {
    task.reject(error)
  }
  await new Promise((resolve) => setImmediate(resolve))
}
exports.loadFile = async (id) => files.get(id)
exports.reportStorageError = (action) => (error) => {
  runtime.errors.push({ action, error })
}
exports.clearStaging = async () => {
  stagedSessions.clear()
  stagedFiles.clear()
}
exports.commitStaging = async () => {
  sessions.clear()
  files.clear()
  for (const [id, session] of stagedSessions) sessions.set(id, session)
  for (const [id, blob] of stagedFiles) files.set(id, blob)
  return exports.loadSessionSummaries()
}
exports.addStagingSession = async (session) => {
  stagedSessions.set(session.id, structuredClone(session))
}
exports.saveStagingFiles = async (originals) => {
  for (const file of originals) stagedFiles.set(file.id, file.blob)
}
exports.updateStagingFileTypes = async () => {}
exports.renameSession = async (id, title) => {
  if (runtime.manualRenames)
    return new Promise((resolve, reject) => {
      runtime.renames.push({ id, title, resolve, reject })
    })
  const session = sessions.get(id)
  if (session) sessions.set(id, { ...session, title })
}
runtime.finishRename = (index, ok) => {
  const task = runtime.renames[index]
  if (!ok) return task.reject(new Error('Fixture first rename failure'))
  const session = sessions.get(task.id)
  if (session) sessions.set(task.id, { ...session, title: task.title })
  task.resolve()
}
exports.deleteSession = async (id) => {
  sessions.delete(id)
}
exports.secureCredentialsAvailable = false
exports.readSecureApiKey = async () => null
exports.writeSecureApiKey = async () => {}
exports.translate = (key) => key
exports.isTranslationKey = () => true
