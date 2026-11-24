import { create } from 'zustand'
import type { Message, Session, SessionSummary } from './types.js'
import { getVisibleMessages } from './branches.js'

export type HistoryHit = {
  sessionId: string
  messageId: string
  title: string
  snippet: string
  role: Message['role']
  otherBranch: boolean
}
export const SEARCH_RESULT_LIMIT = 200
export const SEARCH_DEBOUNCE_MS = 160

export const useHistorySearch = create<{
  open: boolean
  query: string
  mode: 'title' | 'body'
}>(() => ({ open: false, query: '', mode: 'title' }))
export const openHistorySearch = () => useHistorySearch.setState({ open: true })
export const closeHistorySearch = () => useHistorySearch.setState({ open: false, query: '' })

export const filterSessionTitles = (sessions: SessionSummary[], query: string) => {
  const term = query.trim().toLowerCase()
  return term ? sessions.filter((session) => session.title.toLowerCase().includes(term)) : sessions
}

/** 仅用户输入与助手正文；不读取思考、工具、附件或服务端模板。流式正文待本轮结束再检索。 */
export const searchableMessageText = (message: Message): string =>
  message.role === 'user'
    ? message.content
    : message.status === 'pending' ||
        message.status === 'streaming' ||
        message.stopReason === 'refusal'
      ? ''
      : message.blocks
          .flatMap((block) => (block.type === 'text' && !block.isTemplate ? [block.text] : []))
          .join('\n\n')

export type SearchProgress = {
  hits: HistoryHit[]
  total: number
  scanned: number
  messages: number
  textUnits: number
  missing: number
}
const yieldToInput = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** 每次仅持有一个详情；数据库读取在自己的事务完成后返回，事务外分片让出主线程。 */
export const scanHistory = async ({
  summaries,
  query,
  signal,
  load,
  onProgress,
  yieldTask = yieldToInput,
}: {
  summaries: SessionSummary[]
  query: string
  signal: AbortSignal
  load: (id: string) => Promise<Session | undefined>
  onProgress: (progress: SearchProgress) => void
  yieldTask?: () => Promise<void>
}): Promise<SearchProgress> => {
  const term = query.trim().toLowerCase()
  const progress: SearchProgress = {
    hits: [],
    total: 0,
    scanned: 0,
    messages: 0,
    textUnits: 0,
    missing: 0,
  }
  let sliceStart = performance.now()
  let lastReport = -Infinity
  const checkpoint = async (force = false) => {
    signal.throwIfAborted()
    if (force || performance.now() - sliceStart >= 8) {
      await yieldTask()
      signal.throwIfAborted()
      sliceStart = performance.now()
    }
  }
  if (!term) {
    return progress
  }
  for (const summary of summaries) {
    await checkpoint()
    const session = await load(summary.id)
    signal.throwIfAborted()
    if (!session) {
      progress.missing++
    } else {
      const visible = new Set(getVisibleMessages(session).map((message) => message.id))
      for (const message of session.messages) {
        await checkpoint()
        const text = searchableMessageText(message)
        progress.messages++
        progress.textUnits += text.length
        // 分块大小写转换，长消息也能取消；重叠区保留跨块命中。
        let found = -1
        for (let start = 0; start < text.length; start += 8192) {
          await checkpoint()
          const part = text.slice(start, start + 8192 + term.length)
          const index = part.toLowerCase().indexOf(term)
          if (index >= 0) {
            found = start + index
            break
          }
        }
        if (found < 0) {
          continue
        }
        progress.total++
        if (progress.hits.length < SEARCH_RESULT_LIMIT) {
          progress.hits.push({
            sessionId: session.id,
            messageId: message.id,
            title: summary.title,
            role: message.role,
            otherBranch: !visible.has(message.id),
            snippet:
              (found > 45 ? '…' : '') +
              text.slice(Math.max(0, found - 45), found + term.length + 95).replace(/\s+/g, ' ') +
              (found + term.length + 95 < text.length ? '…' : ''),
          })
        }
      }
    }
    progress.scanned++
    if (
      (progress.scanned % 16 === 0 && performance.now() - lastReport >= 250) ||
      progress.scanned === summaries.length
    ) {
      onProgress({ ...progress, hits: [...progress.hits] })
      lastReport = performance.now()
    }
    if (progress.scanned % 16 === 0) {
      await checkpoint(true)
    }
  }
  signal.throwIfAborted()
  return progress
}
