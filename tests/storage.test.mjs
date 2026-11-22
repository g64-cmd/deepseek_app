import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { compile, root } from './helpers/compile.mjs'

const globalKeys = [
  'localStorage',
  'document',
  'window',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]
const globals = new Map(
  globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
)
let api
before(async () => {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  }
  globalThis.document = new EventTarget()
  document.visibilityState = 'hidden'
  globalThis.window = new EventTarget()
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  const runtime = path.join(root, 'tests/helpers/runtime/chat.cjs')
  const replacements = new Map(
    ['src/services/chat/db.js', 'src/platform/secureStorage.js', 'src/i18n/index.js'].map(
      (name) => [path.join(root, name), runtime]
    )
  )
  api = await compile('./tests/helpers/entries/storage.ts', 'storage', replacements)
})
after(() => {
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

const tick = () => new Promise((resolve) => setImmediate(resolve))
const session = (id) => ({
  id,
  title: 'Original title',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  messages: [],
  rootMessageId: null,
})
const reset = (id, loaded = false) => {
  const stored = session(id)
  api.runtime.sessions.clear()
  api.runtime.files.clear()
  api.runtime.renames.length = 0
  api.runtime.saves.length = 0
  api.runtime.saveAttempts.length = 0
  api.runtime.deferSaves = false
  api.runtime.rejectAllSaves = false
  api.runtime.rejectCompletedSave = false
  api.runtime.manualRenames = true
  api.runtime.sessions.set(id, structuredClone(stored))
  api.useChatStore.setState({
    ready: true,
    importingHistory: false,
    sessions: [stored],
    sessionCache: loaded ? { [id]: stored } : {},
    streaming: {},
    activeId: null,
    sessionSaveErrors: {},
  })
  localStorage.clear()
  return stored
}

for (const results of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
]) {
  test(`consecutive unloaded renames recover the last committed title (${results.join(', ')})`, async () => {
    const id = `rename-${results.join('-')}`
    reset(id)
    const first = api.renameSession(id, 'First title')
    const second = api.renameSession(id, 'Second title')
    assert.equal(api.useChatStore.getState().sessions[0].title, 'Second title')
    api.runtime.finishRename(0, results[0])
    assert.equal(await first, results[0])
    assert.equal(
      api.useChatStore.getState().sessions[0].title,
      'Second title',
      'older completion must not replace the latest optimistic title'
    )
    api.runtime.finishRename(1, results[1])
    assert.equal(await second, results[1])
    const expected = results[1] ? 'Second title' : results[0] ? 'First title' : 'Original title'
    assert.equal(api.runtime.sessions.get(id).title, expected)
    assert.equal(api.useChatStore.getState().sessions[0].title, expected)
  })
}

test('loading detail during failed renames cannot persist an uncommitted optimistic title', async () => {
  const id = 'load-during-rename'
  reset(id)
  const first = api.renameSession(id, 'First title')
  const second = api.renameSession(id, 'Second title')
  api.selectSession(id)
  await tick()
  assert.equal(api.useChatStore.getState().sessionCache[id].title, 'Second title')
  api.retrySaveSessions()
  await tick()
  assert.equal(
    api.runtime.saveAttempts.length,
    0,
    'whole-session saves must wait for outstanding title operations'
  )
  api.runtime.finishRename(0, false)
  await first
  api.runtime.finishRename(1, false)
  await second
  await tick()
  assert.equal(api.useChatStore.getState().sessionCache[id].title, 'Original title')
  assert.equal(api.useChatStore.getState().sessions[0].title, 'Original title')
  assert.equal(api.runtime.sessions.get(id).title, 'Original title')
})

test('a loaded rename takes ownership from an older failing list rename', async () => {
  const id = 'loaded-rename-owner'
  reset(id)
  const first = api.renameSession(id, 'First title')
  api.selectSession(id)
  await tick()
  assert.equal(await api.renameSession(id, 'Latest loaded title'), true)
  api.runtime.finishRename(0, false)
  assert.equal(await first, false)
  await tick()
  assert.equal(api.useChatStore.getState().sessions[0].title, 'Latest loaded title')
  assert.equal(api.useChatStore.getState().sessionCache[id].title, 'Latest loaded title')
  assert.equal(api.runtime.sessions.get(id).title, 'Latest loaded title')
})

test('history replacement waits for old rename settlement before a reused ID becomes visible', async () => {
  const id = 'rename-across-replacement'
  reset(id)
  const rename = api.renameSession(id, 'Old optimistic title')
  const replacement = api.replaceHistory(async () => {})
  await tick()
  assert.equal(api.useChatStore.getState().importingHistory, true)
  api.runtime.finishRename(0, false)
  assert.equal(await rename, false)
  await replacement
  assert.deepEqual(api.useChatStore.getState().sessions, [])
  const incoming = { ...session(id), title: 'Imported title' }
  api.useChatStore.setState({ sessions: [incoming] })
  await tick()
  assert.equal(api.useChatStore.getState().sessions[0].title, 'Imported title')
})

test('late rename failure cannot restore a deleted session', async () => {
  const id = 'rename-after-delete'
  reset(id)
  const rename = api.renameSession(id, 'Old optimistic title')
  assert.equal(await api.removeSession(id), true)
  api.runtime.finishRename(0, false)
  assert.equal(await rename, false)
  assert.deepEqual(api.useChatStore.getState().sessions, [])
  assert.equal(api.runtime.sessions.has(id), false)
})

for (const action of ['replace', 'delete']) {
  test(`a late save callback cannot invalidate or mutate history after ${action}`, async () => {
    const id = `late-save-${action}`
    reset(id, true)
    api.runtime.manualRenames = false
    api.runtime.deferSaves = true
    await api.renameSession(id, 'Queued title')
    const pending = api.runtime.saves.shift()
    assert.ok(pending)
    // Model an already committed old transaction whose JS callback has not resumed yet.
    api.runtime.sessions.set(id, structuredClone(pending.snapshot))
    if (action === 'replace') await api.replaceHistory(async () => {})
    else assert.equal(await api.removeSession(id), true)
    const revision = localStorage.getItem('chat-demo:usage-revision')
    pending.resolve()
    await tick()
    assert.equal(localStorage.getItem('chat-demo:usage-revision'), revision)
    assert.deepEqual(api.useChatStore.getState().sessions, [])
    assert.deepEqual(api.useChatStore.getState().sessionSaveErrors, {})
    api.runtime.deferSaves = false
  })
}
