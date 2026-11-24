import { useTranslate } from '../../i18n/index.js'
import { useId, useRef } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useFocusLayer } from '../base/useFocusLayer.js'
import { IconCloseOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { closeSearchPanel, useSearchPanel } from './searchPanelState.js'
import { SourceCard } from './SourceCard.js'
import styles from './SearchPanel.module.css'

/** 右侧「搜索结果」面板 */
export const SearchPanel = () => {
  const t = useTranslate()
  const entry = useSearchPanel((state) => state.entry)
  const sources = useSearchPanel((state) => state.sources)
  const isMobile = useIsMobile()
  const root = useRef<HTMLElement>(null)
  const title = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useFocusLayer(root, closeSearchPanel, {
    open: !!entry,
    modal: isMobile,
    initialFocus: () => title.current,
  })
  if (!entry) {
    return null
  }
  return (
    <aside
      ref={root}
      tabIndex={-1}
      role={isMobile ? 'dialog' : 'complementary'}
      aria-modal={isMobile ? true : undefined}
      aria-labelledby={titleId}
      className={styles.panel}
    >
      <div className={styles.header}>
        <div
          ref={title}
          id={titleId}
          tabIndex={-1}
          role="heading"
          aria-level={2}
          className={styles.title}
        >
          {t('searchResult')}
        </div>
        <IconButton
          icon={<IconCloseOutline16 />}
          aria-label={t('close')}
          onClick={closeSearchPanel}
        />
      </div>
      <div className={styles.content}>
        {sources.map((source) => (
          <SourceCard key={source.url} source={source} className={styles.item} />
        ))}
      </div>
    </aside>
  )
}
