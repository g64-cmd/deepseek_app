import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { ApiError, streamMessage } from '../api/client.js'
import type { ChatModel, CreateMessageRequest } from '../api/types.js'
import {
  classifyApiError,
  extractFileIds,
  getFileErrorCode,
  isRetryableApiError,
} from '../api/errors.js'
import {
  cancelUpload,
  checkImageFileIds,
  describeUploadError,
  getUploadPurpose,
  hasPendingUpload,
  isParseBilledPurpose,
  reuseUpload,
  uploadAttachment,
  useUploads,
} from '../attachments.js'
import { markBalanceStale } from '../balance.js'
import { supportsVision } from '../models.js'
import { bumpUsageRevision } from '../usage.js'
import { useSettings } from '../settings.js'
import { showToast } from '../../components/base/toastState.js'
import {
  appendBranch,
  getVisibleMessages,
  normalizeSession,
  selectVersion,
  selectMessagePath,
} from './branches.js'
import * as db from './db.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import {
  applyEvent,
  canContinueReply,
  countDocumentBlocks,
  countRequestDocuments,
  getContextRounds,
  MAX_REQUEST_DOCUMENTS,
  settleReply,
  toRequestMessages,
} from './reply.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/** 所有生成请求统一携带的助手身份说明 */
const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/** 安全审核固定开启，所有请求都走扩展模式 */
const SAFETY_CHECK = { level: 'high' } as const
/** 服务端判定 file_id 失效后，重新补传并重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000

/** 阅读链接始终开启，智能搜索开关控制是否另行声明搜索工具（含边想边搜）。 */
const serverTools = (search: boolean): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
const titleRequests = new Set<AbortController>()

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 一次性的检索定位请求；不持久化、不改变对话正文。 */
  messageTarget: {
    sessionId: string
    messageId: string
    token: symbol
    signal?: AbortSignal
  } | null
  /** 仅详情加载恢复了中断回答时失效检索，不随流式 token 增长。 */
  historySearchRevision: number
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  messageTarget: null,
  historySearchRevision: 0,
  streaming: {},
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
/** 导出开始时复制待保存原件的索引；Blob 不可变，后续保存成功释放索引不会影响该快照。 */
export const getPendingFileSnapshot = (): Map<string, Blob> =>
  new Map(
    [...pendingFiles.values()].flatMap((files) => files.map(({ id, blob }) => [id, blob] as const))
  )

const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
type RenameState = { committedTitle: string; latest: symbol; pending: number }
const sessionRenames = new Map<string, RenameState>()
const renameTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
let accessSequence = 0
let historyEpoch = 0
let navigationSequence = 0
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

/**
 * 保存会话到 IndexedDB；失败时标记保存失败供重试。
 * 每次有效提交成功统一失效用量缓存，不另存“待保存用量”标记：旧快照无法消费
 * 后来生成的用量状态，失败后经任意入口重试成功都会失效。重算仍由统计查询触发。
 */
const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId) || sessionRenames.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    void db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || deletingSessions.has(sessionId) || !getSession(sessionId)) {
          return
        }
        bumpUsageRevision()
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

/** 重试失败的保存；提交成功后由 persist 统一失效用量缓存。 */
export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 按当前开关创建回复：模型与思考配置逐条快照，智能搜索控制 deepseek_web_search。 */
const createReply = (): AssistantMessage => {
  const { thinking, search, model, thinkingEffort } = useSettings.getState()
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model,
    thinking,
    effort: thinking ? thinkingEffort : undefined,
    search,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
}

/** 生成被拦截的原因；调用方负责向用户解释 */
export type GenerationBlocked = 'modelNoVision' | 'docLimit'

/** 最终请求将引用的文档数超过官方上限（20 个）时不允许发出，先拦截在新增付费上传之前 */
const blockedByDocLimit = (history: Message[], question: UserMessage): boolean =>
  countRequestDocuments(history, question, true) > MAX_REQUEST_DOCUMENTS

/** 请求实际携带的图片附件数（提问自身 + 上下文轮次），与 prepareFiles 的上下文规则同源 */
const countRequestImages = (history: Message[], question: UserMessage): number => {
  let count = question.files.filter((file) => file.isImage).length
  for (const [user] of getContextRounds(history)) {
    count += user.files.filter((file) => file.isImage).length
  }
  return count
}

/** model 不支持图片输入而请求携带了图片时不允许静默丢图，直接拦截本次生成 */
const blockedByModelVision = (
  model: ChatModel,
  history: Message[],
  question: UserMessage
): boolean => !supportsVision(model) && countRequestImages(history, question) > 0

/** 新提问时将随上下文携带的历史图片数（不含草稿附件）；发送前 UI 据此做模型能力预检 */
export const countContextImages = (sessionId: string | null): number => {
  const session = sessionId === null ? null : getSession(sessionId)
  if (!session) {
    return 0
  }
  let count = 0
  for (const [user] of getContextRounds(getVisibleMessages(session))) {
    count += user.files.filter((file) => file.isImage).length
  }
  return count
}

/** 新提问时将随上下文携带的历史文档数（不含草稿附件）；发送前 UI 据此做文档数预检 */
export const countContextDocuments = (sessionId: string | null): number => {
  const session = sessionId === null ? null : getSession(sessionId)
  if (!session) {
    return 0
  }
  let count = 0
  for (const [user] of getContextRounds(getVisibleMessages(session))) {
    count += user.files.filter((file) => !file.isImage).length
  }
  return count
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

/** 搜索沿用普通加载的中断恢复语义；只返回单个快照，不写库或灌入详情缓存。 */
export const loadSessionForSearch = async (id: string): Promise<Session | undefined> => {
  const stored = getSession(id) ?? (await db.loadSession(id))
  const session = getSession(id) ?? stored
  return session && !getStreamController(id) ? settleInterrupted(session) : session
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        set({ ready: true, sessions: sortSessions(summaries) })
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const normalized = normalizeSession(stored)
      const settled = settleInterrupted(normalized)
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const session = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
      touchSession(id)
      set((state) => ({
        sessionCache: { ...state.sessionCache, [id]: session },
        historySearchRevision: state.historySearchRevision + (settled !== normalized ? 1 : 0),
      }))
      if (session !== stored) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 * 返回提交后的会话数与 write 的结果（如完整备份携带的应用设置）。
 */
export const replaceHistory = async <T>(
  write: () => Promise<T>
): Promise<{ result: T; count: number }> => {
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  navigationSequence++
  set({ messageTarget: null })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    // 等在途重命名结算，替换失败时也不会留下无法再回滚的旧乐观标题。
    await Promise.all(renameTasks)
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    await db.clearStaging()
    let summaries: SessionSummary[]
    let result: T
    try {
      result = await write()
      summaries = await db.commitStaging()
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    sessionRenames.clear()
    clearAllDrafts()
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId: null,
    })
    // 导入/清空替换了全部会话；数量与最近更新时间可能碰巧不变，靠修订号使用量缓存失效
    bumpUsageRevision()
    return { result, count: summaries.length }
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    navigationSequence++
    set({ activeId: null, messageTarget: null })
    trimSessionCache()
  }
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    navigationSequence++
    touchSession(id)
    set({ activeId: id, messageTarget: null })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

/** 取消/消费一次定位，旧完成回调不能清除后来建立的目标。 */
export const clearMessageTarget = (token?: symbol) => {
  const target = get().messageTarget
  if (target && (token === undefined || target.token === token)) {
    set({ messageTarget: null })
  }
}

/** 打开正文命中前重新读取并验证；异步旧结果不能覆盖后来的选择、删除或导入。 */
export const openHistoryHit = async (
  sessionId: string,
  messageId: string,
  signal?: AbortSignal
): Promise<'ok' | 'busy' | 'missing' | 'failed' | 'cancelled'> => {
  if (signal?.aborted) {
    return 'cancelled'
  }
  clearMessageTarget()
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return 'busy'
  }
  if (getStreamController(sessionId)) {
    return 'busy'
  }
  const sequence = ++navigationSequence
  const epoch = historyEpoch
  let stored: Session | undefined
  try {
    stored = getSession(sessionId) ?? (await db.loadSession(sessionId))
  } catch (error) {
    if (signal?.aborted || sequence !== navigationSequence || epoch !== historyEpoch) {
      return 'cancelled'
    }
    db.reportStorageError('open history search result')(error)
    return 'failed'
  }
  if (
    signal?.aborted ||
    sequence !== navigationSequence ||
    epoch !== historyEpoch ||
    get().importingHistory
  ) {
    return 'cancelled'
  }
  if (getStreamController(sessionId) || deletingSessions.has(sessionId)) {
    return 'busy'
  }
  const summary = get().sessions.find((item) => item.id === sessionId)
  // 优先使用读取期间产生的新内存版本，不能把旧详情覆盖到新消息上。
  const current = getSession(sessionId) ?? stored
  if (!summary || !current) {
    return 'missing'
  }
  const normalized = normalizeSession(current)
  const settled = settleInterrupted(normalized)
  const session = selectMessagePath(settled, messageId)
  if (!session) {
    return 'missing'
  }
  touchSession(sessionId)
  set((state) => ({
    activeId: sessionId,
    sessionCache: {
      ...state.sessionCache,
      [sessionId]: { ...session, ...toSessionSummary(summary) },
    },
    messageTarget: { sessionId, messageId, token: Symbol(), signal },
    historySearchRevision: state.historySearchRevision + (settled !== normalized ? 1 : 0),
  }))
  if (session !== current) {
    persist(sessionId)
  }
  trimSessionCache()
  return 'ok'
}

/** 重命名；返回是否成功——已加载分支的保存失败由保存失败红条体系提示，这里恒成功 */
export const renameSession = (id: string, title: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return Promise.resolve(false)
  }
  const controller = getStreamController(id)
  if (controller) {
    titleRequests.delete(controller)
  }
  if (getSession(id)) {
    // 已加载会话的新操作接管标题状态；较早的列表重命名回调不再拥有回滚权。
    sessionRenames.delete(id)
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
    return Promise.resolve(true)
  }
  const previous = get().sessions.find((session) => session.id === id)?.title
  if (previous === undefined) {
    return Promise.resolve(false)
  }
  const epoch = historyEpoch
  const operation = Symbol()
  const rename = sessionRenames.get(id) ?? {
    committedTitle: previous,
    latest: operation,
    pending: 0,
  }
  rename.latest = operation
  rename.pending += 1
  sessionRenames.set(id, rename)
  const ownsState = () =>
    epoch === historyEpoch &&
    sessionRenames.get(id) === rename &&
    get().sessions.some((session) => session.id === id)
  const restoreTitle = (value: string) => {
    // 详情可能在请求期间加载；列表和已加载详情必须一起恢复。
    updateSession(id, (session) => ({ ...session, title: value }))
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title: value } : session
      ),
    }))
  }
  set((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === id ? { ...session, title } : session
    ),
  }))
  const task = db
    .renameSession(id, title)
    .then(
      () => {
        if (ownsState()) {
          // IndexedDB 按发起顺序提交；后续失败回退到最后成功标题，不能退到失败的乐观值。
          rename.committedTitle = title
        }
        return true
      },
      (error: unknown) => {
        if (ownsState() && rename.latest === operation) {
          restoreTitle(rename.committedTitle)
        }
        db.reportStorageError('rename session')(error)
        return false
      }
    )
    .finally(() => {
      rename.pending -= 1
      if (rename.pending === 0 && sessionRenames.get(id) === rename) {
        sessionRenames.delete(id)
        // 期间加载的详情可能需要保存中断状态，等标题结算后再提交，避免写入失败的乐观名。
        if (epoch === historyEpoch && getSession(id) && !get().importingHistory) {
          persist(id)
        }
      }
      renameTasks.delete(task)
    })
  renameTasks.add(task)
  return task
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    sessionRenames.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    bumpUsageRevision()
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (
  targetSessionId: string | null,
  options?: { dropHistoryImages?: boolean }
) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(getDraft(targetSessionId), useUploads.getState().tasks)
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  if (files.filter((file) => !file.isImage).length > MAX_REQUEST_DOCUMENTS) {
    showToast({ key: 'docLimitBlocked', type: 'error' })
    return false
  }
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType, purpose }) => ({
      id,
      serverId,
      // 草稿附件已上传成功，每张图片都在上传前检查过长边，超限的已缩小。
      imageSizeChecked: isImage,
      name,
      size,
      isImage,
      mimeType,
      purpose,
    })),
    createdAt: now,
  }
  if (blockedByDocLimit(history, question)) {
    showToast({
      key: 'replyDocLimit',
      params: { count: countRequestDocuments(history, question) },
      type: 'error',
    })
    return false
  }
  const reply = createReply()
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob }) => ({ id, blob })),
    ])
  }
  persist(sessionId)
  clearSentDraft(targetSessionId)
  void streamReply(sessionId, reply, {
    history,
    question,
    dropHistoryImages: options?.dropHistoryImages,
  })
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (
  sessionId: string,
  messageId?: string
): GenerationBlocked | undefined => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return undefined
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return undefined
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return undefined
  }
  const history = path.slice(0, index - 1)
  if (blockedByModelVision(useSettings.getState().model, history, question)) {
    return 'modelNoVision'
  }
  if (blockedByDocLimit(history, question)) {
    return 'docLimit'
  }
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question })
  return undefined
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (
  sessionId: string,
  messageId: string,
  content: string
): boolean | GenerationBlocked => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  if (blockedByModelVision(useSettings.getState().model, path.slice(0, index), question)) {
    return 'modelNoVision'
  }
  if (blockedByDocLimit(path.slice(0, index), question)) {
    return 'docLimit'
  }
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  navigationSequence++
  set({ messageTarget: null })
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (
  sessionId: string,
  messageId: string
): GenerationBlocked | undefined => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return undefined
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return undefined
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return undefined
  }
  const { thinking, search, model, thinkingEffort } = useSettings.getState()
  if (blockedByModelVision(previous.model ?? model, path.slice(0, -2), question)) {
    return 'modelNoVision'
  }
  if (blockedByDocLimit(path.slice(0, -2), question)) {
    return 'docLimit'
  }
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用当前模型和开关。
    model: previous.model ?? model,
    thinking: previous.thinking ?? thinking,
    effort: previous.effort ?? ((previous.thinking ?? thinking) ? thinkingEffort : undefined),
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
  return undefined
}

/** 附件补传失败或文档失效后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (
  sessionId: string,
  messageId: string,
  options?: { reparse?: boolean; omitMissing?: boolean }
) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  let question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    !['upload', 'reparse', 'contextMissing'].includes(previous.error?.kind ?? '')
  ) {
    return
  }
  // 只有明确的重新解析入口可授权付费；普通重试与重新生成不能绕过它。
  if (previous.error?.kind === 'reparse' && !options?.reparse) {
    return
  }
  const authorized = new Set(previous.error?.kind === 'reparse' ? previous.error.fileIds : [])
  const omitted = new Set([
    ...(previous.omittedFileIds ?? []),
    ...(options?.omitMissing && previous.error?.kind === 'contextMissing'
      ? (previous.error.fileIds ?? [])
      : []),
  ])
  if (previous.error?.kind === 'reparse') {
    // 只撤销错误发生时的旧 ID。导入提示的 null、新成功 ID 和进行中任务都不能被旧提示清掉。
    const stale = new Map(previous.error.reparseFiles?.map((file) => [file.id, file.serverId]))
    if (stale.size > 0) {
      const messages = session.messages.map((message) =>
        message.role === 'user' && message.files.some((file) => stale.has(file.id))
          ? {
              ...message,
              files: message.files.map((file) => {
                const failedId = stale.get(file.id)
                if (!failedId || file.serverId !== failedId) {
                  return file
                }
                const task = useUploads.getState().tasks[file.id]
                return {
                  ...file,
                  serverId:
                    task?.status === 'done' && task.serverId !== failedId ? task.serverId : null,
                }
              }),
            }
          : message
      )
      updateSession(sessionId, (current) => ({ ...current, messages }))
      for (const [id, failedId] of stale) {
        const task = useUploads.getState().tasks[id]
        if (
          failedId &&
          task?.status === 'done' &&
          task.serverId === failedId &&
          !hasPendingUpload(id)
        ) {
          cancelUpload(id)
        }
      }
      persist(sessionId)
      question =
        messages.find(
          (message): message is UserMessage => message.id === question.id && message.role === 'user'
        ) ?? question
    }
  }
  // 回读刚刚清除 ID 的历史，避免把旧的请求快照再次写回。
  const history = getVisibleMessages(getSession(sessionId) ?? session).slice(0, index - 1)
  const nextRequest = stripRequest({
    history,
    question,
    authorized,
    omitted,
    prefix: previous.blocks.length > 0 ? previous : undefined,
  })
  if (blockedByDocLimit(nextRequest.history, nextRequest.question)) {
    // 上下文在等待重试期间增长到超限时不再发出请求，直接按超限收尾
    updateReply(sessionId, {
      ...previous,
      error: {
        kind: 'docLimit',
        message: '',
        localMessage: {
          key: 'replyDocLimit',
          params: { count: countRequestDocuments(path.slice(0, index - 1), question) },
        },
      },
    })
    persist(sessionId)
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, nextRequest)
}

type Request = {
  history: Message[]
  question: UserMessage
  prefix?: AssistantMessage
  /** 当前模型不支持图片时丢弃上下文历史里的图片附件（提问自身的图片由发送前 UI 处理） */
  dropHistoryImages?: boolean
  /** 本次明确授权重新上传解析的本地附件 ID，不持久化授权。 */
  authorized?: ReadonlySet<string>
  /** 用户明确同意本次省略的附件，原会话元数据保持完整。 */
  omitted?: ReadonlySet<string>
}

/** dropHistoryImages 时剔除上下文历史 user 消息里的图片附件（文档附件保留） */
const stripHistoryImages = (message: Message): Message =>
  message.role === 'user'
    ? { ...message, files: message.files.filter((file) => !file.isImage) }
    : message

/** 请求级图片剔除策略：任何从会话重新取回消息的位置（刷新、补齐后回读）都必须再次应用 */
const stripRequest = (request: Request): Request => {
  const omit = <T extends Message>(message: T): T =>
    message.role === 'user'
      ? { ...message, files: message.files.filter((file) => !request.omitted?.has(file.id)) }
      : message
  return {
    ...request,
    history: request.history.map((message) =>
      omit(request.dropHistoryImages ? stripHistoryImages(message) : message)
    ),
    question: omit(request.question),
  }
}

class AttachmentConsentError extends Error {
  constructor(
    readonly kind: 'reparse' | 'contextMissing',
    readonly files: FileAttachment[]
  ) {
    super(files.map((file) => file.name).join('、'))
  }
}

class DocumentLimitError extends Error {
  constructor(readonly count: number) {
    super('Request document limit exceeded')
  }
}

/**
 * 将 serverId 写回所有引用同一附件的消息。传入 null 会清除超限旧图的 ID，触发补传。
 * 尺寸标记随有效 ID 保存，因为本地保留的是原图，刷新后可以直接复用已检查的上传副本。
 */
const saveServerIds = (sessionId: string, serverIds: ReadonlyMap<string, string | null>) => {
  if (serverIds.size === 0) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) => {
              const serverId = serverIds.get(file.id)
              return serverId === undefined
                ? file
                : { ...file, serverId, imageSizeChecked: file.isImage && serverId !== null }
            }),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 * 补传沿用附件保存的解析方式；旧数据缺省时按扩展名推导（版面文档为图文混排）。
 */
const ensureServerId = async (
  apiKey: string,
  file: FileAttachment,
  signal: AbortSignal,
  authorized?: ReadonlySet<string>
): Promise<string | null> => {
  signal.throwIfAborted()
  if (file.serverId) {
    return file.serverId
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done') {
    return task.serverId
  }
  const existing = reuseUpload(file.id, signal)
  if (existing) {
    return existing
  }
  const blob = await db.loadFile(file.id)
  signal.throwIfAborted()
  if (!blob) {
    return null
  }
  // 预检后其他使用方可能取消或完成任务，读原件之后也必须重新检查。
  const completed = useUploads.getState().tasks[file.id]
  if (completed?.status === 'done') {
    return completed.serverId
  }
  const pendingUpload = reuseUpload(file.id, signal)
  if (pendingUpload) {
    return pendingUpload
  }
  if (
    isParseBilledPurpose(file.purpose ?? getUploadPurpose(file.name, file.isImage)) &&
    !authorized?.has(file.id)
  ) {
    throw new AttachmentConsentError('reparse', [file])
  }
  return uploadAttachment(
    apiKey,
    file.id,
    blob,
    file.name,
    file.purpose ?? getUploadPurpose(file.name, file.isImage),
    signal
  )
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新。
 * 从会话取回的是原始消息，图片剔除策略在这里重新应用。 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return stripRequest({
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
    dropHistoryImages: request.dropHistoryImages,
    authorized: request.authorized,
    omitted: request.omitted,
  })
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 缺原件或需要付费解析的附件先暂停，交给用户明确选择，不开始其他补传；
 * - 历史附件从最新轮次往前补传；失败汇总返回（dropped），调用方暂停聊天而不是静默省略。
 */
const prepareFiles = async (
  sessionId: string,
  request: Request,
  signal: AbortSignal
): Promise<{ request: Request; dropped: FileAttachment[] }> => {
  const epoch = historyEpoch
  const isCurrent = () =>
    epoch === historyEpoch && !deletingSessions.has(sessionId) && !!getSession(sessionId)
  const assertCurrent = () => {
    signal.throwIfAborted()
    if (!isCurrent()) {
      throw new DOMException('Session changed while preparing attachments', 'AbortError')
    }
  }
  assertCurrent()
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。替换回的是会话原始消息，图片剔除重新应用。
  request = refreshRequest(sessionId, request)
  const apiKey = useSettings.getState().apiKey ?? ''
  const serverIds = new Map<string, string>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  // 旧图片超限时先清除 ID，交给下方已有的附件补传流程。
  const files = [
    ...request.question.files,
    ...getContextRounds(request.history).flatMap(([user]) => user.files),
  ]
  // 先完整预检，再开始补传。导入原件、清掉 ID 的旧文档同样可能再次收费。
  const missing: FileAttachment[] = []
  const paid: FileAttachment[] = []
  for (const file of new Map(files.map((file) => [file.id, file])).values()) {
    if (
      file.serverId ||
      useUploads.getState().tasks[file.id]?.status === 'done' ||
      hasPendingUpload(file.id)
    ) {
      continue
    }
    const blob = await Promise.race([db.loadFile(file.id), aborted])
    assertCurrent()
    if (!blob) {
      missing.push(file)
    } else if (
      isParseBilledPurpose(file.purpose ?? getUploadPurpose(file.name, file.isImage)) &&
      !request.authorized?.has(file.id)
    ) {
      paid.push(file)
    }
  }
  if (missing.length) {
    throw new AttachmentConsentError('contextMissing', missing)
  }
  const documents = countRequestDocuments(request.history, request.question)
  if (documents > MAX_REQUEST_DOCUMENTS) {
    throw new DocumentLimitError(documents)
  }
  if (paid.length) {
    throw new AttachmentConsentError('reparse', paid)
  }
  const checked = await Promise.race([checkImageFileIds(files, signal), aborted])
  assertCurrent()
  if (checked.size > 0) {
    saveServerIds(sessionId, checked)
    request = refreshRequest(sessionId, request)
  }
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      const serverId = await ensureServerId(apiKey, file, signal, request.authorized)
      if (serverId && serverId !== file.serverId) {
        serverIds.set(file.id, serverId)
        // 每个成功结果立即保存，不等同批其他请求结束；停止后的迟到结果也可复用。
        if (isCurrent()) {
          saveServerIds(sessionId, new Map([[file.id, serverId]]))
        }
      }
    })
  )
  const results = await Promise.race([uploads, aborted])
  assertCurrent()
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  const pending = new Map<string, FileAttachment>()
  for (const [user] of getContextRounds(request.history).toReversed()) {
    for (const file of user.files) {
      if (!file.serverId && !serverIds.has(file.id) && !pending.has(file.id)) {
        pending.set(file.id, file)
      }
    }
  }
  const dropped: FileAttachment[] = []
  for (const file of pending.values()) {
    signal.throwIfAborted()
    try {
      const upload = ensureServerId(apiKey, file, signal, request.authorized).then((serverId) => {
        // 停止只阻止聊天重发。已经完成且仍属于当前会话的上传 ID 要落盘，避免下次重复解析。
        if (serverId && isCurrent()) {
          saveServerIds(sessionId, new Map([[file.id, serverId]]))
        }
        return serverId
      })
      const serverId = await Promise.race([upload, aborted])
      assertCurrent()
      if (serverId) {
        serverIds.set(file.id, serverId)
      } else {
        dropped.push(file)
      }
    } catch (error) {
      assertCurrent()
      if (error instanceof AttachmentConsentError) {
        throw error
      }
      dropped.push(file)
    }
  }

  // 用补齐后的会话重新取历史与提问，保证请求里都是 serverId；
  // resolve 同样取回会话原始消息（附件的 serverId 是新的），图片剔除再次应用
  const session = getSession(sessionId)
  const resolve = <T extends Message>(message: T): T =>
    (session?.messages.find((m) => m.id === message.id) as T | undefined) ?? message
  return {
    request: stripRequest({
      history: request.history.map(resolve),
      question: resolve(request.question),
      prefix: request.prefix,
      dropHistoryImages: request.dropHistoryImages,
      authorized: request.authorized,
      omitted: request.omitted,
    }),
    dropped,
  }
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 *
 * 版面解析文档的重新上传意味着再次按页计费，不能自动重试：这类附件保持失效的
 * serverId 不动，记入 parseStale 由调用方请求用户明确授权后（retryUpload）再清。
 */
const reuploadInvalidatedFiles = (
  sessionId: string,
  request: Request,
  error: unknown
): { retry: boolean; parseStale: FileAttachment[] } => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return { retry: false, parseStale: [] }
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets = mentioned.length > 0 ? new Set(mentioned) : collectServerFileIds(request)
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return { retry: false, parseStale: [] }
  }
  const localIds: string[] = []
  const parseStale: FileAttachment[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId)) {
        return file
      }
      if (isParseBilledPurpose(file.purpose ?? getUploadPurpose(file.name, file.isImage))) {
        // 保留失效的 serverId：任何后续请求都会再次失败并提示，直到用户明确授权重新解析
        if (!parseStale.some((item) => item.id === file.id)) {
          parseStale.push(file)
        }
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return { retry: false, parseStale }
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  // 有等待授权的解析文档时不自动重试，避免其余附件白白重传后再次失败
  return { retry: parseStale.length === 0, parseStale }
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const controller = new AbortController()
  if (!getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  navigationSequence++
  set((state) => ({
    messageTarget: null,
    streaming: { ...state.streaming, [sessionId]: controller },
  }))
  const omitted = new Set([
    ...(initial.omittedFileIds ?? []),
    ...(request.omitted ?? []),
    ...(request.dropHistoryImages
      ? getContextRounds(request.history).flatMap(([user]) =>
          user.files.filter((file) => file.isImage).map((file) => file.id)
        )
      : []),
  ])
  request = stripRequest({ ...request, omitted })
  let reply: AssistantMessage = { ...initial, omittedFileIds: [...omitted] }
  let frame = 0
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)

  try {
    for (let attempt = 0; ; attempt += 1) {
      /** 附件补齐前出错属于上传失败，请求还没有发出 */
      let preparing = true
      let receivedContent = false
      let sentRequest: Request | undefined
      try {
        const { request: prepared, dropped } = await prepareFiles(
          sessionId,
          request,
          controller.signal
        )
        controller.signal.throwIfAborted()
        if (dropped.length) {
          throw new AttachmentConsentError('contextMissing', dropped)
        }
        preparing = false
        // 附件就绪后获取本轮信息；续写沿用原回答快照，重新生成的快照独立保存。
        const latestReminder = prepared.prefix
          ? prepared.prefix.latestReminder
          : createLatestReminder(useSettings.getState())
        reply = { ...reply, latestReminder }
        updateReply(sessionId, reply)
        persist(sessionId)
        const messages = toRequestMessages(
          prepared.history,
          prepared.question,
          prepared.prefix,
          initial.thinking ?? false,
          latestReminder
        )
        // 最终请求守卫：按实际组装出的文档块数拦截，超限时请求不发出
        const documents = countDocumentBlocks(messages)
        if (documents > MAX_REQUEST_DOCUMENTS) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'docLimit',
            message: '',
            localMessage: { key: 'replyDocLimit', params: { count: documents } },
          })
          break
        }
        sentRequest = prepared
        const events = streamMessage(
          useSettings.getState().apiKey ?? '',
          {
            model: initial.model ?? useSettings.getState().model,
            system: SYSTEM_PROMPT,
            messages,
            thinking: { type: initial.thinking ? 'enabled' : 'disabled' },
            ...(initial.thinking && initial.effort
              ? { output_config: { effort: initial.effort } }
              : {}),
            safety_check: SAFETY_CHECK,
            tools: serverTools(initial.search ?? false),
            ...(titleRequests.has(controller) ? { title: { enabled: true } } : {}),
          },
          controller.signal
        )
        const blockIndexes = new Map<number, number>()
        for await (const event of events) {
          receivedContent ||= event.type === 'content_block_start'
          if (
            event.type === 'message_delta' &&
            (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
            event.delta.title?.trim() &&
            titleRequests.has(controller) &&
            !controller.signal.aborted &&
            !get().importingHistory
          ) {
            const title = event.delta.title.trim()
            updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
            titleRequests.delete(controller)
          }
          reply = applyEvent(reply, event, Date.now(), blockIndexes)
          if (document.visibilityState === 'hidden') {
            flush()
          } else {
            frame ||= requestAnimationFrame(flush)
          }
        }
        reply = settleReply(reply, 'done', Date.now())
        break
      } catch (error) {
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          break
        }
        if (preparing) {
          if (error instanceof DocumentLimitError) {
            reply = settleReply(reply, 'error', Date.now(), {
              kind: 'docLimit',
              message: '',
              localMessage: { key: 'replyDocLimit', params: { count: error.count } },
            })
            break
          }
          if (error instanceof AttachmentConsentError) {
            reply = settleReply(reply, 'error', Date.now(), {
              kind: error.kind,
              message: '',
              localMessage: {
                key: error.kind === 'reparse' ? 'replyFileExpiredReparse' : 'replyContextMissing',
                params: { count: error.files.length, names: error.message },
              },
              fileIds: error.files.map((file) => file.id),
              ...(error.kind === 'reparse'
                ? { reparseFiles: error.files.map(({ id, serverId }) => ({ id, serverId })) }
                : {}),
            })
            break
          }
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: describeUploadError(error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        // 附件失效：重新补传后重发。收到过内容块（含丢弃的客户端工具）后不自动重发。
        const invalidated = reuploadInvalidatedFiles(sessionId, sentRequest ?? request, error)
        if (invalidated.parseStale.length > 0) {
          // 失效附件里有按页计费的解析文档：等待用户明确授权重新解析，不自动重传
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'reparse',
            message: '',
            localMessage: {
              key: 'replyFileExpiredReparse',
              params: { count: invalidated.parseStale.length },
            },
            fileIds: invalidated.parseStale.map((file) => file.id),
            reparseFiles: invalidated.parseStale.map(({ id, serverId }) => ({ id, serverId })),
          })
          break
        }
        if (attempt < FILE_RETRY_LIMIT && !receivedContent && invalidated.retry) {
          await waitForRetry(attempt, controller.signal)
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settleReply(reply, 'done', Date.now())
        } else if (error instanceof ApiError) {
          if (classifyApiError(error) === 'insufficientBalance') {
            // 余额已不足以继续调用，账户面板里的旧余额不再可信
            markBalanceStale()
          }
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: error.localMessage,
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
  } finally {
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    cancelAnimationFrame(frame)
    updateReply(sessionId, reply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
  }
}
