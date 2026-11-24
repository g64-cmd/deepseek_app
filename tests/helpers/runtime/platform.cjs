// Minimal DOM / plugin boundaries. The test bundle executes the production
// Modal, CitationLink, back-button handler and external-link delegate unchanged.
const { TestHTMLElement, attachRef } = require('../dom.cjs')
const layouts = []
const state = {
  settings: { open: false },
  sider: { open: false },
  search: { entry: null },
  backListeners: new Set(),
  effects: [],
  openedUrls: [],
  exits: 0,
}

class TestNode {
  parentElement = null
}

class TestElement extends TestNode {
  constructor(tag, attributes = {}) {
    super()
    this.tag = tag
    this.attributes = attributes
  }

  getAttribute(name) {
    return this.attributes[name] ?? null
  }

  closest(selector) {
    if (selector !== 'a[target="_blank"]') throw new Error(`Unexpected selector: ${selector}`)
    for (let element = this; element; element = element.parentElement) {
      if (element.tag === 'a' && element.getAttribute('target') === '_blank') return element
    }
    return null
  }
}

const listeners = new Map()
const document = {
  body: new TestHTMLElement(),
  querySelector: () => null,
  addEventListener(name, handler, capture = false) {
    const handlers = listeners.get(name) ?? []
    handlers.push({ handler, capture })
    listeners.set(name, handlers)
  },
  removeEventListener(name, handler) {
    listeners.set(
      name,
      (listeners.get(name) ?? []).filter((item) => item.handler !== handler)
    )
  },
}

const closeSettings = () => {
  state.settings.open = false
}
const jsx = attachRef
const emptyComponent = () => null

module.exports = {
  App: {
    addListener(name, handler) {
      if (name !== 'backButton') throw new Error(`Unexpected plugin event: ${name}`)
      state.backListeners.add(handler)
      return Promise.resolve({ remove: async () => state.backListeners.delete(handler) })
    },
    async exitApp() {
      state.exits += 1
    },
  },
  useSettingsDialog: { getState: () => state.settings },
  useMobileSider: { getState: () => state.sider },
  useSearchPanel: { getState: () => state.search },
  closeSettings,
  closeMobileSider: () => {
    state.sider.open = false
  },
  closeSearchPanel: () => {
    state.search.entry = null
  },
  navigateToExternal: (url) => {
    state.openedUrls.push(url)
  },
  platform: {
    openExternal: async (url) => {
      state.openedUrls.push(url)
    },
  },
  useTranslate: () => (key) => key,
  IconCloseOutline16: emptyComponent,
  IconButton: emptyComponent,
  HoverCard: emptyComponent,
  SourceCard: emptyComponent,
  useEffect(effect) {
    state.effects.push(effect())
  },
  useLayoutEffect(effect) {
    layouts.push(effect)
  },
  useId: () => 'review-modal',
  useRef: (current) => ({ current }),
  createPortal: (node) => node,
  jsx,
  jsxs: jsx,
  jsxDEV: jsx,
  testRuntime: {
    state,
    document,
    Node: TestNode,
    Element: TestElement,
    HTMLElement: TestHTMLElement,
    flushLayouts() {
      for (const effect of layouts.splice(0)) state.effects.push(effect())
    },
    closeSettings,
    reset() {
      for (const cleanup of state.effects.splice(0).reverse()) cleanup?.()
      state.backListeners.clear()
      listeners.clear()
      state.settings.open = false
      state.sider.open = false
      state.search.entry = null
      state.openedUrls.length = 0
      state.exits = 0
    },
    escape() {
      for (const { handler } of [...(listeners.get('keydown') ?? [])])
        handler({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} })
    },
    back() {
      for (const handler of state.backListeners) handler({ canGoBack: false })
    },
    click(target, targetHandler) {
      const event = {
        target,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() {
          this.defaultPrevented = true
        },
        stopPropagation() {
          this.propagationStopped = true
        },
      }
      // DOM click order: document capture -> target handler -> document bubble.
      // React's delegated handlers run at the root container, i.e. before the
      // document bubble listeners, which is what the targetHandler stands for.
      const clickListeners = listeners.get('click') ?? []
      for (const { handler, capture } of clickListeners) {
        if (capture && !event.propagationStopped) handler(event)
      }
      if (!event.propagationStopped) targetHandler?.(event)
      for (const { handler, capture } of clickListeners) {
        if (!capture && !event.propagationStopped) handler(event)
      }
      return event
    },
  },
}
