import { useLayoutEffect, useRef, type RefObject } from 'react'
import { registerFocusLayer } from './modalStack.js'

export const useFocusLayer = (
  root: RefObject<HTMLElement | null>,
  onClose: () => void,
  {
    open = true,
    modal = true,
    initialFocus,
    returnFocus,
  }: {
    open?: boolean
    modal?: boolean
    initialFocus?: () => HTMLElement | null | undefined
    returnFocus?: () => HTMLElement | null | undefined
  } = {}
) => {
  const callbacks = useRef({ onClose, initialFocus, returnFocus })
  callbacks.current = { onClose, initialFocus, returnFocus }
  const opener = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)
  if (open && !wasOpen.current) {
    // 在子元素的 autoFocus 执行前记住触发器；布局 effect 时焦点可能已经进入浮层。
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  wasOpen.current = open
  useLayoutEffect(() => {
    if (!open || !root.current) {
      return
    }
    return registerFocusLayer({
      root: root.current,
      close: () => callbacks.current.onClose(),
      modal,
      initialFocus: callbacks.current.initialFocus?.(),
      returnFocus: callbacks.current.returnFocus?.() ?? opener.current,
    })
  }, [open, modal, root])
}
