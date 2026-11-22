let slots = [],
  cursor = 0,
  effects = []
exports.hooks = {
  render(component, props) {
    cursor = 0
    const tree = component(props)
    const pending = effects
    effects = []
    for (const run of pending) run()
    return tree
  },
  cleanup() {
    for (const slot of slots) slot?.cleanup?.()
    slots = []
    cursor = 0
    effects = []
  },
}
exports.useState = (initial) => {
  const index = cursor++
  if (!(index in slots))
    slots[index] = { value: typeof initial === 'function' ? initial() : initial }
  return [
    slots[index].value,
    (value) => {
      slots[index].value = typeof value === 'function' ? value(slots[index].value) : value
    },
  ]
}
exports.useRef = (current) => {
  const index = cursor++
  return (slots[index] ??= { current })
}
exports.useEffect = (effect, deps) => {
  const index = cursor++
  const previous = slots[index]
  if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
    effects.push(() => {
      previous?.cleanup?.()
      slots[index] = { deps, cleanup: effect() }
    })
  }
}
exports.useLayoutEffect = exports.useEffect
exports.useDebugValue = () => {}
exports.useMemo = (callback) => callback()
exports.useCallback = (callback) => callback
exports.useSyncExternalStore = (_subscribe, snapshot) => snapshot()
exports.memo = (component) => component
exports.Fragment = 'fragment'
exports.jsx = exports.jsxs = (type, props) => ({ type, props: props ?? {} })
exports.jsxDEV = exports.jsx
exports.createPortal = (tree) => tree
exports.useTranslate = () => (key) => key
exports.translate = (key) => key
exports.isTranslationKey = () => true
exports.IconPhotoErrorFill20 =
  exports.IconRefreshOutline16 =
  exports.IconCloseFill14 =
  exports.IconCloseOutline16 =
  exports.Tooltip =
  exports.Button =
  exports.IconButton =
    function Stub() {}
const fixture = { files: new Map(), shares: [], toasts: [], failShare: false }
exports.fixture = fixture
exports.loadFile = async (id) => {
  const value = fixture.files.get(id)
  if (value instanceof Error) throw value
  return value
}
exports.platform = {
  kind: 'web',
  async saveOrShareFile(name, blob) {
    if (fixture.failShare) throw new Error('Fixture share error')
    fixture.shares.push({ name, blob })
    return { ok: true }
  },
  openExternal() {
    throw new Error('Local attachment must not use openExternal')
  },
}
exports.showToast = (toast) => fixture.toasts.push(toast)
