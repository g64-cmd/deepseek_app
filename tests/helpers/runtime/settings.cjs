let slots = [],
  cursor = 0
const hooks = {
  render(component, props) {
    cursor = 0
    return component(props)
  },
  reset() {
    slots = []
    cursor = 0
  },
}
exports.hooks = hooks
exports.useState = (initial) => {
  const index = cursor++
  if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
  return [
    slots[index],
    (value) => {
      slots[index] = typeof value === 'function' ? value(slots[index]) : value
    },
  ]
}
exports.useRef = (value) => ({ current: value })
exports.useId = () => 'fixture-settings'
exports.useEffect = exports.useLayoutEffect = exports.useDebugValue = () => {}
exports.useMemo = (callback) => callback()
exports.useCallback = (callback) => callback
exports.useSyncExternalStore = (_subscribe, snapshot) => snapshot()
exports.memo = (component) => component
exports.Fragment = 'fragment'
exports.jsx = exports.jsxs = (type, props) => ({ type, props: props ?? {} })
exports.jsxDEV = exports.jsx
exports.useTranslate = () => (key) => key
exports.translate = (key) => key
exports.isTranslationKey = () => true
exports.useIsMobile = () => false
exports.useApiKeyEditor = () => ({ showInput: false, form: {} })
exports.platform = { saveOrShareFile: async () => ({ ok: true }) }
exports.showToast = () => {}
exports.Button =
  exports.Modal =
  exports.Select =
  exports.ApiKeyConfirm =
  exports.ApiKeyField =
    function Stub() {}
for (const name of [
  'IconAccountOutline16',
  'IconDarkOutline16',
  'IconDataOutline16',
  'IconDownloadOutline16',
  'IconFollowsystemOutline16',
  'IconLightOutline16',
  'IconSettingsOutline16',
  'IconUploadOutline14',
])
  exports[name] = function Icon() {}
