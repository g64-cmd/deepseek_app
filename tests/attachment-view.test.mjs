import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { root, compile } from './helpers/compile.mjs'
import dom from './helpers/dom.cjs'

let api, runtime
const created = new Map(),
  revoked = []
const listeners = new Map()
const keys = ['FileReader', 'document', 'HTMLElement']
const originals = new Map(
  keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
)
const createObjectURL = URL.createObjectURL
const revokeObjectURL = URL.revokeObjectURL
const flush = () => new Promise((resolve) => setImmediate(resolve))
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of [node.props?.children].flat(Infinity)) {
    const match = find(child, predicate)
    if (match) return match
  }
  return null
}
const file = (name, text = 'Original bytes', type = 'text/html') => new File([text], name, { type })
const attachment = (name, values = {}) => ({
  id: 'file-id',
  name,
  size: 14,
  serverId: 'server-id',
  isImage: false,
  mimeType: 'text/html',
  ...values,
})
before(async () => {
  globalThis.HTMLElement = dom.TestHTMLElement
  globalThis.document = {
    body: new dom.TestHTMLElement(),
    querySelector: () => null,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(handler)
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler)
    },
  }
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`
        this.onload?.()
      })
    }
  }
  URL.createObjectURL = (blob) => {
    const url = `blob:attachment-${created.size}`
    created.set(url, blob)
    return url
  }
  URL.revokeObjectURL = (url) => revoked.push(url)
  const runtimePath = path.join(root, 'tests/helpers/runtime/attachment-view.cjs')
  const replacements = new Map(
    ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom'].map((name) => [
      name,
      runtimePath,
    ])
  )
  for (const name of [
    'src/i18n/index.js',
    'src/services/chat/db.js',
    'src/platform/index.js',
    'src/components/base/icons.js',
    'src/components/base/Tooltip.js',
    'src/components/base/Button.js',
    'src/components/base/IconButton.js',
    'src/components/base/toastState.js',
  ])
    replacements.set(path.join(root, name), runtimePath)
  api = await compile('./tests/helpers/entries/attachment-view.ts', 'attachment-view', replacements)
  runtime = api.fixture
  // A wrapper keeps the tested hook's actual positional arguments intact.
  api.view = ({ source, name }) => api.useFileView(source, name)
})
beforeEach(() => {
  api.hooks.cleanup()
  runtime.files.clear()
  runtime.shares.length = runtime.toasts.length = 0
  runtime.failShare = false
  api.platform.kind = 'web'
})
after(() => {
  api?.hooks.cleanup()
  URL.createObjectURL = createObjectURL
  URL.revokeObjectURL = revokeObjectURL
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

const renderView = (source, name = source.name) => api.hooks.render(api.view, { source, name })
const loadedView = async (source, name = source.name) => {
  renderView(source, name)
  await flush()
  return renderView(source, name)
}

test('PDF preview uses an explicit MIME, preserves original bytes and revokes its URL', async () => {
  const original = file('report.PDF')
  const result = await loadedView(original)
  assert.equal(result.image, false)
  assert.equal(created.get(result.url).type, 'application/pdf')
  assert.equal(await created.get(result.url).text(), await original.text())
  assert.equal(result.blob, original)
  assert.equal(result.link.target, '_blank')
  api.hooks.cleanup()
  await flush()
  assert.ok(revoked.includes(result.url))
})

test('unknown extensions download as octet-stream even when the Blob claims to be an image', async () => {
  const result = await loadedView(file('notes.unknown', 'data', 'image/png'))
  assert.equal(result.image, false)
  assert.equal(created.get(result.url).type, 'application/octet-stream')
  assert.equal(result.link.download, 'notes.unknown')
  assert.equal(result.link.target, undefined)
})

test('SVG thumbnail uses an isolated data URL and a download action', async () => {
  const result = await loadedView(file('drawing.svg', '<svg/>', 'text/html'))
  assert.equal(result.image, true)
  assert.ok(result.url.startsWith('data:image/svg+xml;base64,'))
  assert.equal(result.link.download, 'drawing.svg')
  assert.equal(result.link.target, undefined)
})

test('a source change discards a late old load instead of replacing the current preview', async () => {
  let resolveOld
  runtime.files.set(
    'old',
    new Promise((resolve) => {
      resolveOld = resolve
    })
  )
  runtime.files.set('new', file('new.png', 'new bytes'))
  renderView('old', 'old.png')
  renderView('new', 'new.png')
  await flush()
  const current = renderView('new', 'new.png')
  resolveOld(file('old.png', 'old bytes'))
  await flush()
  const afterOld = renderView('new', 'new.png')
  assert.equal(afterOld.url, current.url)
  assert.equal(await created.get(afterOld.url).text(), 'new bytes')
})

test('failed original reads settle as missing without an actionable URL', async () => {
  runtime.files.set('missing', new Error('Fixture IndexedDB read error'))
  const result = await loadedView('missing', 'missing.pdf')
  assert.equal(result.url, null)
  assert.equal(result.blob, null)
  assert.equal(result.link, undefined)
  assert.equal(result.onOpen, undefined)
})

test('raster messages retain the in-app viewer and use extension-based preview types', async () => {
  const meta = attachment('image.png')
  runtime.files.set(meta.id, file(meta.name))
  api.hooks.render(api.MessageFile, { file: meta, onRetry: null })
  await flush()
  let tree = api.hooks.render(api.MessageFile, { file: meta, onRetry: null })
  const preview = find(tree, (node) => node.type === 'img')
  assert.equal(created.get(preview.props.src).type, 'image/png')
  assert.equal(
    find(tree, (node) => node.type === 'a'),
    null
  )
  find(tree, (node) => node.type === 'button').props.onClick()
  tree = api.hooks.render(api.MessageFile, { file: meta, onRetry: null })
  const viewer = find(tree, (node) => node.type === api.ImageViewer)
  assert.ok(viewer)
  assert.equal(viewer.props.source, meta.id)
})

test('SVG messages download without entering the in-app raster viewer', async () => {
  const meta = attachment('drawing.svg')
  runtime.files.set(meta.id, file(meta.name, '<svg/>'))
  api.hooks.render(api.MessageFile, { file: meta, onRetry: null })
  await flush()
  const tree = api.hooks.render(api.MessageFile, { file: meta, onRetry: null })
  assert.equal(tree.type, 'a')
  assert.equal(tree.props.download, meta.name)
  assert.equal(
    find(tree, (node) => node.type === api.ImageViewer),
    null
  )
})

test('Android PDF cards share the original instead of navigating to a Blob URL', async () => {
  api.platform.kind = 'native'
  const meta = attachment('report.pdf')
  const original = file(meta.name)
  runtime.files.set(meta.id, original)
  api.hooks.render(api.MessageFile, { file: meta, onRetry: null })
  await flush()
  const card = api.hooks.render(api.MessageFile, { file: meta, onRetry: null })
  assert.equal(card.type, api.FileCard)
  assert.equal(card.props.link, undefined)
  assert.equal(typeof card.props.onOpen, 'function')
  const tree = api.FileCard(card.props)
  find(tree, (node) => node.type === 'button').props.onClick()
  await flush()
  assert.deepEqual(runtime.shares, [{ name: meta.name, blob: original }])
})

test('Android SVG action shares the file and reports share failures', async () => {
  api.platform.kind = 'native'
  const result = await loadedView(file('drawing.svg', '<svg/>'))
  assert.equal(result.link, undefined)
  assert.ok(result.url.startsWith('data:image/svg+xml;base64,'))
  result.onOpen()
  await flush()
  assert.equal(runtime.shares.length, 1)
  runtime.failShare = true
  result.onOpen()
  await flush()
  assert.equal(runtime.toasts[0].key, 'fileSaveFailed')
})

test('the full-screen viewer uses normalized preview MIME and saves the original', async () => {
  const original = file('large.png', 'original image bytes')
  const props = { source: original, name: original.name, onClose() {} }
  api.hooks.render(api.ImageViewer, props)
  await flush()
  const tree = api.hooks.render(api.ImageViewer, props)
  const preview = find(tree, (node) => node.type === 'img')
  assert.equal(created.get(preview.props.src).type, 'image/png')
  const save = find(tree, (node) => node.props?.children === 'imageViewerSaveShare')
  save.props.onClick()
  await flush()
  assert.equal(runtime.shares[0].blob, original)
})

test('full-screen zoom remains anchored to the image bounds after the preview integration', async () => {
  const original = file('wide.png')
  const props = { source: original, name: original.name, onClose() {} }
  api.hooks.render(api.ImageViewer, props)
  await flush()
  let tree = api.hooks.render(api.ImageViewer, props)
  const preview = find(tree, (node) => node.type === 'img')
  preview.props.ref.current = { getBoundingClientRect: () => ({ left: 100, top: 341 }) }
  preview.props.onDoubleClick({ clientX: 388, clientY: 451, preventDefault() {} })
  tree = api.hooks.render(api.ImageViewer, props)
  const zoomed = find(tree, (node) => node.type === 'img')
  assert.equal(zoomed.props.style.transformOrigin, '288px 110px')
  assert.equal(zoomed.props.style.transform, 'scale(2.5)')
})

test('full-screen viewer remains in the shared modal stack and Escape only closes its own layer', () => {
  const original = file('image.png')
  let closes = 0
  const props = {
    source: original,
    name: original.name,
    onClose() {
      closes++
    },
  }
  api.hooks.render(api.ImageViewer, props)
  assert.equal(api.openModals.length, 1)
  const upper = { close() {} }
  api.openModals.push(upper)
  for (const handler of listeners.get('keydown'))
    handler({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} })
  assert.equal(closes, 0)
  api.openModals.pop()
  assert.equal(api.closeTopModal(), true)
  assert.equal(closes, 1)
  for (const handler of listeners.get('keydown'))
    handler({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} })
  assert.equal(closes, 2)
  api.hooks.cleanup()
  assert.equal(api.openModals.length, 0)
})

test('missing full-screen originals settle to an error placeholder with saving disabled', async () => {
  const props = { source: 'gone', name: 'missing.png', onClose() {} }
  api.hooks.render(api.ImageViewer, props)
  await flush()
  const tree = api.hooks.render(api.ImageViewer, props)
  assert.ok(find(tree, (node) => node.props?.role === 'img'))
  assert.equal(
    find(tree, (node) => node.type === 'img'),
    null
  )
  assert.equal(
    find(tree, (node) => node.props?.children === 'imageViewerSaveShare').props.disabled,
    true
  )
})
