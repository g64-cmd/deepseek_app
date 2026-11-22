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
})

test('image upload keeps an in-limit original unchanged', async () => {
  const original = imageFile(4096, 2048)
  assert.equal(await api.resizeUploadImage(original), original)
  assert.equal(images.drawn.length, 0)
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
