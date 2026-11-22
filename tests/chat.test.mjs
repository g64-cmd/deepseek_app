import assert from 'node:assert/strict'
import { compile, root } from './helpers/compile.mjs'
import path from 'node:path'
import { before, after, test } from 'node:test'

const runtimePath = path.join(root, 'tests/helpers/runtime/chat.cjs')
const mockedModules = new Set(
  ['src/services/chat/db.js', 'src/platform/secureStorage.js', 'src/i18n/index.js'].map((name) =>
    path.join(root, name)
  )
)
const keys = [
  'fetch',
  'localStorage',
  'document',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'window',
]
const originalGlobals = new Map(
  keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
)
let api

before(async () => {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, String(value))
    },
    removeItem: (key) => {
      storage.delete(key)
    },
    clear: () => storage.clear(),
  }
  globalThis.document = new EventTarget()
  globalThis.document.visibilityState = 'hidden'
  globalThis.window = new EventTarget()
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  api = await compile(
    './tests/helpers/entries/chat.ts',
    'chat',
    new Map([...mockedModules].map((name) => [name, runtimePath]))
  )
})

after(() => {
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

const image = {
  id: 'shared-image',
  serverId: 'file-existing',
  name: 'image.png',
  size: 3,
  isImage: true,
  mimeType: 'image/png',
}
const session = (id) => ({
  id,
  title: id,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  messages: [
    {
      id: `${id}-user`,
      role: 'user',
      content: 'Describe this picture',
      files: [image],
      createdAt: 1_700_000_000_000,
    },
    {
      id: `${id}-reply`,
      role: 'assistant',
      model: 'deepseek-flash',
      thinking: false,
      search: false,
      prefix: true,
      status: 'done',
      stopReason: 'end_turn',
      blocks: [{ type: 'text', text: 'A picture.' }],
      createdAt: 1_700_000_000_001,
    },
  ],
})

test('full backup supports an attachment shared by two valid sessions', async () => {
  api.runtime.files.set(image.id, new Blob(['png'], { type: 'image/png' }))
  const sessions = [session('first'), session('second')]
  // Control: both sessions independently export, and the existing compatibility format supports the shared ID.
  assert.ok((await api.exportArchive([sessions[0]], { full: true })).size > 0)
  assert.ok((await api.exportArchive(sessions)).size > 0)
  const archive = await api.exportArchive(sessions, { full: true })
  assert.ok(archive.size > 0)
})

test('a balance response from a replaced API key cannot refill the new account cache', async () => {
  api.setApiKey('fixture-account-A')
  let resolveFetch
  globalThis.fetch = () =>
    new Promise((resolve) => {
      resolveFetch = resolve
    })
  const refresh = api.refreshBalance()
  api.setApiKey('fixture-account-B')
  assert.equal(api.useBalance.getState().data, null, 'changing keys clears the old cache initially')
  resolveFetch(
    Response.json({
      is_available: true,
      balance_infos: [
        {
          currency: 'CNY',
          total_balance: '123.00',
          granted_balance: '0.00',
          topped_up_balance: '123.00',
        },
      ],
    })
  )
  await refresh
  assert.equal(
    api.useBalance.getState().data,
    null,
    'account A response must be discarded after switching to account B'
  )
})

test('usage cached during generation is recomputed after the same reply completes', async () => {
  localStorage.clear()
  api.runtime.sessions.clear()
  const empty = {
    id: 'usage-session',
    title: 'usage-session',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    messages: [],
  }
  api.useChatStore.setState({
    ready: true,
    importingHistory: false,
    sessions: [empty],
    sessionCache: { [empty.id]: empty },
    streaming: {},
    activeId: empty.id,
  })
  api.setModel('deepseek-flash')
  api.setDraftText(empty.id, 'A harmless usage fixture')
  let streamController
  let requested = false
  globalThis.fetch = async () => {
    requested = true
    return new Response(
      new ReadableStream({
        start(controller) {
          streamController = controller
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  }
  assert.equal(api.sendMessage(empty.id), true)
  for (let i = 0; i < 100 && !requested; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requested, true)
  const during = await api.getUsageSummary()
  assert.equal(during.replies, 0)
  const timestamp = api.runtime.sessions.get(empty.id).updatedAt
  const usage = {
    input_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 10,
  }
  const events = [
    { type: 'message_start', message: { usage } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: 'A harmless answer.' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
    { type: 'message_stop' },
  ]
  streamController.enqueue(
    new TextEncoder().encode(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
    )
  )
  streamController.close()
  for (let i = 0; i < 100 && api.useChatStore.getState().streaming[empty.id]; i++)
    await new Promise((resolve) => setImmediate(resolve))
  const saved = api.runtime.sessions.get(empty.id)
  assert.equal(
    saved.messages.at(-1).usage.output_tokens,
    10,
    'completed usage must already be persisted'
  )
  assert.equal(
    saved.updatedAt,
    timestamp,
    'normal production completion retains the summary timestamp'
  )
  const completed = await api.getUsageSummary()
  localStorage.removeItem('chat-demo:usage-summary')
  const uncached = await api.getUsageSummary()
  assert.equal(
    uncached.models['deepseek-flash']?.output,
    10,
    'control: scanning the same persisted data without the stale cache is correct'
  )
  assert.equal(
    completed.models['deepseek-flash']?.output,
    10,
    'reopening the account panel must include the completed response'
  )
})

for (const recovery of ['visibilitychange', 'rename']) {
  test(`usage is invalidated when failed final save is recovered through ${recovery}`, async () => {
    localStorage.clear()
    api.runtime.sessions.clear()
    const id = `recover-${recovery}`
    const empty = {
      id,
      title: id,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      messages: [],
    }
    api.useChatStore.setState({
      ready: true,
      importingHistory: false,
      sessions: [empty],
      sessionCache: { [id]: empty },
      streaming: {},
      activeId: id,
      sessionSaveErrors: {},
    })
    api.setModel('deepseek-flash')
    api.setDraftText(id, 'A harmless persistence recovery fixture')
    const usage = {
      input_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 10,
    }
    const events = [
      { type: 'message_start', message: { usage } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'A harmless answer.' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
      { type: 'message_stop' },
    ]
    globalThis.fetch = async () =>
      new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    api.runtime.rejectCompletedSave = true
    assert.equal(api.sendMessage(id), true)
    for (let i = 0; i < 100 && !api.useChatStore.getState().sessionSaveErrors[id]; i++)
      await new Promise((resolve) => setImmediate(resolve))
    assert.equal(api.useChatStore.getState().sessionSaveErrors[id], true)
    assert.equal(
      api.useChatStore.getState().sessionCache[id].messages.at(-1).usage.output_tokens,
      10
    )
    const pending = await api.getUsageSummary()
    assert.equal(
      pending.replies,
      0,
      'the failed transaction leaves old data for the account panel to cache'
    )
    const revisionBefore = localStorage.getItem('chat-demo:usage-revision')
    api.runtime.rejectCompletedSave = false
    if (recovery === 'visibilitychange') {
      const cleanup = api.bindChatPersistence()
      try {
        document.visibilityState = 'hidden'
        document.dispatchEvent(new Event('visibilitychange'))
      } finally {
        cleanup()
      }
    } else {
      assert.equal(await api.renameSession(id, 'Recovered title'), true)
    }
    for (let i = 0; i < 100 && api.useChatStore.getState().sessionSaveErrors[id]; i++)
      await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      api.useChatStore.getState().sessionSaveErrors[id],
      undefined,
      'recovery clears the production save error'
    )
    assert.equal(
      api.runtime.sessions.get(id).messages.at(-1).usage.output_tokens,
      10,
      'recovery commits the completed usage'
    )
    const cached = await api.getUsageSummary()
    localStorage.removeItem('chat-demo:usage-summary')
    const uncached = await api.getUsageSummary()
    assert.equal(
      uncached.models['deepseek-flash']?.output,
      10,
      'control: reading committed data without cache is correct'
    )
    assert.equal(
      cached.models['deepseek-flash']?.output,
      10,
      `recovery=${recovery}, revision=${revisionBefore}->${localStorage.getItem('chat-demo:usage-revision')}`
    )
  })
}

test('an earlier pending commit does not prevent final usage invalidation after retry', async () => {
  localStorage.clear()
  api.runtime.sessions.clear()
  const id = 'ordered-save-race'
  const empty = {
    id,
    title: id,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    messages: [],
  }
  api.useChatStore.setState({
    ready: true,
    importingHistory: false,
    sessions: [empty],
    sessionCache: { [id]: empty },
    streaming: {},
    activeId: id,
    sessionSaveErrors: {},
  })
  api.setModel('deepseek-flash')
  api.setDraftText(id, 'A harmless ordered storage fixture')
  const usage = {
    input_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 10,
  }
  const events = [
    { type: 'message_start', message: { usage } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: 'A harmless answer.' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
    { type: 'message_stop' },
  ]
  globalThis.fetch = async () =>
    new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  api.runtime.deferSaves = true
  api.runtime.rejectCompletedSave = true
  assert.equal(api.sendMessage(id), true)
  for (let i = 0; i < 100 && api.useChatStore.getState().streaming[id]; i++)
    await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    api.useChatStore.getState().streaming[id],
    undefined,
    'the controlled SSE has finished before earlier storage commits return'
  )
  assert.ok(api.runtime.saves.length >= 2, 'pending and final snapshots are both queued')
  assert.equal(
    api.runtime.saves[0].snapshot.messages.at(-1).usage,
    undefined,
    'the earliest transaction cannot contain final usage'
  )
  assert.equal(
    api.runtime.saves.at(-1).snapshot.messages.at(-1).usage.output_tokens,
    10,
    'the final transaction contains usage'
  )
  // Preserve transaction order: older pending snapshots commit first, and only the final completed write fails.
  while (api.runtime.saves.length > 0) await api.runtime.commitNextSave()
  assert.equal(api.useChatStore.getState().sessionSaveErrors[id], true)
  assert.equal(
    api.runtime.sessions.get(id).messages.at(-1).usage,
    undefined,
    'the failed final transaction leaves only the old committed snapshot'
  )
  assert.equal(
    api.useChatStore.getState().sessionCache[id].messages.at(-1).usage.output_tokens,
    10,
    'the final answer remains available for retry'
  )
  const stale = await api.getUsageSummary()
  assert.equal(stale.replies, 0)
  const revisionBefore = localStorage.getItem('chat-demo:usage-revision')
  api.runtime.deferSaves = false
  api.runtime.rejectCompletedSave = false
  api.retrySaveSessions()
  for (let i = 0; i < 100 && api.useChatStore.getState().sessionSaveErrors[id]; i++)
    await new Promise((resolve) => setImmediate(resolve))
  assert.equal(api.useChatStore.getState().sessionSaveErrors[id], undefined, 'retry succeeds')
  assert.equal(
    api.runtime.sessions.get(id).messages.at(-1).usage.output_tokens,
    10,
    'the final usage is now committed'
  )
  const cached = await api.getUsageSummary()
  localStorage.removeItem('chat-demo:usage-summary')
  const uncached = await api.getUsageSummary()
  assert.equal(
    uncached.models['deepseek-flash']?.output,
    10,
    'control: fresh aggregation reads the committed final usage'
  )
  assert.equal(
    cached.models['deepseek-flash']?.output,
    10,
    `old commit must not acknowledge final usage: revision=${revisionBefore}->${localStorage.getItem('chat-demo:usage-revision')}`
  )
})

const resetEmpty = () => {
  api.runtime.rejectAllSaves = false
  api.runtime.rejectCompletedSave = false
  api.runtime.deferSaves = false
  api.runtime.sessions.clear()
  api.runtime.files.clear()
  api.useChatStore.setState({
    ready: true,
    importingHistory: false,
    sessions: [],
    sessionCache: {},
    streaming: {},
    activeId: null,
    sessionSaveErrors: {},
  })
  api.useDrafts.setState({ drafts: new Map() })
  localStorage.clear()
}
const unzip = async (blob) => {
  const contents = new Map()
  for await (const entry of api.readArchive(new File([blob], 'fixture.zip')))
    contents.set(entry.path, await api.readEntry(entry))
  return contents
}

test('full backup includes live draft text before its debounce timer has persisted it', async () => {
  resetEmpty()
  api.setDraftText(null, 'Latest unsent draft')
  const { blob } = await api.exportFullBackup()
  const entries = await unzip(blob)
  const payload = JSON.parse(await entries.get('app_settings.json').text())
  assert.equal(
    api.getDraft(null).text,
    'Latest unsent draft',
    'control: the draft is in the live store'
  )
  assert.equal(
    payload.drafts.null,
    'Latest unsent draft',
    'explicit backup must capture the current draft, even within 400ms of typing'
  )
})

test('backup includes live drafts when localStorage cannot be written', async () => {
  resetEmpty()
  const setItem = localStorage.setItem
  localStorage.setItem = () => {
    throw new DOMException('Fixture quota', 'QuotaExceededError')
  }
  try {
    api.setDraftText(null, 'Draft while storage is unavailable')
    const { blob } = await api.exportFullBackup()
    const entries = await unzip(blob)
    const payload = JSON.parse(await entries.get('app_settings.json').text())
    assert.equal(payload.drafts.null, 'Draft while storage is unavailable')
  } finally {
    localStorage.setItem = setItem
  }
})

test('restored drafts can be backed up immediately and replace pending persisted text', async () => {
  resetEmpty()
  api.setDraftText(null, 'Old draft with a pending debounce')
  api.restoreDraftTexts({ null: 'Restored draft', existing: 'Another draft' })
  assert.deepEqual(JSON.parse(localStorage.getItem('chat-demo:draft-texts')), {
    null: 'Restored draft',
    existing: 'Another draft',
  })
  const { blob } = await api.exportFullBackup()
  const entries = await unzip(blob)
  assert.deepEqual(JSON.parse(await entries.get('app_settings.json').text()).drafts, {
    null: 'Restored draft',
    existing: 'Another draft',
  })
})

test('full backup restores an explicitly unset location', async () => {
  resetEmpty()
  api.setLocation(null)
  const { blob } = await api.exportFullBackup()
  const entries = await unzip(blob)
  assert.equal(JSON.parse(await entries.get('app_settings.json').text()).settings.location, null)
  api.setLocation({ region: 'US' })
  assert.deepEqual(api.useSettings.getState().location, { region: 'US' })
  const result = await api.importHistory(new File([blob], 'unset-location.zip'))
  assert.equal(result.restoredSettings, true)
  assert.equal(
    api.useSettings.getState().location,
    null,
    'restoring a valid null must clear the target device location'
  )
})

test('invalid nonnull location preserves the target setting and backups omit credentials', async () => {
  resetEmpty()
  api.setApiKey('fixture-secret-must-not-export')
  api.setDraftText(null, 'Restored text')
  const { blob } = await api.exportFullBackup()
  const entries = await unzip(blob)
  const settings = JSON.parse(await entries.get('app_settings.json').text())
  assert.ok(!JSON.stringify(settings).includes('fixture-secret'))
  assert.ok(!Object.hasOwn(settings.settings, 'apiKey'))
  settings.settings.location = { region: 'INVALID-REGION' }
  entries.set('app_settings.json', new Blob([JSON.stringify(settings)]))
  const modified = await api.writeArchive([...entries].map(([name, blob]) => ({ name, blob })))
  api.setLocation({ region: 'US' })
  api.setDraftText(null, 'Target old draft')
  await api.importHistory(new File([modified], 'invalid-location.zip'))
  assert.deepEqual(api.useSettings.getState().location, { region: 'US' })
  assert.equal(
    api.getDraft(null).text,
    'Restored text',
    'a single invalid setting does not discard other restored state'
  )
  assert.equal(api.useSettings.getState().apiKey, 'fixture-secret-must-not-export')
})

test('full backup preserves originals retained in memory after all storage writes fail', async () => {
  resetEmpty()
  const id = 'pending-original'
  const empty = {
    id,
    title: id,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    messages: [],
  }
  api.useChatStore.setState({ sessions: [empty], sessionCache: { [id]: empty }, activeId: id })
  api.setApiKey('fixture-only')
  api.setModel('deepseek-flash')
  globalThis.fetch = async (url) =>
    String(url).endsWith('/files')
      ? Response.json({ id: 'file-synthetic', filename: 'fixture.pdf' })
      : new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        })
  const file = new File(['synthetic-pdf-original'], 'fixture.pdf', { type: 'application/pdf' })
  assert.equal(api.addDraftFiles(id, [file], 'fixture-only'), null)
  const localId = api.getDraft(id).attachments[0].id
  for (let i = 0; i < 100 && api.useUploads.getState().tasks[localId]?.status !== 'done'; i++)
    await new Promise((resolve) => setImmediate(resolve))
  assert.equal(api.useUploads.getState().tasks[localId]?.status, 'done')
  api.runtime.rejectAllSaves = true
  try {
    assert.equal(api.sendMessage(id), true)
    for (
      let i = 0;
      i < 100 &&
      (api.useChatStore.getState().streaming[id] ||
        !api.useChatStore.getState().sessionSaveErrors[id]);
      i++
    )
      await new Promise((resolve) => setImmediate(resolve))
    assert.equal(api.useChatStore.getState().sessionSaveErrors[id], true)
    assert.equal(api.runtime.files.has(localId), false, 'no transaction saved the original')
    const attempt = api.runtime.saveAttempts.find((item) =>
      item.originals.some((original) => original.id === localId)
    )
    assert.ok(attempt, 'the real store did retain the original for its failed save attempts')
    assert.equal(
      await attempt.originals.find((original) => original.id === localId).blob.text(),
      'synthetic-pdf-original'
    )
    const { blob } = await api.exportFullBackup()
    const entries = await unzip(blob)
    const session = JSON.parse(await entries.get(`chat_sessions/${id}.json`).text())
    assert.equal(
      session.messages[0].fragments.find((fragment) => fragment.type === 'FILE').files[0].id,
      localId
    )
    assert.ok(
      entries.has(`files/${localId}`),
      'full backup must include the original retained by the failed-save recovery path'
    )
  } finally {
    api.runtime.rejectAllSaves = false
    api.retrySaveSessions()
    await new Promise((resolve) => setImmediate(resolve))
  }
})

test('unknown model keys survive import and cached aggregation without changing Object.prototype', async () => {
  resetEmpty()
  const models = ['__proto__', 'constructor', 'toString', 'deepseek-future']
  const incoming = models.map((model, index) => {
    const item = session(`unknown-model-${index}`)
    item.messages[1].model = model
    item.messages[1].usage = {
      input_tokens: 20,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
      output_tokens: 10,
    }
    return item
  })
  const original = new Map(
    ['input', 'cacheRead', 'output', 'replies'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(Object.prototype, key),
    ])
  )
  try {
    const blob = await api.exportArchive(incoming, { full: true })
    const restored = await api.importHistory(new File([blob], 'models.zip'))
    assert.equal(restored.count, models.length)
    const fresh = await api.getUsageSummary()
    const cached = await api.getUsageSummary()
    for (const summary of [fresh, cached]) {
      assert.equal(Object.getPrototypeOf(summary.models), null)
      assert.equal(summary.replies, models.length)
      for (const model of models) {
        assert.equal(Object.hasOwn(summary.models, model), true)
        assert.deepEqual(summary.models[model], { input: 21, cacheRead: 2, output: 10, replies: 1 })
      }
      assert.deepEqual(api.estimateCostRange(summary), { min: 0, max: 0 })
    }
    for (const [key, descriptor] of original) {
      assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, key), descriptor)
    }
  } finally {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor)
      else delete Object.prototype[key]
    }
  }
})
