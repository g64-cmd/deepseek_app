/**
 * 全屏浮层（设置弹窗、图片查看器等）的公共栈：后打开的在末尾。
 * 系统返回键 / Esc 只关闭最上层；无浮层时返回键交回退出逻辑。
 * Modal 与 ImageViewer 等自注册，backButton 只依赖本模块。
 */
type Layer = {
  close: () => void
  root?: HTMLElement
  modal?: boolean
}

// 菜单和全屏浮层共用关闭顺序，Android 返回和 Escape 不再各自猜测顶层。
export const openModals: Layer[] = []

const focusable = 'button, a[href], input, select, textarea, [tabindex]'
export const getTabStops = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(focusable)].filter(
    (node) =>
      node.tabIndex >= 0 &&
      !node.matches(':disabled') &&
      !node.closest('[inert]') &&
      node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility !== 'hidden'
  )

const focus = (node: HTMLElement | null | undefined) => node?.focus({ preventScroll: true })
const inerted = new Map<HTMLElement, boolean>()

const modalRoots = () => {
  const index = openModals.findLastIndex((layer) => layer.modal && layer.root)
  return index < 0
    ? []
    : openModals.slice(index).flatMap((layer) => (layer.root ? [layer.root] : []))
}

const updateInert = () => {
  for (const [node, previous] of inerted) {
    node.inert = previous
  }
  inerted.clear()
  const roots = modalRoots()
  if (!roots.length) {
    return
  }
  // 沿允许区域的祖先逐层隔离兄弟节点，保留 body Portal 和嵌套抽屉的通路。
  const visit = (parent: Element) => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement) || roots.includes(child)) {
        continue
      }
      if (roots.some((root) => child.contains(root))) {
        visit(child)
      } else {
        inerted.set(child, child.inert)
        child.inert = true
      }
    }
  }
  visit(document.body)
}

const onKeyDown = (event: KeyboardEvent) => {
  if (event.isComposing || event.defaultPrevented) {
    return
  }
  const top = openModals.at(-1)
  if (!top) {
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    top.close()
  } else if (event.key === 'Tab' && top.modal && top.root) {
    const stops = getTabStops(top.root)
    const index = stops.indexOf(document.activeElement as HTMLElement)
    if (!stops.length || index < 0 || (event.shiftKey ? index === 0 : index === stops.length - 1)) {
      event.preventDefault()
      focus((event.shiftKey ? stops.at(-1) : stops[0]) ?? top.root)
    }
  }
}

const onFocusIn = (event: FocusEvent) => {
  const roots = modalRoots()
  if (roots.length && !roots.some((root) => root.contains(event.target as Node))) {
    const root = roots.at(-1)
    if (root) {
      focus(getTabStops(root)[0] ?? root)
    }
  }
}

/** 注册实际 DOM 浮层；只恢复本层捕获的焦点，卸载非顶层时不抢焦点。 */
export const registerFocusLayer = ({
  root,
  close,
  modal = true,
  initialFocus,
  returnFocus,
}: {
  root: HTMLElement
  close: () => void
  modal?: boolean
  initialFocus?: HTMLElement | null
  returnFocus?: HTMLElement | null
}) => {
  const previous =
    returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const entry = { root, close, modal }
  openModals.push(entry)
  if (openModals.length === 1) {
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', onFocusIn)
  }
  // 先解除新 Portal 的隔离并移走旧焦点，再隔离背景，避免焦点留在 inert 子树。
  for (const [node, wasInert] of inerted) {
    node.inert = wasInert
  }
  inerted.clear()
  focus(initialFocus ?? getTabStops(root)[0] ?? root)
  updateInert()
  return () => {
    const top = openModals.at(-1) === entry
    const index = openModals.indexOf(entry)
    if (index >= 0) {
      openModals.splice(index, 1)
    }
    updateInert()
    if (!openModals.length) {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', onFocusIn)
    }
    if (!top) {
      return
    }
    // 点外部控件关闭菜单时保留新焦点；关闭浮层不能把用户刚选中的输入框拉走。
    const active = document.activeElement
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      active.isConnected &&
      !root.contains(active)
    ) {
      return
    }
    const roots = modalRoots()
    if (
      previous?.isConnected &&
      !previous.closest('[inert]') &&
      (!roots.length || roots.some((root) => root.contains(previous)))
    ) {
      focus(previous)
    } else if (roots.length) {
      const root = roots.at(-1)
      if (root) {
        focus(getTabStops(root)[0] ?? root)
      }
    } else {
      focus(document.querySelector<HTMLElement>('[data-focus-fallback]'))
    }
  }
}

/** 关闭最上层浮层；返回是否存在浮层（存在即视为该次关闭请求已被消费） */
export const closeTopModal = (): boolean => {
  const top = openModals.at(-1)
  if (!top) {
    return false
  }
  top.close()
  return true
}
