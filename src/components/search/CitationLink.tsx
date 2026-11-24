import type { SyntheticEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { Source } from '../../services/chat/view.js'
import { platform } from '../../platform/index.js'
import { HoverCard, type HoverCardTrigger } from './HoverCard.js'
import { SourceCard } from './SourceCard.js'

/**
 * 正文里 [citation:N] 的数字角标：悬停预览来源，点击新标签打开。
 * 角标使用带 link 角色的 span，可嵌入链接文字。样式由 .ds-markdown-cite 提供。
 */
export const CitationLink = ({ source }: { source: Source }) => {
  const t = useTranslate()
  const open = (event: SyntheticEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    void platform.openExternal(source.url)
  }
  const renderTrigger: HoverCardTrigger = ({ domRef, domProps }) => (
    <span
      ref={domRef}
      className="ds-markdown-cite"
      {...domProps}
      role="link"
      tabIndex={0}
      aria-label={t('citationSource', { index: source.index, title: source.title || source.url })}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          open(event)
        }
      }}
    >
      {source.index}
    </span>
  )
  return (
    <HoverCard renderTrigger={renderTrigger}>
      <SourceCard source={source} />
    </HoverCard>
  )
}
