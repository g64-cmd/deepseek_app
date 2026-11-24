import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { compile, root } from './helpers/compile.mjs'

const keys = ['localStorage', 'document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame']
const globals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
let api
before(async () => {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  }
  globalThis.document = new EventTarget()
  document.visibilityState = 'hidden'
  globalThis.window = new EventTarget()
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  const runtime = path.join(root, 'tests/helpers/runtime/chat.cjs')
  api = await compile(
    './tests/helpers/entries/history-search.ts',
    'history-search',
    new Map(
      ['src/services/chat/db.js', 'src/platform/secureStorage.js', 'src/i18n/index.js'].map(
        (file) => [path.join(root, file), runtime]
      )
    )
  )
})
after(() => {
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})
const user = (id, parentId, content = 'question', selectedChildId) => ({
  id,
  role: 'user',
  content,
  files: [],
  parentId,
  selectedChildId,
  createdAt: 1,
})
const answer = (id, parentId, text, selectedChildId) => ({
  id,
  role: 'assistant',
  parentId,
  selectedChildId,
  model: null,
  prefix: false,
  status: 'done',
  blocks: [{ type: 'text', text }],
  createdAt: 1,
})
const branch = () => ({
  id: 'branches',
  title: '中文 History',
  createdAt: 1,
  updatedAt: 1,
  rootMessageId: 'u1',
  messages: [
    user('u1', null, 'first', 'a1'),
    answer('a1', 'u1', 'visible', 'u2'),
    user('u2', 'a1'),
    answer('alternate', 'u1', 'alternate', 'deep'),
    user('deep', 'alternate', 'needle Needle NEEDLE', 'hit'),
    answer('hit', 'deep', 'needle in final answer', 'tail'),
    user('tail', 'hit', 'tail'),
  ],
})
const runScan = (sessions, query, extra = {}) =>
  api.scanHistory({
    summaries: sessions,
    query,
    signal: new AbortController().signal,
    load: async (id) => sessions.find((session) => session.id === id),
    onProgress() {},
    ...extra,
  })
const resetStore = (session = branch(), loaded = true) => {
  api.runtime.sessions.clear()
  api.runtime.sessions.set(session.id, structuredClone(session))
  api.runtime.deferLoads = false
  api.runtime.loads.length = 0
  api.runtime.rejectAllSaves = false
  api.useChatStore.setState({
    ready: true,
    importingHistory: false,
    sessions: [session],
    sessionCache: loaded ? { [session.id]: session } : {},
    activeId: null,
    messageTarget: null,
    streaming: {},
    sessionSaveErrors: {},
  })
  return session
}

test('title filtering uses summaries, matches Chinese and case-insensitive English, clears and handles empty results', () => {
  const summaries = [branch(), { ...branch(), id: 'second', title: 'Other' }].map(
    ({ messages, ...summary }) => summary
  )
  assert.deepEqual(api.filterSessionTitles(summaries, ' 中文 '), [summaries[0]])
  assert.deepEqual(api.filterSessionTitles(summaries, 'HISTORY'), [summaries[0]])
  assert.equal(api.filterSessionTitles(summaries, 'missing').length, 0)
  assert.equal(api.filterSessionTitles(summaries, '  '), summaries)
})

test('body search covers all branches once per message and excludes thinking, tool blocks, templates, unfinished and refused content', async () => {
  const session = branch()
  session.messages.push(
    {
      ...answer('private', 'tail', 'no'),
      blocks: [
        { type: 'thinking', thinking: 'needle' },
        { type: 'text', text: 'needle', isTemplate: true },
        { type: 'server_tool_use', name: 'needle', input: { query: 'needle' } },
      ],
    },
    { ...answer('streaming', 'tail', 'needle'), status: 'streaming' },
    { ...answer('refused', 'tail', 'needle'), stopReason: 'refusal' }
  )
  session.messages[0].files.push({ name: 'needle.txt' })
  const result = await runScan([session], 'NEEDLE')
  assert.equal(result.total, 2)
  assert.deepEqual(
    result.hits.map((hit) => [hit.messageId, hit.otherBranch]),
    [
      ['deep', true],
      ['hit', true],
    ]
  )
  assert.ok(result.hits.every((hit) => hit.snippet.toLowerCase().includes('needle')))
})

test('arbitrary deep hit selects every ancestor and preserves the continuation without changing original data', () => {
  const session = branch()
  const snapshot = structuredClone(session)
  const selected = api.selectMessagePath(session, 'hit')
  assert.deepEqual(
    api.getVisibleMessages(selected).map((message) => message.id),
    ['u1', 'alternate', 'deep', 'hit', 'tail']
  )
  assert.deepEqual(session, snapshot)
  assert.equal(selected.messages.length, session.messages.length)
  assert.equal(api.selectMessagePath(selected, 'hit'), selected)
  assert.equal(api.selectMessagePath(session, 'deleted'), undefined)
  const cycle = branch()
  cycle.messages[4].parentId = 'hit'
  assert.equal(api.selectMessagePath(cycle, 'hit'), undefined)
  const orphan = branch()
  orphan.messages[4].parentId = 'missing'
  assert.equal(api.selectMessagePath(orphan, 'hit'), undefined)
})

test('legacy linear and alternate-root hits remain navigable', () => {
  const legacy = {
    ...branch(),
    rootMessageId: undefined,
    messages: [user('u', undefined), answer('a', undefined, 'answer')],
  }
  assert.deepEqual(
    api.getVisibleMessages(api.selectMessagePath(legacy, 'a')).map((message) => message.id),
    ['u', 'a']
  )
  const session = branch()
  session.messages.push(user('root2', null, 'root2', 'a2'), answer('a2', 'root2', 'new root'))
  assert.deepEqual(
    api.getVisibleMessages(api.selectMessagePath(session, 'a2')).map((message) => message.id),
    ['root2', 'a2']
  )
})

test('scan cancels after in-flight read and never publishes stale progress', async () => {
  const abort = new AbortController()
  let resolve,
    reports = 0,
    reads = 0
  const task = runScan([branch()], 'needle', {
    signal: abort.signal,
    load: () => {
      reads++
      return new Promise((done) => {
        resolve = done
      })
    },
    onProgress: () => reports++,
  })
  await new Promise((done) => setImmediate(done))
  abort.abort()
  resolve(branch())
  await assert.rejects(task, { name: 'AbortError' })
  assert.equal(reads, 1)
  assert.equal(reports, 0)
})

test('long messages yield between text chunks and support cross-chunk matches', async () => {
  const session = branch()
  session.messages = [user('long', null, 'x'.repeat(8190) + 'needle' + 'x'.repeat(90000))]
  session.rootMessageId = 'long'
  const result = await runScan([session], 'needle')
  assert.equal(result.total, 1)
  const controller = new AbortController()
  const many = Array.from({ length: 33 }, (_, i) => ({ ...session, id: String(i) }))
  let yields = 0
  await assert.rejects(
    runScan(many, 'absent', {
      signal: controller.signal,
      yieldTask: async () => {
        yields++
        controller.abort()
      },
    }),
    { name: 'AbortError' }
  )
  assert.ok(yields > 0)
})

test('results are bounded while total counts all matches and missing records are explicit', async () => {
  const session = branch()
  session.messages = Array.from({ length: 230 }, (_, n) => user(`hit-${n}`, null, 'needle'))
  session.rootMessageId = 'hit-0'
  const result = await runScan([session, { ...session, id: 'missing' }], 'needle', {
    load: async (id) => (id === 'missing' ? undefined : session),
  })
  assert.equal(result.total, 230)
  assert.equal(result.hits.length, 200)
  assert.equal(result.missing, 1)
  assert.equal(result.scanned, 2)
})

test('opening hit persists full path, uses unsaved cache, blocks generation and rejects missing results', async () => {
  const session = resetStore()
  api.runtime.sessions.get(session.id).messages = []
  assert.equal(await api.openHistoryHit(session.id, 'hit'), 'ok')
  const state = api.useChatStore.getState()
  assert.equal(state.activeId, session.id)
  assert.equal(state.messageTarget.messageId, 'hit')
  assert.deepEqual(
    api.getVisibleMessages(state.sessionCache[session.id]).map((m) => m.id),
    ['u1', 'alternate', 'deep', 'hit', 'tail']
  )
  await new Promise((done) => setImmediate(done))
  assert.equal(
    api.runtime.sessions.get(session.id).messages.find((m) => m.id === 'u1').selectedChildId,
    'alternate'
  )
  api.useChatStore.setState({ streaming: { [session.id]: new AbortController() } })
  assert.equal(await api.openHistoryHit(session.id, 'hit'), 'busy')
  api.useChatStore.setState({ streaming: {} })
  assert.equal(await api.openHistoryHit(session.id, 'removed'), 'missing')
})

test('late result cannot override a new conversation, cancellation or history replacement', async () => {
  for (const operation of ['new', 'abort', 'replace']) {
    const session = resetStore(branch(), false)
    api.runtime.deferLoads = true
    const abort = new AbortController()
    const task = api.openHistoryHit(session.id, 'hit', abort.signal)
    await new Promise((done) => setImmediate(done))
    if (operation === 'new') api.newChat()
    else if (operation === 'abort') abort.abort()
    else await api.replaceHistory(async () => {})
    api.runtime.loads.shift().resolve(structuredClone(session))
    assert.equal(await task, 'cancelled')
    assert.equal(api.useChatStore.getState().activeId, null)
  }
  api.runtime.deferLoads = false
})

test('cold search recovers pending/streaming snapshots without writes, cache growth or mutation; real generation stays excluded', async () => {
  for (const status of ['pending', 'streaming']) {
    const session = branch()
    session.messages.find((message) => message.id === 'hit').status = status
    resetStore(session, false)
    const saves = api.runtime.saveAttempts.length
    const revision = api.useChatStore.getState().historySearchRevision
    const recovered = await api.loadSessionForSearch(session.id)
    assert.equal(recovered.messages.find((message) => message.id === 'hit').status, 'stopped')
    assert.equal(
      api.searchableMessageText(recovered.messages.find((message) => message.id === 'hit')),
      'needle in final answer'
    )
    assert.equal(
      api.runtime.sessions.get(session.id).messages.find((message) => message.id === 'hit').status,
      status
    )
    assert.equal(Object.keys(api.useChatStore.getState().sessionCache).length, 0)
    assert.equal(api.runtime.saveAttempts.length, saves)
    assert.equal(api.useChatStore.getState().historySearchRevision, revision)
    api.useChatStore.setState({ streaming: { [session.id]: new AbortController() } })
    const live = await api.loadSessionForSearch(session.id)
    assert.equal(live.messages.find((message) => message.id === 'hit').status, status)
    assert.equal(
      api.searchableMessageText(live.messages.find((message) => message.id === 'hit')),
      ''
    )
  }
})

test('ordinary recovery invalidates search once and reopening the recovered cache does not keep invalidating it', async () => {
  const session = branch()
  session.messages.find((message) => message.id === 'hit').status = 'streaming'
  resetStore(session, false)
  const revision = api.useChatStore.getState().historySearchRevision
  api.selectSession(session.id)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(api.useChatStore.getState().historySearchRevision, revision + 1)
  assert.equal(
    api.useChatStore
      .getState()
      .sessionCache[session.id].messages.find((message) => message.id === 'hit').status,
    'stopped'
  )
  api.selectSession(session.id)
  await api.loadSessionForSearch(session.id)
  assert.equal(api.useChatStore.getState().historySearchRevision, revision + 1)
})

test('target carries cancellation through location and a stale completion cannot consume a newer target', async () => {
  const session = resetStore()
  const abort = new AbortController()
  await api.openHistoryHit(session.id, 'hit', abort.signal)
  const previous = api.useChatStore.getState().messageTarget
  assert.equal(previous.signal, abort.signal)
  abort.abort()
  assert.equal(previous.signal.aborted, true)
  await api.openHistoryHit(session.id, 'deep')
  const next = api.useChatStore.getState().messageTarget
  api.clearMessageTarget(previous.token)
  assert.equal(api.useChatStore.getState().messageTarget, next)
  api.clearMessageTarget(next.token)
  assert.equal(api.useChatStore.getState().messageTarget, null)
})
