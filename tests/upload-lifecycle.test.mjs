import assert from 'node:assert/strict'
import path from 'node:path'
import { before, after, beforeEach, test } from 'node:test'
import { root, compile } from './helpers/compile.mjs'

const names = [
  'fetch',
  'localStorage',
  'document',
  'window',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]
const globals = new Map(
  names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
)
let api
const tick = () => new Promise((resolve) => setImmediate(resolve))
const waitFor = async (predicate) => {
  for (let i = 0; i < 100 && !predicate(); i++) await tick()
  assert.ok(predicate(), 'fixture operation must settle')
}
const drain = async () => {
  for (let i = 0; i < 10; i++) await tick()
}
const session = (id) => api.useChatStore.getState().sessionCache[id]
const reply = (id) => api.getVisibleMessages(session(id)).at(-1)
const settled = (id) => waitFor(() => !api.useChatStore.getState().streaming[id])
const done = () =>
  new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  })
const fileResult = (id) => Response.json({ id })

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
  window.clearTimeout = clearTimeout
  window.setTimeout = (callback, delay) => setTimeout(callback, delay).unref()
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  const runtime = path.join(root, 'tests/helpers/runtime/chat.cjs')
  api = await compile(
    './tests/helpers/entries/requests.ts',
    'upload-lifecycle',
    new Map(
      ['src/services/chat/db.js', 'src/platform/secureStorage.js', 'src/i18n/index.js'].map(
        (name) => [path.join(root, name), runtime]
      )
    )
  )
})
after(() => {
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})
beforeEach(() => {
  api.runtime.sessions.clear()
  api.runtime.files.clear()
  api.useUploads.setState({ tasks: {} })
  api.useDrafts.setState({ drafts: new Map() })
  api.useChatStore.setState({
    ready: true,
    importingHistory: false,
    sessions: [],
    sessionCache: {},
    streaming: {},
    sessionSaveErrors: {},
    activeId: null,
  })
  api.setApiKey('fixture-only')
  api.setModel('deepseek-flash')
})

const mount = (id, count = 1, serverId = null, sharedId) => {
  const files = Array.from({ length: count }, (_, index) => ({
    id: sharedId ?? `${id}-file-${index}`,
    serverId,
    name: `document-${index}.pdf`,
    size: 3,
    isImage: false,
    mimeType: 'application/pdf',
    purpose: 'text_recognition',
  }))
  files.forEach((file) => api.runtime.files.set(file.id, new Blob(['pdf'])))
  const value = {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    messages: [
      { id: `${id}-question`, role: 'user', content: 'Summarize', files, createdAt: 1 },
      {
        id: `${id}-original`,
        role: 'assistant',
        model: 'deepseek-flash',
        prefix: true,
        thinking: false,
        search: false,
        status: 'done',
        stopReason: 'end_turn',
        blocks: [{ type: 'text', text: 'Archived answer' }],
        createdAt: 2,
      },
    ],
  }
  api.runtime.sessions.set(id, structuredClone(value))
  api.useChatStore.setState((state) => ({
    sessions: [...state.sessions, value],
    sessionCache: { ...state.sessionCache, [id]: value },
    activeId: id,
  }))
  return files
}
const prompt = async (id) => {
  api.regenerateReply(id)
  await settled(id)
  assert.equal(reply(id).error?.kind, 'reparse')
  return reply(id).id
}
const authorize = async (id) => {
  const replyId = await prompt(id)
  api.retryUpload(id, replyId, { reparse: true })
  return replyId
}
// Keep three foreground uploads open to occupy the actual shared queue.
const blockers = () =>
  Array.from({ length: 3 }, (_, i) =>
    api.uploadAttachment(
      'fixture-only',
      `block-${i}`,
      new Blob(['text']),
      `block-${i}.txt`,
      'user_data'
    )
  )

test('stopping a six-document paid batch prevents its three queued uploads from starting', async () => {
  const id = 'queued-stop'
  mount(id, 6)
  const pending = [],
    uploads = []
  let chats = 0
  globalThis.fetch = async (url, options) => {
    if (!String(url).endsWith('/files')) {
      chats++
      return done()
    }
    uploads.push(options.body.get('file').name)
    return new Promise((resolve) => pending.push(resolve))
  }
  await authorize(id)
  await waitFor(() => pending.length === 3)
  await drain()
  api.stopReply(id)
  await settled(id)
  pending.slice(0, 2).forEach((resolve, i) => resolve(fileResult(`file-api-started-${i}`)))
  await waitFor(() => session(id).messages[0].files.filter((file) => file.serverId).length === 2)
  pending[2](fileResult('file-api-started-2'))
  await drain()
  assert.equal(uploads.length, 3)
  assert.equal(chats, 0)
  assert.equal(reply(id).status, 'stopped')
  assert.equal(session(id).messages[0].files.filter((file) => file.serverId).length, 3)
  assert.ok(
    session(id)
      .messages[0].files.slice(3)
      .every((file) => !api.hasPendingUpload(file.id))
  )
})

test('a single paid upload waiting behind unrelated uploads is cancelled on stop', async () => {
  const id = 'blocked-stop'
  const [file] = mount(id)
  const pending = [],
    uploads = []
  globalThis.fetch = async (_url, options) => {
    uploads.push(options.body.get('file').name)
    return new Promise((resolve) => pending.push(resolve))
  }
  const foreground = blockers()
  await waitFor(() => pending.length === 3)
  await authorize(id)
  await waitFor(() => api.hasPendingUpload(file.id))
  api.stopReply(id)
  await settled(id)
  pending.forEach((resolve, i) => resolve(fileResult(`file-api-block-${i}`)))
  await Promise.all(foreground)
  await drain()
  assert.equal(uploads.length, 3)
  assert.equal(api.hasPendingUpload(file.id), false)
})

test('stopping one consumer preserves a queued upload still needed by another session', async () => {
  mount('owner-a', 1, null, 'shared')
  mount('owner-b', 1, null, 'shared')
  const pending = [],
    uploads = [],
    chats = []
  globalThis.fetch = async (url, options) => {
    if (!String(url).endsWith('/files')) {
      chats.push(JSON.parse(options.body))
      return done()
    }
    uploads.push(options.body.get('file').name)
    return new Promise((resolve) => pending.push(resolve))
  }
  const foreground = blockers()
  await waitFor(() => pending.length === 3)
  await authorize('owner-a')
  await waitFor(() => api.hasPendingUpload('shared'))
  api.regenerateReply('owner-b')
  await drain()
  assert.equal(reply('owner-b').error, undefined)
  api.stopReply('owner-a')
  await settled('owner-a')
  pending.slice(0, 3).forEach((resolve, i) => resolve(fileResult(`file-api-block-${i}`)))
  await Promise.all(foreground)
  await waitFor(() => pending.length === 4)
  pending[3](fileResult('file-api-shared'))
  await settled('owner-b')
  await drain()
  assert.equal(uploads.length, 4)
  assert.equal(chats.length, 1)
  assert.equal(reply('owner-a').status, 'stopped')
  assert.equal(reply('owner-b').status, 'done')
  assert.equal(session('owner-a').messages[0].files[0].serverId, 'file-api-shared')
  assert.equal(session('owner-b').messages[0].files[0].serverId, 'file-api-shared')
})

test('a stopped upload is reused by continuation while its result is still pending', async () => {
  const id = 'late-success'
  mount(id)
  let finish,
    uploads = 0,
    chats = 0
  globalThis.fetch = async (url) => {
    if (!String(url).endsWith('/files')) {
      chats++
      return done()
    }
    uploads++
    return new Promise((resolve) => {
      finish = resolve
    })
  }
  const replyId = await authorize(id)
  await waitFor(() => !!finish)
  api.stopReply(id)
  await settled(id)
  api.continueReply(id, replyId)
  await drain()
  assert.equal(reply(id).error, undefined)
  assert.ok(api.useChatStore.getState().streaming[id])
  finish(fileResult('file-api-valid-late-result'))
  await settled(id)
  assert.equal(uploads, 1)
  assert.equal(chats, 1)
  assert.equal(session(id).messages[0].files[0].serverId, 'file-api-valid-late-result')
})

test('an older imported-file prompt preserves an ID acquired by a later branch', async () => {
  const id = 'old-import-prompt'
  mount(id)
  let finish,
    uploads = 0,
    chats = 0
  globalThis.fetch = async (url) => {
    if (!String(url).endsWith('/files')) {
      chats++
      return done()
    }
    uploads++
    return new Promise((resolve) => {
      finish = resolve
    })
  }
  const oldPromptId = await prompt(id)
  const newReplyId = await authorize(id)
  await waitFor(() => !!finish)
  api.stopReply(id)
  await settled(id)
  finish(fileResult('file-api-from-later-branch'))
  await waitFor(() => session(id).messages[0].files[0].serverId === 'file-api-from-later-branch')
  api.selectMessageVersion(id, oldPromptId)
  assert.equal(reply(id).id, oldPromptId)
  assert.notEqual(oldPromptId, newReplyId)
  api.retryUpload(id, oldPromptId, { reparse: true })
  await settled(id)
  assert.equal(uploads, 1)
  assert.equal(chats, 1)
  assert.equal(session(id).messages[0].files[0].serverId, 'file-api-from-later-branch')
})

test('an older expired-ID prompt preserves the repaired ID from another branch', async () => {
  const id = 'old-expired-prompt'
  mount(id, 1, 'file-api-expired')
  let uploads = 0,
    chats = 0
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/files')) {
      uploads++
      return fileResult('file-api-repaired')
    }
    chats++
    return options.body.includes('file-api-expired')
      ? Response.json(
          { error: { message: 'file data not found for file_id file-api-expired' } },
          { status: 400 }
        )
      : done()
  }
  const oldPromptId = await prompt(id)
  await authorize(id)
  await settled(id)
  assert.equal(uploads, 1)
  api.selectMessageVersion(id, oldPromptId)
  api.retryUpload(id, oldPromptId, { reparse: true })
  await settled(id)
  assert.equal(uploads, 1)
  assert.equal(chats, 4)
  assert.equal(session(id).messages[0].files[0].serverId, 'file-api-repaired')
})

test('a matching invalid ID is cleared even when its old success is still cached', async () => {
  const id = 'cached-expired'
  const [file] = mount(id, 1, 'file-api-expired')
  api.useUploads.setState({
    tasks: { [file.id]: { status: 'done', serverId: 'file-api-expired' } },
  })
  let uploads = 0
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/files')) {
      uploads++
      return fileResult('file-api-new')
    }
    return options.body.includes('file-api-expired')
      ? Response.json(
          { error: { message: 'file data not found for file_id file-api-expired' } },
          { status: 400 }
        )
      : done()
  }
  await authorize(id)
  await settled(id)
  assert.equal(uploads, 1)
  assert.equal(session(id).messages[0].files[0].serverId, 'file-api-new')
  assert.equal(reply(id).status, 'done')
})

test('callbacks from a cancelled queued task cannot remove a replacement with the same local ID', async () => {
  const pending = [],
    uploads = []
  globalThis.fetch = async (_url, options) => {
    uploads.push(options.body.get('file').name)
    return new Promise((resolve) => pending.push(resolve))
  }
  const foreground = blockers()
  await waitFor(() => pending.length === 3)
  const owner = new AbortController()
  const first = api
    .uploadAttachment(
      'fixture-only',
      'replacement',
      new Blob(['pdf']),
      'old.pdf',
      'text_recognition',
      owner.signal
    )
    .catch((error) => error)
  owner.abort()
  const second = api.uploadAttachment(
    'fixture-only',
    'replacement',
    new Blob(['pdf']),
    'new.pdf',
    'text_recognition'
  )
  await first
  assert.equal(api.hasPendingUpload('replacement'), true)
  assert.equal(api.useUploads.getState().tasks.replacement.status, 'uploading')
  pending.slice(0, 3).forEach((resolve, i) => resolve(fileResult(`file-api-block-${i}`)))
  await Promise.all(foreground)
  await waitFor(() => pending.length === 4)
  assert.deepEqual(uploads.slice(3), ['new.pdf'])
  pending[3](fileResult('file-api-replacement'))
  assert.equal(await second, 'file-api-replacement')
  assert.equal(api.useUploads.getState().tasks.replacement.serverId, 'file-api-replacement')
})

test('failure of a reused paid upload does not authorize a fresh automatic parse', async () => {
  const id = 'pending-failure'
  mount(id)
  let finish,
    uploads = 0
  globalThis.fetch = async (url) => {
    assert.ok(String(url).endsWith('/files'), 'no chat with a failed attachment')
    uploads++
    return new Promise((resolve) => {
      finish = resolve
    })
  }
  const replyId = await authorize(id)
  await waitFor(() => !!finish)
  api.stopReply(id)
  await settled(id)
  api.continueReply(id, replyId)
  await drain()
  finish(Response.json({ error: { message: 'fixture failure' } }, { status: 503 }))
  await settled(id)
  assert.equal(reply(id).error.kind, 'upload')
  api.retryUpload(id, replyId)
  await settled(id)
  assert.equal(reply(id).error.kind, 'reparse')
  assert.equal(uploads, 1)
})

test('a queued foreground upload remains owned after a generation waiting on it stops', async () => {
  const id = 'foreground-owner'
  const [file] = mount(id)
  const pending = [],
    uploads = []
  globalThis.fetch = async (_url, options) => {
    uploads.push(options.body.get('file').name)
    return new Promise((resolve) => pending.push(resolve))
  }
  const foreground = blockers()
  await waitFor(() => pending.length === 3)
  const shared = api.uploadAttachment(
    'fixture-only',
    file.id,
    new Blob(['pdf']),
    file.name,
    file.purpose
  )
  api.regenerateReply(id)
  await drain()
  api.stopReply(id)
  await settled(id)
  pending.slice(0, 3).forEach((resolve, i) => resolve(fileResult(`file-api-block-${i}`)))
  await Promise.all(foreground)
  await waitFor(() => pending.length === 4)
  pending[3](fileResult('file-api-foreground-result'))
  assert.equal(await shared, 'file-api-foreground-result')
  await drain()
  assert.equal(uploads.length, 4)
  assert.equal(reply(id).status, 'stopped')
  assert.equal(session(id).messages[0].files[0].serverId, 'file-api-foreground-result')
})

test('a pre-fix prompt without an ID snapshot preserves a currently usable file ID', async () => {
  const id = 'legacy-prompt'
  const [file] = mount(id, 1, 'file-api-valid')
  const value = session(id)
  value.messages[1] = {
    ...value.messages[1],
    status: 'error',
    blocks: [],
    error: { kind: 'reparse', message: 'Older prompt', fileIds: [file.id] },
  }
  let chats = 0
  globalThis.fetch = async (url, options) => {
    assert.ok(
      !String(url).endsWith('/files'),
      'an unversioned prompt must not discard an existing ID'
    )
    assert.ok(options.body.includes('file-api-valid'))
    chats++
    return done()
  }
  api.retryUpload(id, value.messages[1].id, { reparse: true })
  await settled(id)
  assert.equal(chats, 1)
  assert.equal(session(id).messages[0].files[0].serverId, 'file-api-valid')
})
