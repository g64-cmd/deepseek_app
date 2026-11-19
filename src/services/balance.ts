import { create } from 'zustand'
import { ApiError, fetchBalance } from './api/client.js'
import type { UserBalance } from './api/types.js'
import { useSettings } from './settings.js'

const CACHE_KEY = 'chat-demo:balance'
/** 缓存超过该时长后，打开账户面板时自动刷新 */
const STALE_AFTER = 5 * 60 * 1000

type BalanceState = {
  data: UserBalance | null
  fetchedAt: number | null
  loading: boolean
  /** 最近一次刷新失败的原因分类；null 表示无错误（含从未刷新） */
  error: 'network' | 'unauthorized' | 'other' | null
}

export const useBalance = create<BalanceState>(() => ({
  data: null,
  fetchedAt: null,
  loading: false,
  error: null,
}))

const readCache = (): { data: UserBalance; fetchedAt: number } | null => {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as { data?: unknown; fetchedAt?: unknown }
    if (
      typeof parsed.fetchedAt !== 'number' ||
      typeof parsed.data !== 'object' ||
      parsed.data === null
    ) {
      return null
    }
    return { data: parsed.data as UserBalance, fetchedAt: parsed.fetchedAt }
  } catch {
    return null
  }
}

const writeCache = (data: UserBalance, fetchedAt: number) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, fetchedAt }))
  } catch {
    // 存储不可用时仅内存生效
  }
}

const clearCache = () => {
  useBalance.setState({ data: null, fetchedAt: null, error: null })
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    // 忽略
  }
}

/**
 * 打开账户面板时调用：无缓存或缓存超过 5 分钟时自动刷新；
 * 没有并发去重（面板打开频率低，重复请求无害且不产生费用）。
 */
export const ensureBalance = (): void => {
  const { apiKey } = useSettings.getState()
  if (!apiKey || useBalance.getState().loading) {
    return
  }
  const cached = readCache()
  if (cached && Date.now() - cached.fetchedAt < STALE_AFTER) {
    if (!useBalance.getState().data) {
      useBalance.setState({ data: cached.data, fetchedAt: cached.fetchedAt, error: null })
    }
    return
  }
  void refreshBalance()
}

export const refreshBalance = async (): Promise<void> => {
  const { apiKey } = useSettings.getState()
  if (!apiKey) {
    return
  }
  useBalance.setState({ loading: true })
  try {
    const data = await fetchBalance(apiKey)
    const fetchedAt = Date.now()
    writeCache(data, fetchedAt)
    useBalance.setState({ data, fetchedAt, loading: false, error: null })
  } catch (error) {
    const reason =
      error instanceof ApiError
        ? error.status === 401
          ? 'unauthorized'
          : error.kind === 'network'
            ? 'network'
            : 'other'
        : 'other'
    useBalance.setState((state) => ({ loading: false, error: reason, fetchedAt: state.fetchedAt }))
  }
}

/** 聊天返回 402 时把缓存标记为过期，下次打开面板即自动刷新；不主动拉取 */
export const markBalanceStale = (): void => {
  const cached = readCache()
  if (cached) {
    writeCache(cached.data, 0)
  }
}

// 更换或清除 API Key 后旧余额不再有意义
useSettings.subscribe((state, previous) => {
  if (state.apiKey !== previous.apiKey) {
    clearCache()
  }
})
