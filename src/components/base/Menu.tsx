import clsx from 'clsx'
import { useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import { getTabStops } from './modalStack.js'
import { useFocusLayer } from './useFocusLayer.js'
import styles from './Menu.module.css'

export type MenuOption = {
  key: string
  label: string
  icon: ReactNode
  danger?: boolean
  onSelect: () => void
}

/** 点击触发，向下展开；点外部或 Esc 关闭 */
export const Menu = ({
  options,
  children,
}: {
  options: MenuOption[]
  children: (props: { open: boolean; toggle: () => void }) => ReactNode
}) => {
  const [open, setOpen] = useState(false)
  const id = useId()
  const startAtEnd = useRef(false)
  const search = useRef({ text: '', time: 0 })
  const close = () => setOpen(false)
  // 左侧对齐并再左移 5px，让菜单文字与触发元素图标对齐
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    { align: 'start', alignOffset: -5, offset: 4 }
  )
  useDismiss(open, [anchorRef, floatingRef], close)
  const trigger = () => anchorRef.current?.querySelector<HTMLElement>('button')
  useFocusLayer(floatingRef, close, {
    open,
    modal: false,
    returnFocus: trigger,
    initialFocus: () => {
      const items = floatingRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      return startAtEnd.current ? items?.item(items.length - 1) : items?.item(0)
    },
  })

  return (
    <>
      <span
        ref={anchorRef}
        className={styles.anchor}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            startAtEnd.current = event.key === 'ArrowUp'
            setOpen(true)
          }
        }}
      >
        {children({
          open,
          toggle: () => {
            startAtEnd.current = false
            setOpen((value) => !value)
          },
        })}
      </span>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              id={id}
              tabIndex={-1}
              className={styles.menu}
              style={position ?? undefined}
              role="menu"
              aria-label={trigger()?.getAttribute('aria-label') ?? undefined}
              onKeyDown={(event) => {
                const items = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
                ]
                const current = items.indexOf(document.activeElement as HTMLButtonElement)
                let index: number | undefined
                if (event.key === 'ArrowDown') {
                  index = (current + 1) % items.length
                } else if (event.key === 'ArrowUp') {
                  index = (current - 1 + items.length) % items.length
                } else if (event.key === 'Home') {
                  index = 0
                } else if (event.key === 'End') {
                  index = items.length - 1
                } else if (event.key === 'Tab') {
                  event.preventDefault()
                  const backwards = event.shiftKey
                  const anchor = trigger()
                  close()
                  queueMicrotask(() => {
                    if (!anchor?.isConnected) {
                      return
                    }
                    const scope = anchor.closest<HTMLElement>('[role="dialog"]') ?? document.body
                    const stops = getTabStops(scope)
                    const at = stops.indexOf(anchor)
                    const next = at + (backwards ? -1 : 1)
                    ;(stops[(next + stops.length) % stops.length] ?? anchor).focus()
                  })
                  return
                } else if (
                  event.key.length === 1 &&
                  !event.ctrlKey &&
                  !event.altKey &&
                  !event.metaKey &&
                  event.key !== ' '
                ) {
                  const now = Date.now()
                  search.current.text =
                    now - search.current.time < 700 ? search.current.text + event.key : event.key
                  search.current.time = now
                  const text = search.current.text.toLocaleLowerCase()
                  index = items.findIndex((_, offset) =>
                    items[(current + 1 + offset) % items.length]?.textContent
                      ?.trim()
                      .toLocaleLowerCase()
                      .startsWith(text)
                  )
                  if (index >= 0) {
                    index = (current + 1 + index) % items.length
                  }
                }
                if (index !== undefined && items[index]) {
                  event.preventDefault()
                  items[index].focus()
                }
              }}
            >
              {options.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  tabIndex={-1}
                  role="menuitem"
                  className={clsx(styles.option, option.danger && styles.danger)}
                  onClick={() => {
                    trigger()?.focus({ preventScroll: true })
                    setOpen(false)
                    option.onSelect()
                  }}
                >
                  <span className={styles.icon}>{option.icon}</span>
                  {option.label}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
