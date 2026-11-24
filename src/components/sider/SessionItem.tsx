import clsx from 'clsx'
import { memo, useLayoutEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconEditOutline16, IconEllipsisOutline16, IconTrashOutline16 } from '../base/icons.js'
import { renameSession, selectSession } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { showToast } from '../base/toastState.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  onDelete: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const titleRef = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(false)
  useLayoutEffect(() => {
    if (wasEditing.current && !editing) {
      titleRef.current?.focus()
    }
    wasEditing.current = editing
  }, [editing])
  const displayTitle = session.title || t('untitledChat')

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        void renameSession(session.id, title.trim()).then((ok) => {
          if (!ok) {
            showToast({ key: 'sessionRenameFailed', type: 'error' })
          }
        })
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        aria-label={t('sessionItemMenuRenameOption')}
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            event.stopPropagation()
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div data-session-row={session.id} className={clsx(styles.item, active && styles.active)}>
      <button
        data-session-item={session.id}
        ref={titleRef}
        type="button"
        className={styles.title}
        aria-current={active ? 'page' : undefined}
        onClick={() => {
          selectSession(session.id)
          closeMobileSider()
        }}
      >
        {displayTitle}
      </button>
      <div className={styles.action}>
        <Menu
          options={[
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: <IconEditOutline16 />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <IconTrashOutline16 />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        >
          {({ open, toggle }) => (
            <IconButton
              icon={<IconEllipsisOutline16 />}
              aria-label={t('sessionMore', { title: displayTitle })}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={toggle}
            />
          )}
        </Menu>
      </div>
    </div>
  )
})
