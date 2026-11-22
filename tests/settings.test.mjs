import assert from 'node:assert/strict'
import path from 'node:path'
import { before, test } from 'node:test'
import { root, compile } from './helpers/compile.mjs'
let api
before(async () => {
  const runtime = path.join(root, 'tests/helpers/runtime/settings.cjs')
  const dataRuntime = path.join(root, 'tests/helpers/runtime/chat.cjs')
  const replacements = new Map(
    ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime'].map((name) => [name, runtime])
  )
  for (const name of [
    'src/app/viewport.js',
    'src/i18n/index.js',
    'src/platform/index.js',
    'src/components/settings/ApiKeyField.js',
    'src/components/base/icons.js',
    'src/components/base/Modal.js',
    'src/components/base/Button.js',
    'src/components/base/Select.js',
    'src/components/base/toastState.js',
  ])
    replacements.set(path.join(root, name), runtime)
  for (const name of ['src/services/chat/db.js', 'src/platform/secureStorage.js'])
    replacements.set(path.join(root, name), dataRuntime)
  api = await compile('./tests/helpers/entries/settings.ts', 'settings', replacements)
})
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of [node.props?.children].flat(Infinity)) {
    const match = find(child, predicate)
    if (match) return match
  }
  return null
}
test('the account Go to key button changes the visible tab of the already open settings', () => {
  api.openSettings('account')
  api.hooks.reset()
  const outer = api.hooks.render(api.SettingsDialog)
  const content = outer.type
  api.hooks.reset()
  let tree = api.hooks.render(content)
  assert.equal(
    find(
      tree,
      (node) => node.props?.role === 'tab' && node.props['aria-selected']
    ).props.children.at(-1),
    'settingDialogAsideAccountOptionLabel'
  )
  // The panel has no local useState; read the real button callback without changing the parent hook slots.
  const panel = api.BalancePanel()
  const button = find(panel, (node) => node.props?.children === 'accountBalanceGoToKey')
  assert.ok(button)
  button.props.onClick()
  assert.equal(
    api.useSettingsDialog.getState().section,
    'data',
    'the real callback updates the store'
  )
  tree = api.hooks.render(content)
  assert.equal(
    find(
      tree,
      (node) => node.props?.role === 'tab' && node.props['aria-selected']
    ).props.children.at(-1),
    'settingDialogAsideDataOptionLabel',
    'the visible tab must follow the navigation request'
  )
})

test('tab clicks and programmatic navigation use the same selected section', () => {
  api.openSettings('general')
  api.hooks.reset()
  const content = api.hooks.render(api.SettingsDialog).type
  api.hooks.reset()
  let tree = api.hooks.render(content)
  const account = find(
    tree,
    (node) =>
      node.props?.role === 'tab' &&
      node.props.children.at(-1) === 'settingDialogAsideAccountOptionLabel'
  )
  account.props.onClick()
  assert.equal(api.useSettingsDialog.getState().section, 'account')
  tree = api.hooks.render(content)
  assert.equal(
    find(
      tree,
      (node) => node.props?.role === 'tab' && node.props['aria-selected']
    ).props.children.at(-1),
    'settingDialogAsideAccountOptionLabel'
  )
  api.openSettings('data')
  tree = api.hooks.render(content)
  assert.equal(
    find(
      tree,
      (node) => node.props?.role === 'tab' && node.props['aria-selected']
    ).props.children.at(-1),
    'settingDialogAsideDataOptionLabel'
  )
  api.closeSettings()
  assert.equal(api.hooks.render(api.SettingsDialog), null)
  api.openSettings('general')
  api.hooks.reset()
  tree = api.hooks.render(content)
  assert.equal(
    find(
      tree,
      (node) => node.props?.role === 'tab' && node.props['aria-selected']
    ).props.children.at(-1),
    'settingDialogAsideGeneralOptionLabel'
  )
})
