import assert from 'node:assert/strict'
import path from 'node:path'
import { before, after, beforeEach, test } from 'node:test'
import { root, compile } from './helpers/compile.mjs'
import { imageFile, installImageFixture } from './helpers/browser-images.mjs'

const keys = [
  'fetch',
  'localStorage',
  'document',
  'window',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]
const globals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
let api, images
const tick = () => new Promise((resolve) => setImmediate(resolve))
const waitFor = async (predicate) => {
  for (let i = 0; i < 100 && !predicate(); i++) await tick()
  assert.ok(predicate(), 'fixture operation must settle')
}
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
  window.clearTimeout = clearTimeout
  window.setTimeout = (callback, delay) => setTimeout(callback, delay).unref()
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  images = installImageFixture(document)
  const runtime = path.join(root, 'tests/helpers/runtime/chat.cjs')
  const replacements = new Map(
    ['src/services/chat/db.js', 'src/platform/secureStorage.js', 'src/i18n/index.js'].map(
      (name) => [path.join(root, name), runtime]
    )
  )
  api = await compile('./tests/helpers/entries/requests.ts', 'requests', replacements)
})
after(() => {
  images?.restore()
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})
beforeEach(() => {
  images.decoded.length = 0
  images.drawn.length = 0
  images.canvases.length = 0
  images.decodeGate = null
  images.failEncoding = false
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
  api.setDocBillingAcked(false)
  api.setDocParseMode('rich')
})

test('image upload keeps an in-limit original unchanged', async () => {
  const original = imageFile(4096, 2048)
  assert.equal(await api.resizeUploadImage(original), original)
  assert.equal(images.drawn.length, 0)
})

test('retry omission reports the document count from the filtered request and sends no HTTP when still over limit', () => {
  let http = 0
  globalThis.fetch = async () => {
    http++
    return Response.json({ id: 'unexpected' })
  }
  const files = Array.from({ length: 22 }, (_, i) => ({
    id: `doc-${i}`,
    serverId: i ? `server-${i}` : null,
    name: `${i}.txt`,
    size: 1,
    isImage: false,
    mimeType: 'text/plain',
    purpose: 'user_data',
  }))
  const question = {
    id: 'user',
    role: 'user',
    content: 'question',
    files,
    createdAt: 1,
    parentId: null,
    selectedChildId: 'reply',
  }
  const reply = {
    id: 'reply',
    role: 'assistant',
    model: 'deepseek-flash',
    status: 'error',
    prefix: false,
    blocks: [],
    createdAt: 2,
    parentId: 'user',
    error: { kind: 'contextMissing', message: '', fileIds: ['doc-0'] },
  }
  const session = {
    id: 'count',
    title: 'count',
    createdAt: 1,
    updatedAt: 2,
    rootMessageId: 'user',
    messages: [question, reply],
  }
  api.useChatStore.setState({
    sessions: [session],
    sessionCache: { count: session },
    activeId: 'count',
  })
  api.retryUpload('count', 'reply', { omitMissing: true })
  const updated = api.useChatStore.getState().sessionCache.count
  const error = updated.messages[1].error
  assert.equal(error.kind, 'docLimit')
  assert.equal(error.localMessage.params.count, 21)
  assert.equal(http, 0)
  assert.equal(
    updated.messages[0].files.length,
    22,
    'omission filters the request without deleting original metadata'
  )
})
for (const [width, height, expected] of [
  [8192, 4096, [4096, 2048]],
  [2048, 8192, [1024, 4096]],
  [1, 10000, [1, 4096]],
]) {
  test(`image upload scales ${width}x${height} and preserves the original`, async () => {
    const original = imageFile(width, height)
    const copy = await api.resizeUploadImage(original)
    assert.deepEqual(Object.values(JSON.parse(await copy.text())), expected)
    assert.deepEqual(JSON.parse(await original.text()), { width, height })
    assert.equal(copy.lastModified, original.lastModified)
    assert.deepEqual(
      images.canvases.map(({ width, height }) => [width, height]),
      [[0, 0]],
      'canvas pixels must be released'
    )
  })
}
test('the real Files API request uploads the scaled copy with its actual MIME and name', async () => {
  let form
  globalThis.fetch = async (_url, options) => {
    form = options.body
    return Response.json({ id: 'scaled-id' })
  }
  const original = imageFile(9000, 3000, 'animated.gif', 'image/gif')
  await api.uploadFile('fixture-only', original, null)
  const uploaded = form.get('file')
  assert.equal(uploaded.name, 'animated.png')
  assert.equal(uploaded.type, 'image/png')
  assert.deepEqual(JSON.parse(await uploaded.text()), { width: 4096, height: 1365 })
  assert.equal(form.has('purpose'), false)
  assert.equal(original.name, 'animated.gif')
})
test('documents bypass the image decoder and retain Files API purpose', async () => {
  let form
  globalThis.fetch = async (_url, options) => {
    form = options.body
    return Response.json({ id: 'document-id' })
  }
  await api.uploadFile('fixture-only', new File(['pdf'], 'fixture.pdf'), 'rich_layout_recognition')
  assert.equal(form.get('purpose'), 'rich_layout_recognition')
  assert.equal(await form.get('file').text(), 'pdf')
  assert.equal(images.decoded.length, 0)
})
test('cancelled or undecodable images never reach the HTTP boundary', async () => {
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    return Response.json({ id: 'unexpected' })
  }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    api.uploadFile('fixture-only', imageFile(9000, 3000), null, controller.signal),
    { name: 'AbortError' }
  )
  await assert.rejects(
    api.uploadFile('fixture-only', new File(['{"invalid":true}'], 'invalid.png'), null),
    /decode/
  )
  images.failEncoding = true
  await assert.rejects(api.uploadFile('fixture-only', imageFile(9000, 3000), null), /encode/)
  assert.equal(requests, 0)
})

const mountHistory = (id, original, extra = {}) => {
  const file = {
    id: `${id}-image`,
    serverId: 'oversized-old-id',
    name: 'fixture.png',
    size: original?.size ?? 0,
    isImage: true,
    mimeType: 'image/png',
    ...extra,
  }
  const session = {
    id,
    title: id,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    messages: [
      {
        id: `${id}-user`,
        role: 'user',
        content: 'Picture',
        files: [file],
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
        blocks: [{ type: 'text', text: 'Answer' }],
        createdAt: 1_700_000_000_001,
      },
    ],
  }
  api.runtime.sessions.set(id, structuredClone(session))
  if (original) api.runtime.files.set(file.id, original)
  api.useChatStore.setState({ sessions: [session], sessionCache: { [id]: session }, activeId: id })
  return { file, session }
}
const wireRequests = () => {
  const uploads = [],
    requests = []
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/files')) {
      uploads.push(options.body.get('file'))
      return Response.json({ id: 'scaled-new-id' })
    }
    requests.push(JSON.parse(options.body))
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  return { uploads, requests }
}
const imageIds = (request) =>
  request.messages.flatMap(({ content }) =>
    Array.isArray(content)
      ? content.filter(({ type }) => type === 'image').map(({ source }) => source.file_id)
      : []
  )
test('oversized legacy image is reuploaded once and its checked ID is reused', async () => {
  const original = imageFile(8192, 4096)
  const { file } = mountHistory('old-image', original)
  const { uploads, requests } = wireRequests()
  api.setDraftText('old-image', 'Next')
  assert.equal(api.sendMessage('old-image'), true)
  await waitFor(() => !api.useChatStore.getState().streaming['old-image'])
  assert.equal(uploads.length, 1)
  assert.deepEqual(JSON.parse(await uploads[0].text()), { width: 4096, height: 2048 })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, 'deepseek-flash')
  assert.deepEqual(imageIds(requests[0]), ['scaled-new-id'])
  const saved = api.useChatStore.getState().sessionCache['old-image'].messages[0].files[0]
  assert.equal(saved.imageSizeChecked, true)
  assert.equal(api.runtime.files.get(file.id), original)
  const inspected = images.decoded.length
  api.setDraftText('old-image', 'One more')
  api.sendMessage('old-image')
  await waitFor(() => !api.useChatStore.getState().streaming['old-image'])
  assert.equal(uploads.length, 1)
  assert.equal(requests.length, 2)
  assert.deepEqual(imageIds(requests[1]), ['scaled-new-id'])
  assert.equal(images.decoded.length, inspected, 'checked IDs do not decode or upload again')
  const { blob } = await api.exportFullBackup()
  const entries = new Map()
  for await (const entry of api.readArchive(new File([blob], 'backup.zip')))
    entries.set(entry.path, await api.readEntry(entry))
  assert.equal(
    await entries.get(`files/${file.id}`).text(),
    await original.text(),
    'backup contains the full original, not the upload copy'
  )
})
test('text-only Pro requests do not inspect, clear, or reupload excluded historical images', async () => {
  const { file } = mountHistory('text-only', imageFile(8192, 4096))
  const { uploads, requests } = wireRequests()
  api.setModel('deepseek-v4-pro')
  api.setDraftText('text-only', 'Text only')
  assert.equal(api.sendMessage('text-only', { dropHistoryImages: true }), true)
  await waitFor(() => !api.useChatStore.getState().streaming['text-only'])
  assert.equal(images.decoded.length, 0)
  assert.equal(uploads.length, 0)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, 'deepseek-v4-pro')
  assert.deepEqual(imageIds(requests[0]), [])
  assert.equal(
    api.useChatStore.getState().sessionCache['text-only'].messages[0].files[0].serverId,
    file.serverId
  )
})
test('legacy images without a readable original keep their existing server ID', async () => {
  const { file } = mountHistory('missing-image', null)
  const { uploads, requests } = wireRequests()
  api.setDraftText('missing-image', 'Next')
  api.sendMessage('missing-image')
  await waitFor(() => !api.useChatStore.getState().streaming['missing-image'])
  assert.equal(uploads.length, 0)
  assert.equal(requests.length, 1)
  assert.deepEqual(imageIds(requests[0]), [file.serverId])
})
test('stopping during legacy image inspection cannot later clear IDs or issue a request', async () => {
  mountHistory('stop-image', imageFile(8192, 4096))
  let finishDecode
  images.decodeGate = new Promise((resolve) => {
    finishDecode = resolve
  })
  const { uploads, requests } = wireRequests()
  api.setDraftText('stop-image', 'Next')
  api.sendMessage('stop-image')
  await waitFor(() => images.decoded.length === 1)
  api.stopReply('stop-image')
  await waitFor(() => !api.useChatStore.getState().streaming['stop-image'])
  finishDecode()
  await tick()
  assert.equal(uploads.length, 0)
  assert.equal(requests.length, 0)
  assert.equal(
    api.useChatStore.getState().sessionCache['stop-image'].messages[0].files[0].serverId,
    'oversized-old-id'
  )
})

test('reply citations and search/open-page links expose only HTTP(S) without changing stored blocks', () => {
  const urls = [
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///etc/passwd',
    'https://safe.invalid/page',
    'http://safe.invalid/page',
  ]
  const reply = {
    id: 'reply',
    blocks: [
      {
        type: 'server_tool_use',
        id: 'search',
        kind: 'search',
        input: { action: 'search', queries: ['fixture'] },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'search',
        content: urls.map((url) => ({
          type: 'web_search_result',
          url,
          title: url,
          page_age: null,
        })),
      },
      ...urls.map((url, index) => ({
        type: 'server_tool_use',
        id: `open-${index}`,
        kind: 'search',
        input: { action: 'open_page', url },
      })),
      {
        type: 'text',
        text: 'An answer',
        citations: urls.map((url) => ({ type: 'web_search_result_location', url, title: url })),
      },
    ],
  }
  const before = structuredClone(reply)
  const view = api.buildReplyView(reply, true)
  assert.deepEqual(
    view.sources.map(({ url }) => url),
    urls.slice(3)
  )
  assert.deepEqual(
    view.searchResults.map(({ url }) => url),
    urls.slice(3)
  )
  const pages = view.steps.filter(({ type }) => type === 'open').flatMap(({ pages }) => pages)
  assert.deepEqual(
    pages.map(({ url }) => url),
    [undefined, undefined, undefined, ...urls.slice(3)]
  )
  assert.equal((view.answer.markdown.match(/\[citation:/g) ?? []).length, 2)
  assert.deepEqual(reply, before)
})

const doc = (id, extra = {}) => ({
  id,
  serverId: `file-api-${id}`,
  name: `${id}.pdf`,
  size: 3,
  isImage: false,
  mimeType: 'application/pdf',
  purpose: 'text_recognition',
  ...extra,
})
const mountDocuments = (id, files) => {
  const { session } = mountHistory(id, null)
  session.messages[0].files = files
  api.runtime.sessions.set(id, structuredClone(session))
  api.useChatStore.setState({ sessionCache: { [id]: session } })
  return session
}
const lastReply = (id) => api.useChatStore.getState().sessionCache[id].messages.at(-1)
const settled = async (id) => waitFor(() => !api.useChatStore.getState().streaming[id])
const ask = async (id) => {
  api.setDraftText(id, 'Next question')
  assert.equal(api.sendMessage(id), true)
  await settled(id)
}
const documentIds = (request) =>
  request.messages.flatMap(({ content }) =>
    Array.isArray(content)
      ? content.filter(({ type }) => type === 'document').map(({ source }) => source.file_id)
      : []
  )

test('document counting includes repeated references and only usable context rounds', () => {
  const session = mountDocuments('count-docs', [doc('shared'), doc('shared')])
  const [user, reply] = session.messages
  const question = {
    ...user,
    id: 'new-question',
    files: [doc('shared'), { ...doc('image'), isImage: true }],
  }
  const failed = { ...reply, status: 'error' }
  const history = [user, reply, { ...user, id: 'failed-question' }, failed]
  assert.equal(api.countRequestDocuments(history, question), 3)
  assert.equal(api.countDocumentBlocks(api.toRequestMessages(history, question)), 3)
})

test('20 document references are sent, while 21 are blocked without consuming the draft', async () => {
  mountDocuments(
    'twenty',
    Array.from({ length: 20 }, () => doc('shared'))
  )
  const { uploads, requests } = wireRequests()
  await ask('twenty')
  assert.equal(documentIds(requests[0]).length, 20)
  mountDocuments(
    'twenty-one',
    Array.from({ length: 21 }, () => doc('shared'))
  )
  api.setDraftText('twenty-one', 'Preserve this draft')
  assert.equal(api.sendMessage('twenty-one'), false)
  assert.equal(api.getDraft('twenty-one').text, 'Preserve this draft')
  assert.equal(api.regenerateReply('twenty-one'), 'docLimit')
  assert.equal(api.editMessage('twenty-one', 'twenty-one-user', 'Changed'), 'docLimit')
  const session = api.useChatStore.getState().sessionCache['twenty-one']
  session.messages[1].stopReason = 'max_tokens'
  assert.equal(api.continueReply('twenty-one', 'twenty-one-reply'), 'docLimit')
  assert.equal(requests.length, 1)
  assert.equal(uploads.length, 0)
})

test('21 documents needing reupload are blocked before any paid upload', async () => {
  const files = Array.from({ length: 21 }, (_, i) => doc(`pending-${i}`, { serverId: null }))
  mountDocuments('pending-limit', files)
  files.forEach((file) => api.runtime.files.set(file.id, new Blob(['pdf'])))
  const { uploads, requests } = wireRequests()
  await ask('pending-limit')
  assert.equal(lastReply('pending-limit').error.kind, 'docLimit')
  assert.equal(uploads.length, 0)
  assert.equal(requests.length, 0)
})

test('missing originals pause the request; explicit omission preserves stored attachments', async () => {
  mountDocuments('missing-doc', [doc('gone', { serverId: null })])
  const { uploads, requests } = wireRequests()
  await ask('missing-doc')
  const reply = lastReply('missing-doc')
  assert.equal(reply.error.kind, 'contextMissing')
  assert.deepEqual(reply.error.fileIds, ['gone'])
  assert.equal(requests.length, 0)
  api.retryUpload('missing-doc', reply.id, { omitMissing: true })
  await settled('missing-doc')
  assert.equal(requests.length, 1)
  assert.equal(documentIds(requests[0]).length, 0)
  assert.equal(uploads.length, 0)
  assert.equal(
    api.useChatStore.getState().sessionCache['missing-doc'].messages[0].files[0].id,
    'gone'
  )
})

test('failed history uploads never silently drop from a sent chat, and retry reuses successes', async () => {
  mountDocuments('upload-failure', [
    doc('ok', { serverId: null, name: 'ok.txt', purpose: 'user_data' }),
    doc('bad', { serverId: null, name: 'bad.txt', purpose: 'user_data' }),
  ])
  for (const id of ['ok', 'bad']) api.runtime.files.set(id, new Blob([id]))
  const uploads = [],
    requests = []
  let fail = true
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/files')) {
      const name = options.body.get('file').name
      uploads.push(name)
      if (name === 'bad.txt' && fail) throw new TypeError('offline fixture')
      return Response.json({ id: `file-api-${name}` })
    }
    requests.push(JSON.parse(options.body))
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  }
  await ask('upload-failure')
  assert.equal(lastReply('upload-failure').error.kind, 'contextMissing')
  assert.equal(requests.length, 0)
  fail = false
  api.retryUpload('upload-failure', lastReply('upload-failure').id)
  await settled('upload-failure')
  assert.equal(requests.length, 1)
  assert.equal(uploads.filter((name) => name === 'ok.txt').length, 1)
  assert.equal(documentIds(requests[0]).length, 2)
})

test('restored paid documents require per-request consent, keep their purpose, and reuse successful IDs', async () => {
  mountDocuments('restored-doc', [doc('restored', { serverId: null })])
  api.runtime.files.set('restored', new Blob(['pdf']))
  api.setDocBillingAcked(true)
  const forms = [],
    requests = []
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/files')) {
      forms.push(options.body)
      return Response.json({ id: 'file-api-restored-new' })
    }
    requests.push(JSON.parse(options.body))
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  }
  await ask('restored-doc')
  const reply = lastReply('restored-doc')
  assert.equal(reply.error.kind, 'reparse')
  assert.equal(forms.length, 0)
  api.retryUpload('restored-doc', reply.id)
  assert.equal(forms.length, 0, 'generic retry does not authorize paid parsing')
  api.setDocParseMode('rich')
  api.retryUpload('restored-doc', reply.id, { reparse: true })
  await settled('restored-doc')
  assert.equal(forms.length, 1)
  assert.equal(forms[0].get('purpose'), 'text_recognition')
  assert.deepEqual([...forms[0].keys()], ['purpose', 'file'])
  assert.deepEqual(documentIds(requests[0]), ['file-api-restored-new'])
  await ask('restored-doc')
  assert.equal(forms.length, 1)
})

test('expired paid IDs do not automatically reparse; only the named document is reset on consent', async () => {
  mountDocuments('expired-doc', [doc('expired'), doc('keep'), doc('expired')])
  api.runtime.files.set('expired', new Blob(['pdf']))
  const forms = [],
    requests = []
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/files')) {
      forms.push(options.body)
      return Response.json({ id: 'file-api-renewed' })
    }
    requests.push(JSON.parse(options.body))
    if (requests.length === 1)
      return Response.json(
        { error: { message: 'file data not found for file_id file-api-expired' } },
        { status: 400 }
      )
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  }
  await ask('expired-doc')
  assert.equal(lastReply('expired-doc').error.kind, 'reparse')
  assert.deepEqual(lastReply('expired-doc').error.fileIds, ['expired'])
  assert.equal(requests.length, 1)
  assert.equal(forms.length, 0)
  api.retryUpload('expired-doc', lastReply('expired-doc').id, { reparse: true })
  await settled('expired-doc')
  assert.equal(forms.length, 1)
  assert.deepEqual(documentIds(requests[1]), [
    'file-api-renewed',
    'file-api-keep',
    'file-api-renewed',
  ])
})

test('omission survives a subsequent parse confirmation and does not loop back to missing files', async () => {
  mountDocuments('combined', [doc('missing', { serverId: null }), doc('paid', { serverId: null })])
  api.runtime.files.set('paid', new Blob(['pdf']))
  const { uploads, requests } = wireRequests()
  await ask('combined')
  assert.equal(lastReply('combined').error.kind, 'contextMissing')
  api.retryUpload('combined', lastReply('combined').id, { omitMissing: true })
  await settled('combined')
  assert.equal(lastReply('combined').error.kind, 'reparse')
  api.retryUpload('combined', lastReply('combined').id, { reparse: true })
  await settled('combined')
  assert.equal(uploads.length, 1)
  assert.equal(requests.length, 1)
  assert.equal(documentIds(requests[0]).length, 1)
})

test('stopping an authorized parse cannot send chat when the late upload finishes', async () => {
  mountDocuments('stop-parse', [doc('slow', { serverId: null })])
  api.runtime.files.set('slow', new Blob(['pdf']))
  let finishUpload
  const requests = []
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/files'))
      return new Promise((resolve) => {
        finishUpload = resolve
      })
    requests.push(JSON.parse(options.body))
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  }
  await ask('stop-parse')
  api.retryUpload('stop-parse', lastReply('stop-parse').id, { reparse: true })
  await waitFor(() => !!finishUpload)
  api.stopReply('stop-parse')
  await settled('stop-parse')
  finishUpload(Response.json({ id: 'file-api-late' }))
  await tick()
  await tick()
  assert.equal(requests.length, 0)
  assert.equal(lastReply('stop-parse').status, 'stopped')
  assert.equal(
    api.useChatStore.getState().sessionCache['stop-parse'].messages[0].files[0].serverId,
    'file-api-late'
  )
})

test('billing consent precedes draft upload and parse mode is fixed when the file is added', async () => {
  const file = new File(['pdf'], 'first.pdf', { type: 'application/pdf' })
  const forms = []
  globalThis.fetch = async (_url, options) => {
    forms.push(options.body)
    return Response.json({ id: 'file-api-new' })
  }
  assert.equal(api.addDraftFiles(null, [file], 'fixture-only').key, 'docBillingDescription')
  assert.equal(api.getDraft(null).attachments.length, 0)
  assert.equal(forms.length, 0)
  api.setDocBillingAcked(true)
  api.setDocParseMode('text')
  assert.equal(api.addDraftFiles(null, [file], 'fixture-only'), null)
  api.setDocParseMode('rich')
  await waitFor(() => forms.length === 1)
  assert.equal(forms[0].get('purpose'), 'text_recognition')
  assert.equal(api.getDraft(null).attachments[0].purpose, 'text_recognition')
})

test('upload limits distinguish 100 MiB documents, 64 MiB images and 32 MiB user data', () => {
  const sized = (name, size, type) => ({ name, size: size * 1024 * 1024, type })
  assert.equal(api.validateFiles([sized('a.pdf', 100, 'application/pdf')], 0), null)
  assert.equal(api.validateFiles([sized('a.pdf', 100.01, 'application/pdf')], 0).params.size, 100)
  assert.equal(api.validateFiles([sized('a.png', 64, 'image/png')], 0), null)
  assert.equal(api.validateFiles([sized('a.png', 64.01, 'image/png')], 0).params.size, 64)
  assert.equal(api.validateFiles([sized('a.txt', 32, 'text/plain')], 0), null)
  assert.equal(api.validateFiles([sized('a.txt', 32.01, 'text/plain')], 0).params.size, 32)
})

test('unselected branches are excluded from the document guard and outgoing request', async () => {
  const session = mountDocuments('doc-branch', [doc('selected')])
  session.rootMessageId = session.messages[0].id
  session.messages[0].parentId = null
  session.messages[0].selectedChildId = session.messages[1].id
  session.messages[1].parentId = session.messages[0].id
  session.messages.push(
    {
      ...session.messages[0],
      id: 'other-root',
      selectedChildId: 'other-reply',
      files: Array.from({ length: 21 }, () => doc('other')),
    },
    { ...session.messages[1], id: 'other-reply', parentId: 'other-root' }
  )
  api.useChatStore.setState({ sessionCache: { 'doc-branch': session } })
  const { requests } = wireRequests()
  assert.equal(api.countContextDocuments('doc-branch'), 1)
  await ask('doc-branch')
  assert.deepEqual(documentIds(requests[0]), ['file-api-selected'])
})

test('legacy document reuploads retain rich parsing and a text-only Pro retry keeps images excluded', async () => {
  mountDocuments('legacy-parse', [
    doc('old', { serverId: null, purpose: undefined }),
    { ...doc('picture'), isImage: true, name: 'picture.png', imageSizeChecked: true },
  ])
  api.runtime.files.set('old', new Blob(['pdf']))
  api.setDocParseMode('text')
  api.setModel('deepseek-v4-pro')
  const forms = [],
    requests = []
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/files')) {
      forms.push(options.body)
      return Response.json({ id: 'file-api-legacy-new' })
    }
    requests.push(JSON.parse(options.body))
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  }
  api.setDraftText('legacy-parse', 'Text only')
  api.sendMessage('legacy-parse', { dropHistoryImages: true })
  await settled('legacy-parse')
  assert.equal(lastReply('legacy-parse').error.kind, 'reparse')
  api.retryUpload('legacy-parse', lastReply('legacy-parse').id, { reparse: true })
  await settled('legacy-parse')
  assert.equal(forms[0].get('purpose'), 'rich_layout_recognition')
  assert.deepEqual(imageIds(requests[0]), [])
})

test('full backups round-trip document purposes and mode without transferring billing consent', async () => {
  const files = [
    doc('text'),
    doc('rich', { purpose: 'rich_layout_recognition' }),
    doc('plain', { name: 'plain.txt', purpose: 'user_data' }),
    doc('legacy', { purpose: undefined }),
  ]
  mountDocuments('purpose-backup', files)
  files.forEach((file) => api.runtime.files.set(file.id, new Blob([file.name])))
  api.setDocParseMode('text')
  api.setDocBillingAcked(true)
  const { blob } = await api.exportFullBackup()
  const entries = new Map()
  for await (const entry of api.readArchive(new File([blob], 'purposes.zip')))
    entries.set(entry.path, await api.readEntry(entry))
  const settings = JSON.parse(await entries.get('app_settings.json').text())
  assert.equal(settings.settings.doc_parse_mode, 'text')
  assert.ok(!JSON.stringify(settings).includes('billing'))
  api.setDocParseMode('rich')
  api.setDocBillingAcked(false)
  await api.importHistory(new File([blob], 'purposes.zip'))
  const restored = api.runtime.sessions.get('purpose-backup').messages[0].files
  assert.deepEqual(
    restored.map((file) => file.purpose),
    ['text_recognition', 'rich_layout_recognition', 'user_data', undefined]
  )
  assert.ok(restored.every((file) => file.serverId === null))
  assert.equal(api.useSettings.getState().docParseMode, 'text')
  assert.equal(api.useSettings.getState().docBillingAcked, false)
  // A pre-C4 archive has neither extension. It still imports and leaves the target mode alone.
  delete settings.settings.doc_parse_mode
  entries.set('app_settings.json', new Blob([JSON.stringify(settings)]))
  for (const [name, content] of entries) {
    if (!name.startsWith('chat_sessions/') || !name.endsWith('.json')) continue
    const session = JSON.parse(await content.text())
    for (const message of session.messages)
      for (const fragment of message.fragments)
        if (fragment.type === 'FILE')
          fragment.files.forEach((file) => {
            delete file.purpose
          })
    entries.set(name, new Blob([JSON.stringify(session)]))
  }
  api.setDocParseMode('rich')
  const old = await api.writeArchive([...entries].map(([name, blob]) => ({ name, blob })))
  await api.importHistory(new File([old], 'pre-c4.zip'))
  assert.equal(api.useSettings.getState().docParseMode, 'rich')
  assert.ok(
    api.runtime.sessions
      .get('purpose-backup')
      .messages[0].files.every((file) => file.purpose === undefined)
  )
})
