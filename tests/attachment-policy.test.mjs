import assert from 'node:assert/strict'
import path from 'node:path'
import { before, after, beforeEach, test } from 'node:test'
import { root, compile } from './helpers/compile.mjs'

const names = [
  'localStorage',
  'fetch',
  'window',
  'document',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]
const globals = new Map(
  names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
)
let api, Input
before(async () => {
  const values = new Map()
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
  globalThis.window = new EventTarget()
  globalThis.document = new EventTarget()
  document.visibilityState = 'hidden'
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  const ui = path.join(root, 'tests/helpers/runtime/attachment-policy.cjs')
  const data = path.join(root, 'tests/helpers/runtime/chat.cjs')
  const replacements = new Map(
    ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime'].map((name) => [name, ui])
  )
  for (const name of [
    'src/i18n/index.js',
    'src/app/viewport.js',
    'src/services/speech/readAloud.js',
    'src/components/base/icons.js',
    'src/components/base/IconButton.js',
    'src/components/base/Modal.js',
    'src/components/base/Button.js',
    'src/components/base/Menu.js',
    'src/components/base/Tooltip.js',
    'src/components/base/toastState.js',
    'src/components/settings/settingsDialogState.js',
    'src/components/chatInput/useVoiceInput.js',
    'src/components/chatInput/DragMask.js',
    'src/components/chatInput/DraftAttachments.js',
    'src/components/chatInput/VoiceButton.js',
    'src/components/chatInput/Spectrum.js',
    'src/components/messages/useReplyView.js',
    'src/components/messages/ReplyArea.js',
    'src/components/messages/BranchSwitcher.js',
    'src/components/markdown/Markdown.js',
    'src/components/search/searchPanelState.js',
  ])
    replacements.set(path.join(root, name), ui)
  for (const name of ['src/services/chat/db.js', 'src/platform/secureStorage.js'])
    replacements.set(path.join(root, name), data)
  api = await compile(
    './tests/helpers/entries/attachment-policy.ts',
    'attachment-policy',
    replacements
  )
  Input = api.ChatInput({ sessionId: null }).type
})
after(() => {
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})
beforeEach(() => {
  api.hooks.reset()
  api.setDocBillingAcked(false)
  api.setDocParseMode('rich')
  api.useDrafts.setState({ drafts: new Map() })
  api.useUploads.setState({ tasks: {} })
  api.useChatStore.setState({
    ready: true,
    importingHistory: false,
    sessions: [],
    sessionCache: {},
    streaming: {},
  })
})
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = find(child, predicate)
    if (found) return found
  }
  return null
}
const render = () => api.hooks.render(Input, { sessionId: null })
const pick = (tree) =>
  find(tree, (node) => node.type === 'input' && node.props.type === 'file').props.onChange({
    target: { files: [new File(['pdf'], 'paper.pdf', { type: 'application/pdf' })], value: '' },
  })
const modal = (tree) => find(tree, (node) => node.props?.title === 'docBillingTitle')
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('the upload confirmation can be cancelled without a draft, upload or stored consent', () => {
  let uploads = 0
  globalThis.fetch = async () => {
    uploads++
    return Response.json({ id: 'file-api-fixture' })
  }
  pick(render())
  const dialog = modal(render())
  assert.ok(dialog)
  assert.equal(uploads, 0)
  find(dialog.props.footer, (node) => node.props?.children === 'cancel').props.onClick()
  assert.equal(modal(render()), null)
  assert.equal(uploads, 0)
  assert.equal(api.getDraft(null).attachments.length, 0)
  assert.equal(api.useSettings.getState().docBillingAcked, false)
})

test('choosing text mode and confirming uploads exactly once through the real service', async () => {
  const forms = []
  globalThis.fetch = async (_url, options) => {
    forms.push(options.body)
    return Response.json({ id: 'file-api-ui' })
  }
  pick(render())
  let dialog = modal(render())
  find(
    dialog,
    (node) => node.type === 'input' && node.props.type === 'radio' && !node.props.checked
  ).props.onChange()
  dialog = modal(render())
  find(dialog.props.footer, (node) => node.props?.children === 'docBillingConfirm').props.onClick()
  await tick()
  assert.equal(modal(render()), null)
  assert.equal(forms.length, 1)
  assert.equal(forms[0].get('purpose'), 'text_recognition')
  assert.equal(api.useSettings.getState().docBillingAcked, true)
})

test('starting an import while the upload confirmation is open prevents its confirmation', () => {
  pick(render())
  const dialog = modal(render())
  api.useChatStore.setState({ importingHistory: true })
  find(dialog.props.footer, (node) => node.props?.children === 'docBillingConfirm').props.onClick()
  assert.equal(api.getDraft(null).attachments.length, 0)
  assert.equal(api.useSettings.getState().docBillingAcked, false)
})

test('the reparse and omission buttons complete their real request paths', async () => {
  const message = {
    id: 'reply',
    role: 'assistant',
    createdAt: 1,
    model: 'deepseek-flash',
    status: 'error',
    prefix: true,
    blocks: [],
    error: { kind: 'reparse', message: 'Requires parsing', fileIds: ['doc'] },
  }
  const props = {
    sessionId: 'ui-retry',
    message,
    isLast: true,
    streaming: false,
    busy: false,
    versions: { index: 0, total: 1 },
    onSelectVersion() {},
  }
  const file = {
    id: 'doc',
    serverId: null,
    name: 'paper.pdf',
    isImage: false,
    mimeType: 'application/pdf',
    size: 3,
    purpose: 'text_recognition',
  }
  const session = {
    id: 'ui-retry',
    title: 'UI test',
    createdAt: 1,
    updatedAt: 1,
    messages: [
      { id: 'question', role: 'user', content: 'Read this', createdAt: 1, files: [file] },
      message,
    ],
  }
  api.runtime.files.set('doc', new Blob(['pdf']))
  api.runtime.sessions.set(session.id, session)
  api.useChatStore.setState({ sessionCache: { [session.id]: session }, sessions: [session] })
  let uploads = 0,
    requests = 0
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/files')) {
      uploads++
      return Response.json({ id: 'file-api-ui' })
    }
    requests++
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  }
  let tree = api.hooks.render(api.AssistantMessage, props)
  const action = find(tree, (node) => node.props?.children === 'docReparseConfirm')
  assert.ok(action)
  assert.equal(uploads, 0)
  action.props.onClick()
  for (let i = 0; i < 100 && api.useChatStore.getState().streaming[session.id]; i++) await tick()
  assert.equal(uploads, 1)
  assert.equal(requests, 1)
  const missingReply = {
    ...message,
    error: { kind: 'contextMissing', message: 'Missing file', fileIds: ['missing'] },
  }
  const missingSession = {
    ...session,
    messages: [{ ...session.messages[0], files: [{ ...file, id: 'missing' }] }, missingReply],
  }
  api.useChatStore.setState({ sessionCache: { [session.id]: missingSession } })
  tree = api.hooks.render(api.AssistantMessage, {
    ...props,
    message: missingReply,
  })
  find(tree, (node) => node.props?.children === 'contextOmit').props.onClick()
  for (let i = 0; i < 100 && api.useChatStore.getState().streaming[session.id]; i++) await tick()
  assert.equal(requests, 2)
  assert.equal(uploads, 1)
  assert.equal(api.useChatStore.getState().sessionCache[session.id].messages[0].files.length, 1)
})
