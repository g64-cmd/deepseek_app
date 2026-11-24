import { useEffect, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import { getVisibleMessages } from '../../services/chat/branches.js'

/** 只播报本会话的生成状态转换，正文和 SSE token 不放入 live region。 */
export const ReplyStatus = () => {
  const t = useTranslate()
  const [announcement, setAnnouncement] = useState<TranslationKey | null>(null)
  useEffect(() => {
    const initial = useChatStore.getState()
    setAnnouncement(
      initial.activeId && initial.streaming[initial.activeId] ? 'replyStatusGenerating' : null
    )
    // 订阅真实请求控制器的开始/结束，而不是末条消息 ID。同步快速失败也不会被
    // React 批处理吞掉；选择历史版本、导入或切换会话不会伪装成一次生成结束。
    return useChatStore.subscribe((state, before) => {
      const id = state.activeId
      const controller = id ? state.streaming[id] : undefined
      if (id !== before.activeId) {
        setAnnouncement(controller ? 'replyStatusGenerating' : null)
        return
      }
      const previous = id ? before.streaming[id] : undefined
      if (controller === previous) {
        return
      }
      if (controller) {
        setAnnouncement('replyStatusGenerating')
      } else {
        const session = id ? state.sessionCache[id] : undefined
        const last = session ? getVisibleMessages(session).at(-1) : undefined
        const status = last?.role === 'assistant' ? last.status : undefined
        setAnnouncement(
          status === 'error'
            ? 'replyStatusFailed'
            : status === 'stopped'
              ? 'replyStatusStopped'
              : status === 'done'
                ? 'replyStatusDone'
                : null
        )
      }
    })
  }, [])
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-reply-status>
      {announcement ? t(announcement) : ''}
    </div>
  )
}
