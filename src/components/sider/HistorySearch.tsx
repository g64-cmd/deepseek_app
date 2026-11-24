import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import {
  clearMessageTarget,
  loadSessionForSearch,
  openHistoryHit,
  selectSession,
  useChatStore,
} from '../../services/chat/store.js'
import {
  closeHistorySearch,
  filterSessionTitles,
  scanHistory,
  SEARCH_DEBOUNCE_MS,
  SEARCH_RESULT_LIMIT,
  useHistorySearch,
  type HistoryHit,
} from '../../services/chat/historySearch.js'
import { registerFocusLayer } from '../base/modalStack.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './HistorySearch.module.css'

export const HistorySearch = () => {
  const t = useTranslate()
  const { query, mode } = useHistorySearch()
  const sessions = useChatStore((state) => state.sessions)
  const importing = useChatStore((state) => state.importingHistory)
  // streaming 的对象只在开始/结束时改变；不因每个 token 重启扫描。
  const streams = useChatStore((state) => state.streaming)
  const recoveryRevision = useChatStore((state) => state.historySearchRevision)
  const locating = useChatStore((state) => state.messageTarget !== null)
  const activeId = useChatStore((state) => state.activeId)
  // 只订阅非生成中的详情，版本选择会刷新分支标记，token 更新不会重算路径。
  const activeSession = useChatStore((state) =>
    state.activeId !== null && !Object.hasOwn(state.streaming, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const [result, setResult] = useState<{
    hits: HistoryHit[]
    total: number
    scanned: number
    missing: number
  }>({ hits: [], total: 0, scanned: 0, missing: 0 })
  const [phase, setPhase] = useState<'idle' | 'searching' | 'done' | 'error' | 'cancelled'>('idle')
  const [notice, setNotice] = useState<'historyBusy' | 'historyMissing' | 'historyFailed' | null>(
    null
  )
  const [opening, setOpening] = useState(false)
  const [retry, setRetry] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const scan = useRef<AbortController | null>(null)
  const request = useRef(0)
  const navigation = useRef<AbortController | null>(null)
  const abortUncommittedNavigation = () => {
    const pending = navigation.current
    // activeId 更新可先触发抽屉卸载，再恢复 openHit 的 await；已交给列表的请求不随卸载取消。
    if (pending && useChatStore.getState().messageTarget?.signal !== pending.signal) {
      pending.abort()
    }
  }
  const filtered = useMemo(() => filterSessionTitles(sessions, query), [sessions, query])
  const currentPaths = useMemo(() => {
    const cache = useChatStore.getState().sessionCache
    return new Map(
      [...new Set(result.hits.map((hit) => hit.sessionId))].flatMap((id) => {
        const session =
          activeSession?.id === id
            ? activeSession
            : Object.hasOwn(cache, id)
              ? cache[id]
              : undefined
        return session
          ? [[id, new Set(getVisibleMessages(session).map((message) => message.id))] as const]
          : []
      })
    )
  }, [result.hits, activeSession])
  const cancelNavigation = () => {
    navigation.current?.abort()
    navigation.current = null
    request.current++
    setOpening(false)
    clearMessageTarget()
  }
  const close = () => {
    scan.current?.abort()
    cancelNavigation()
    closeHistorySearch()
  }

  useLayoutEffect(() => {
    // 新查询、切换范围和重新打开检索，均接管尚未完成的消息定位。
    cancelNavigation()
  }, [query, mode])

  useEffect(() => {
    if (!root.current) {
      return
    }
    // passive effect 晚于移动抽屉的模态注册，返回先关闭检索，再关闭抽屉。
    return registerFocusLayer({
      root: root.current,
      modal: false,
      close,
      initialFocus: input.current,
      returnFocus: document.querySelector<HTMLElement>('[data-open-history-search]'),
    })
  }, [])

  useEffect(() => {
    request.current++
    abortUncommittedNavigation()
    setOpening(false)
    const controller = new AbortController()
    scan.current = controller
    setResult({ hits: [], total: 0, scanned: 0, missing: 0 })
    setNotice(null)
    setPhase(mode === 'body' && query.trim() && !importing ? 'searching' : 'idle')
    const timer = setTimeout(() => {
      if (mode !== 'body' || !query.trim() || importing) {
        return
      }
      void scanHistory({
        summaries: sessions,
        query,
        signal: controller.signal,
        load: loadSessionForSearch,
        onProgress: (progress) => {
          if (!controller.signal.aborted) {
            setResult(progress)
          }
        },
      })
        .then(() => {
          if (!controller.signal.aborted) {
            setPhase('done')
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setPhase('error')
          }
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
      abortUncommittedNavigation()
    }
  }, [sessions, query, mode, importing, streams, recoveryRevision, retry])

  useLayoutEffect(
    () => () => {
      request.current++
      abortUncommittedNavigation()
    },
    []
  )
  const openHit = async (hit: HistoryHit) => {
    const token = ++request.current
    navigation.current?.abort()
    const controller = new AbortController()
    navigation.current = controller
    setOpening(true)
    setNotice(null)
    const outcome = await openHistoryHit(hit.sessionId, hit.messageId, controller.signal)
    if (token !== request.current) {
      return
    }
    setOpening(false)
    if (outcome === 'ok') {
      // 定位交给消息列表持有；正常关闭移动抽屉不能把刚建立的目标当作旧 DB 请求取消。
      navigation.current = null
      closeMobileSider()
    } else if (outcome !== 'cancelled') {
      setNotice(
        outcome === 'busy'
          ? 'historyBusy'
          : outcome === 'missing'
            ? 'historyMissing'
            : 'historyFailed'
      )
    }
  }
  // 输入期间保持焦点；扫描进度至少间隔 250ms，不播报正文。
  const count = mode === 'title' ? filtered.length : result.total
  const status = importing
    ? t('historyImporting')
    : !query.trim()
      ? t('historyEnterQuery')
      : mode === 'title'
        ? t('historyTitleCount', { count })
        : phase === 'error'
          ? t('historyFailed')
          : phase === 'cancelled'
            ? t('historyCancelled')
            : phase === 'searching'
              ? t('historyScanning', { count, scanned: result.scanned, total: sessions.length })
              : t('historyBodyCount', { count })
  return (
    <div ref={root} className={styles.search} data-history-search data-history-phase={phase}>
      <div className={styles.heading}>
        <strong>{t('historySearch')}</strong>
        <button type="button" onClick={close} aria-label={t('historyClose')}>
          {t('close')}
        </button>
      </div>
      <label className={styles.field}>
        <span className="sr-only">{t('historyQuery')}</span>
        <input
          ref={input}
          type="search"
          maxLength={200}
          value={query}
          placeholder={t('historyQuery')}
          onChange={(event) => useHistorySearch.setState({ query: event.target.value })}
        />
      </label>
      <div className={styles.controls}>
        <label>
          {t('historyScope')}
          <select
            value={mode}
            onChange={(event) =>
              useHistorySearch.setState({ mode: event.target.value as 'title' | 'body' })
            }
          >
            <option value="title">{t('historyTitles')}</option>
            <option value="body">{t('historyBody')}</option>
          </select>
        </label>
        <button
          type="button"
          disabled={!query}
          onClick={() => {
            useHistorySearch.setState({ query: '' })
            input.current?.focus()
          }}
        >
          {t('historyClear')}
        </button>
      </div>
      {mode === 'body' ? <p className={styles.hint}>{t('historyBodyHint')}</p> : null}
      <div className={styles.status} role="status" aria-live="polite" aria-atomic="true">
        {notice ? t(notice) : status}
      </div>
      {(phase === 'searching' || opening || locating) && mode === 'body' ? (
        <button
          type="button"
          onClick={() => {
            scan.current?.abort()
            cancelNavigation()
            setPhase('cancelled')
          }}
        >
          {t('cancel')}
        </button>
      ) : null}
      {(phase === 'error' || phase === 'cancelled' || notice === 'historyMissing') &&
      mode === 'body' ? (
        <button type="button" onClick={() => setRetry((value) => value + 1)}>
          {t('retry')}
        </button>
      ) : null}
      {result.total > SEARCH_RESULT_LIMIT && mode === 'body' ? (
        <p className={styles.hint}>{t('historyLimit', { count: SEARCH_RESULT_LIMIT })}</p>
      ) : null}
      {result.missing > 0 && mode === 'body' ? (
        <p className={styles.hint}>{t('historySkipped', { count: result.missing })}</p>
      ) : null}
      <div
        className={styles.results}
        aria-label={t(mode === 'title' ? 'historyTitles' : 'historyBody')}
      >
        {!importing &&
          (mode === 'title'
            ? filtered.map((session) => (
                <button
                  type="button"
                  key={session.id}
                  data-history-title={session.id}
                  aria-current={activeId === session.id ? 'page' : undefined}
                  onClick={() => {
                    selectSession(session.id)
                    closeMobileSider()
                  }}
                >
                  {session.title || t('untitledChat')}
                </button>
              ))
            : result.hits.map((hit) => (
                <button
                  type="button"
                  key={`${hit.sessionId}/${hit.messageId}`}
                  data-history-hit={hit.messageId}
                  disabled={opening}
                  onClick={() => {
                    void openHit(hit)
                  }}
                >
                  <strong>{hit.title || t('untitledChat')}</strong>
                  <span className={styles.meta}>
                    {t(hit.role === 'user' ? 'userMessageLabel' : 'assistantMessageLabel')}
                    {(
                      currentPaths.has(hit.sessionId)
                        ? !currentPaths.get(hit.sessionId)?.has(hit.messageId)
                        : hit.otherBranch
                    )
                      ? ` · ${t('historyOtherBranch')}`
                      : ''}
                  </span>
                  <span>{hit.snippet}</span>
                </button>
              )))}
        {!importing && query.trim() && count === 0 && (mode === 'title' || phase === 'done') ? (
          <p>{t('historyEmpty')}</p>
        ) : null}
      </div>
    </div>
  )
}
