// Isolated browser fixture. Production App/store/IndexedDB, no API credentials or requests.
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/app/App.js'
import { setupTheme } from '../../../src/app/theme.js'
import { closeSettings } from '../../../src/components/settings/settingsDialogState.js'
import { closeTopModal } from '../../../src/components/base/modalStack.js'
import {
  openMobileSider,
  closeMobileSider,
} from '../../../src/components/sider/mobileSiderState.js'
import {
  useChatStore,
  replaceHistory,
  selectSession,
  removeSession,
  stopReply,
} from '../../../src/services/chat/store.js'
import { addStagingSession, saveSession } from '../../../src/services/chat/db.js'
import {
  closeHistorySearch,
  useHistorySearch,
  scanHistory,
  filterSessionTitles,
  searchableMessageText,
} from '../../../src/services/chat/historySearch.js'
import { setLocale, setThemePreference, useSettings } from '../../../src/services/settings.js'
import '../../../src/app/theme.css'
import '../../../src/app/global.css'

const SCALE_TIME = Date.parse('2026-11-22T00:00:00Z')
const SCALE_FILLER =
  '用于检索规模回归的中文与 English 混排段落，包含数字 12345、标识符 getMessageUsage 和标点。'
const buildScaleSessions = (count = 1000) =>
  Array.from({ length: count }, (_, n) => {
    const label = String(n).padStart(4, '0')
    const id = `scale-list-${label}`
    const createdAt = SCALE_TIME - n * 60_000
    const userId = `${id}-u0`
    const assistantId = `${id}-a0`
    return {
      id,
      title: `Scale list-${label}`,
      createdAt,
      updatedAt: createdAt,
      rootMessageId: userId,
      messages: [
        {
          id: userId,
          role: 'user',
          content: `问题 0：${SCALE_FILLER}`,
          files: [],
          createdAt,
          parentId: null,
          selectedChildId: assistantId,
        },
        {
          id: assistantId,
          role: 'assistant',
          createdAt: createdAt + 1000,
          model: 'deepseek-flash',
          thinking: false,
          search: false,
          prefix: true,
          status: 'done',
          blocks: [{ type: 'text', text: `第 0 轮。\n\n${Array(6).fill(SCALE_FILLER).join('\n\n')}` }],
          stopReason: 'end_turn',
          parentId: userId,
        },
      ],
    }
  })

setupTheme()
const user = (id, parentId, content = '普通问题', selectedChildId) => ({
  id,
  role: 'user',
  content,
  files: [],
  createdAt: 1,
  parentId,
  selectedChildId,
})
const answer = (id, parentId, text = '普通回答', selectedChildId) => ({
  id,
  role: 'assistant',
  model: null,
  prefix: false,
  status: 'done',
  blocks: [{ type: 'text', text }],
  createdAt: 1,
  parentId,
  selectedChildId,
})
const deep = () => {
  const messages = [
    user('root', null, '主路径问题', 'visible'),
    answer('visible', 'root', '主路径回答'),
    answer('alt', 'root', '分支回答', 'deep-user'),
    user('deep-user', 'alt', '未选分支', 'lead-0'),
  ]
  for (let i = 0; i < 32; i++) {
    messages.push(
      i % 2
        ? answer(
            `lead-${i}`,
            `lead-${i - 1}`,
            '屏外代码\n\n```ts\nconst farAway = 1\n```\n\n' + '保持正文可读。'.repeat(100),
            i === 31 ? 'target-user' : `lead-${i + 1}`
          )
        : user(
            `lead-${i}`,
            i ? `lead-${i - 1}` : 'deep-user',
            '上文问题'.repeat(70),
            `lead-${i + 1}`
          )
    )
  }
  messages.push(
    user('target-user', 'lead-31', '搜索命中问题 needle needle', 'target-answer'),
    answer(
      'target-answer',
      'target-user',
      'needle 最终答案\n\n```ts\nconst targetValue = 1\n```\n\n$$\nx^2 + y^2 = 1\n$$\n\n```mermaid\nflowchart LR\nA --> B\n```',
      'tail-0'
    )
  )
  for (let i = 0; i < 32; i++) {
    messages.push(
      i % 2
        ? answer(
            `tail-${i}`,
            `tail-${i - 1}`,
            '后续屏外内容。'.repeat(160) + '\n\n```ts\nconst tailValue = 1\n```',
            i === 31 ? undefined : `tail-${i + 1}`
          )
        : user(
            `tail-${i}`,
            i ? `tail-${i - 1}` : 'target-answer',
            '后续问题。'.repeat(60),
            `tail-${i + 1}`
          )
    )
  }
  return {
    id: 'deep',
    title: '中文 Deep Branch',
    createdAt: 1,
    updatedAt: 10,
    rootMessageId: 'root',
    messages,
  }
}
let sessionReads = 0
let failReads = false
const get = IDBObjectStore.prototype.get
IDBObjectStore.prototype.get = function (...args) {
  if (this.name === 'sessions') {
    sessionReads++
    if (failReads) throw new DOMException('Fixture read failure', 'UnknownError')
  }
  return get.apply(this, args)
}
let data = []
const seed = async (scale = false) => {
  failReads = false
  closeSettings()
  closeMobileSider()
  closeHistorySearch()
  useHistorySearch.setState({ mode: 'title' })
  setLocale('zh-CN')
  setThemePreference('light')
  useSettings.setState({ apiKey: null })
  data = scale
    ? buildScaleSessions()
    : [
        deep(),
        {
          id: 'other',
          title: 'English HISTORY',
          createdAt: 1,
          updatedAt: 2,
          messages: [user('other-user', null, '另一条唯一内容 unique')],
        },
      ]
  await replaceHistory(async () => {
    for (const session of data) await addStagingSession(session)
  })
  sessionReads = 0
}
window.c3 = {
  async interrupted(status = 'streaming') {
    const session = deep()
    session.messages[0].selectedChildId = 'alt'
    const hit = session.messages.find((message) => message.id === 'target-answer')
    hit.status = status
    hit.blocks = [{ type: 'text', text: 'interruptedSavedToken' }]
    await replaceHistory(async () => {
      await addStagingSession(session)
    })
  },
  token(text) {
    useChatStore.setState((state) => ({
      sessionCache: {
        ...state.sessionCache,
        deep: {
          ...state.sessionCache.deep,
          messages: state.sessionCache.deep.messages.map((message) =>
            message.id === 'target-answer'
              ? { ...message, blocks: [{ type: 'text', text }] }
              : message
          ),
        },
      },
    }))
  },
  failReads: (value) => {
    failReads = value
  },
  seed,
  openMobileSider,
  closeTopModal,
  setLocale,
  selectSession,
  removeSession,
  stopReply,
  get reads() {
    return sessionReads
  },
  state: () => useChatStore.getState(),
  query(query, mode = 'body') {
    useHistorySearch.setState({ query, mode })
  },
  async replace() {
    await replaceHistory(async () => {
      await addStagingSession({ ...data[0], messages: [], rootMessageId: null })
    })
  },
  stream(active = true) {
    const session = deep()
    const hit = session.messages.find((message) => message.id === 'target-answer')
    hit.status = active ? 'streaming' : 'done'
    hit.blocks = [{ type: 'text', text: 'freshTokenResult' }]
    useChatStore.setState({
      sessionCache: { deep: session },
      streaming: active ? { deep: new AbortController() } : {},
    })
  },
  async update(text) {
    const session = {
      ...data[1],
      messages: [user('other-user', null, text)],
      updatedAt: Date.now(),
    }
    await saveSession(session)
    useChatStore.setState((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === session.id ? { ...s, updatedAt: session.updatedAt } : s
      ),
    }))
  },
  async scale() {
    const titles = []
    for (let i = 0; i < 10; i++) {
      const start = performance.now()
      filterSessionTitles(data, '999')
      titles.push(performance.now() - start)
    }
    const reports = [],
      reads = sessionReads
    const start = performance.now()
    const { loadSession } = await import('../../../src/services/chat/db.js')
    const result = await scanHistory({
      summaries: data,
      query: 'getMessageUsage',
      signal: new AbortController().signal,
      load: loadSession,
      onProgress: (progress) => {
        reports.push({
          ms: performance.now() - start,
          scanned: progress.scanned,
          total: progress.total,
        })
      },
    })
    return {
      titles,
      elapsedMs: performance.now() - start,
      firstMs: reports[0]?.ms,
      reports,
      reads: sessionReads - reads,
      sessions: data.length,
      messages: result.messages,
      textUnits: result.textUnits,
      textBytes: data.reduce(
        (n, s) =>
          n +
          s.messages.reduce(
            (m, message) => m + new TextEncoder().encode(searchableMessageText(message)).length,
            0
          ),
        0
      ),
      resultTotal: result.total,
      shown: result.hits.length,
      cacheSize: Object.keys(useChatStore.getState().sessionCache).length,
    }
  },
}
createRoot(document.getElementById('root')!).render(<App />)
