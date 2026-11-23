let slots = [],
  cursor = 0,
  effects = []
const contextValues = new Map()
exports.hooks = {
  render(component, props) {
    cursor = 0
    const tree = executeComponents(component(props))
    // 回调 ref 在效果前挂载，模拟宿主元素就绪的顺序
    attachRefs(tree)
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
// 组件类型的节点按 React 语义就地执行（子组件 hooks 排在父组件之后）
const executeComponents = (node) => {
  if (Array.isArray(node)) return node.map(executeComponents)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return executeComponents(node.type(node.props))
  const children = node.props?.children
  if (children !== undefined) {
    node.props.children = Array.isArray(children) ? children.map(executeComponents) : executeComponents(children)
  }
  return node
}
const attachRefs = (node) => {
  if (!node || typeof node !== 'object') return
  if (typeof node.props?.ref === 'function') node.props.ref(node)
  for (const child of [node.props?.children].flat(Infinity)) attachRefs(child)
}
exports.setContextValue = (context, value) => {
  contextValues.set(context, value)
}
exports.resetContextValues = () => contextValues.clear()
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
exports.useReducer = (reducer, initial) => [initial, () => {}]
exports.useDebugValue = () => {}
exports.useMemo = (callback) => callback()
exports.useCallback = (callback) => callback
exports.useSyncExternalStore = (_subscribe, snapshot) => snapshot()
exports.memo = (component) => component
exports.Fragment = 'fragment'
exports.createContext = (defaultValue) => ({ contextKey: defaultValue })
exports.useContext = (context) =>
  contextValues.has(context) ? contextValues.get(context) : context.contextKey
exports.jsx = exports.jsxs = (type, props) => ({ type, props: props ?? {} })
exports.jsxDEV = exports.jsx
exports.createPortal = (tree) => tree

// ---- 被替换模块的替身（仅环境边界；门控/调度器为真实实现） ----
exports.useTranslate = () => (key) => key
exports.translate = (key) => key
exports.isTranslationKey = () => true
exports.useTheme = () => 'light'
exports.IconCheckOutline16 = exports.IconCopyOutline16 = function Stub() {}
exports.showToast = (toast) => fixture.toasts.push(toast)
exports.copyText = async () => false

const fixture = {
  toasts: [],
  loadCalls: [],
  highlightCalls: [],
  katexCalls: [],
  initCalls: [],
  renderCalls: [],
  renderGate: null,
  failRenderFor: new Set(),
  langMap: { json: 'json', mermaid: 'mermaid' },
  loadedLangs: new Set(['plaintext']),
  reset() {
    this.toasts.length = 0
    this.loadCalls.length = 0
    this.highlightCalls.length = 0
    this.katexCalls.length = 0
    this.initCalls.length = 0
    this.renderCalls.length = 0
    this.renderGate = null
    this.failRenderFor.clear()
    this.langMap = { json: 'json', mermaid: 'mermaid' }
    this.loadedLangs = new Set(['plaintext'])
  },
}
exports.fixture = fixture

// src/services/markdown/highlight.js
exports.getHighlightLang = (infostring) =>
  Object.hasOwn(fixture.langMap, infostring) ? fixture.langMap[infostring] : null
exports.isHighlightLoaded = (lang) => fixture.loadedLangs.has(lang)
exports.loadHighlight = (lang) => {
  fixture.loadCalls.push(lang)
  fixture.loadedLangs.add(lang)
  return Promise.resolve()
}

// src/services/markdown/katex.js：输出须符合 MathFormula 的前后缀切片
exports.ensureKatex = () => ({
  renderToString(input, options) {
    fixture.katexCalls.push(input)
    if (options.displayMode) {
      return `<span class="katex-display"><span class="katex">katex(${input})</span></span>`
    }
    return `<span class="katex">katex(${input})</span>`
  },
})
