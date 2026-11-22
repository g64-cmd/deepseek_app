import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'

/**
 * 已结束回答中富内容（图表/高亮/公式）的视口增强门控。
 *
 * 观察根是当前消息滚动层，进入预取范围（上下各约一屏）后一次性增强并保留，
 * 不因滚出视口退回源码形态。流式内容不门控，始终立即渲染；流式期间已按
 * 完整形态渲染过的块在回答结束后同样保持。消息列表之外（无 Provider）或
 * 环境不支持 IntersectionObserver 时立即增强。
 *
 * 屏外保留的是可读源码（代码原文/TeX/图表源码），保证读屏与基础阅读不被
 * 空占位截断；进入预取范围或块内获得 DOM 焦点后增强。
 */
export type RichGateController = {
  watch: (element: Element, onEnter: () => void) => () => void
}

type RichGateRoot = { controller: RichGateController | null }

export const RichGateContext = createContext<RichGateRoot | null>(null)

/** 预取范围：滚动层上下各约一屏，先取一屏起步，按测量再调整 */
const ROOT_MARGIN = '100% 0px 100% 0px'

/** 消息列表持有：绑定实际滚动层；断点切换时滚动元素变化，随 resetKey 重建观察器。 */
export const useRichGateRoot = (
  scrollElementRef: RefObject<HTMLElement | null>,
  resetKey: unknown
): RichGateRoot => {
  const [root, setRoot] = useState<RichGateRoot>({ controller: null })
  useLayoutEffect(() => {
    const scroll = scrollElementRef.current
    if (!scroll) {
      return
    }
    if (typeof IntersectionObserver === 'undefined') {
      // 旧环境无法按需观察时保持既有行为：全部立即增强。
      const immediate: RichGateController = {
        watch: (_element, onEnter) => {
          onEnter()
          return () => {}
        },
      }
      setRoot({ controller: immediate })
      return
    }
    const callbacks = new Map<Element, () => void>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue
          }
          const callback = callbacks.get(entry.target)
          if (!callback) {
            continue
          }
          // 进入即增强并保留：注销观察，离开视口不回调。
          observer.unobserve(entry.target)
          callbacks.delete(entry.target)
          callback()
        }
      },
      { root: scroll, rootMargin: ROOT_MARGIN }
    )
    setRoot({
      controller: {
        watch: (element, onEnter) => {
          callbacks.set(element, onEnter)
          observer.observe(element)
          return () => {
            if (callbacks.get(element) === onEnter) {
              callbacks.delete(element)
            }
            observer.unobserve(element)
          }
        },
      },
    })
    return () => {
      observer.disconnect()
    }
  }, [scrollElementRef, resetKey])
  return root
}

/**
 * 单个富内容块的门控状态。
 * gated=false（流式中，或块本身无增强成本）时立即增强。
 * 焦点激活：把 activate 绑到块根元素的 onFocus，键盘/辅助技术聚焦时立即增强。
 */
export const useRichGate = (gated: boolean) => {
  const root = useContext(RichGateContext)
  const controller = root?.controller ?? null
  const [entered, setEntered] = useState(false)
  const elementRef = useRef<HTMLElement | null>(null)
  // 流式期间已按完整形态渲染过的块，回答结束后不退回源码形态等待观察。
  const eagerRef = useRef(!gated)
  if (!gated) {
    eagerRef.current = true
  }
  const active = eagerRef.current || entered || root === null
  useEffect(() => {
    if (!gated || entered) {
      return
    }
    const element = elementRef.current
    if (!controller || !element) {
      return
    }
    return controller.watch(element, () => setEntered(true))
  }, [gated, entered, controller, elementRef])
  const activate = useCallback(() => setEntered(true), [])
  // 回调 ref：具体元素类型按逆变赋值，div/p 等宿主都能直接使用
  const setElement = useCallback((element: HTMLElement | null) => {
    elementRef.current = element
  }, [])
  return { setElement, active, activate }
}
