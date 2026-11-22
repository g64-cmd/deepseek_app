import assert from 'node:assert/strict'
import { compile, root } from './helpers/compile.mjs'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'

const runtimePath = path.join(root, 'tests/helpers/runtime/platform.cjs')
const moduleMocks = new Set(
  [
    'src/platform/native.js',
    'src/platform/index.js',
    'src/components/search/searchPanelState.js',
    'src/components/settings/settingsDialogState.js',
    'src/components/sider/mobileSiderState.js',
    'src/i18n/index.js',
    'src/components/base/icons.js',
    'src/components/base/IconButton.js',
    'src/components/search/HoverCard.js',
    'src/components/search/SourceCard.js',
  ].map((name) => path.join(root, name))
)
const packageMocks = new Set([
  '@capacitor/app',
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
])
const previousGlobals = Object.fromEntries(
  ['document', 'Node', 'Element'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ])
)
let api

before(async () => {
  const replacements = new Map([...moduleMocks, ...packageMocks].map((name) => [name, runtimePath]))
  api = await compile('./tests/helpers/entries/platform.ts', 'platform', replacements)
  for (const key of ['document', 'Node', 'Element']) globalThis[key] = api.testRuntime[key]
})

beforeEach(() => api.testRuntime.reset())
after(() => {
  api?.testRuntime.reset()
  for (const [key, descriptor] of Object.entries(previousGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

test('Android Back closes the top confirmation and preserves the underlying settings', () => {
  const runtime = api.testRuntime
  let confirmationsClosed = 0
  const mountSettingsAndConfirmation = () => {
    runtime.state.settings.open = true
    api.Modal({ title: 'Settings', onClose: runtime.closeSettings })
    api.Modal({
      title: 'Confirm deletion',
      onClose: () => {
        confirmationsClosed += 1
      },
    })
  }

  // Control: the existing production Modal stack closes only the top dialog.
  mountSettingsAndConfirmation()
  runtime.escape()
  assert.equal(confirmationsClosed, 1)
  assert.equal(runtime.state.settings.open, true)
  runtime.reset()
  confirmationsClosed = 0

  mountSettingsAndConfirmation()
  api.registerBackButton()
  runtime.back()
  assert.deepEqual(
    {
      confirmationClosed: confirmationsClosed,
      settingsOpen: runtime.state.settings.open,
      exits: runtime.state.exits,
    },
    { confirmationClosed: 1, settingsOpen: true, exits: 0 }
  )
})

test('Clicking a citation nested in a Markdown link opens only the citation source', () => {
  const runtime = api.testRuntime
  const outerUrl = 'https://example.com/article'
  const source = { index: 1, url: 'https://example.org/cited-source' }
  const ast = api.toMdAst(`[Article [citation:1]](${outerUrl})`, {
    sources: [source],
    disableLink: false,
  })
  const link = ast.children[0].children[0]
  assert.equal(link.type, 'link')
  assert.equal(link.children.at(-1).type, 'citation')
  const anchor = new runtime.Element('a', { href: outerUrl, target: '_blank' })
  api.delegateExternalAnchors()

  // Control: an ordinary Markdown anchor delegates once.
  runtime.click(anchor)
  assert.deepEqual(runtime.state.openedUrls, [outerUrl])
  runtime.state.openedUrls.length = 0

  const citation = api.CitationLink({ source })
  const trigger = citation.props.renderTrigger({ domRef: { current: null }, domProps: undefined })
  const span = new runtime.Element('span')
  span.parentElement = anchor
  runtime.click(span, trigger.props.onClick)
  assert.deepEqual([...runtime.state.openedUrls], [source.url])
})
