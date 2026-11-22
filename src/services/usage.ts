import type { MessageUsage } from './api/types.js'
import type { SessionSummary } from './chat/types.js'
import * as db from './chat/db.js'
import { getModelMeta } from './models.js'

const CACHE_KEY = 'chat-demo:usage-summary'
/** 搜索/抓取计费（元/千次，来源：docs/deepseek-api 快照 quick_start/pricing.md） */
const SEARCH_FEE_PER_1K = 5

export type ModelUsage = {
  /** 未命中缓存的输入 tokens；cache_creation 按未命中单价估算，并入本列 */
  input: number
  cacheRead: number
  output: number
  replies: number
}

export type UsageSummary = {
  /** 允许新版归档的未知模型；所有键都必须是普通自有属性。 */
  models: Record<string, ModelUsage>
  webSearchRequests: number
  toolSearch: number
  replies: number
}

const createModels = (): Record<string, ModelUsage> =>
  Object.create(null) as Record<string, ModelUsage>

const EMPTY_SUMMARY: UsageSummary = {
  models: createModels(),
  webSearchRequests: 0,
  toolSearch: 0,
  replies: 0,
}

const accumulate = (summary: UsageSummary, model: string, usage: MessageUsage) => {
  const current = summary.models[model] ?? { input: 0, cacheRead: 0, output: 0, replies: 0 }
  current.input += usage.input_tokens + usage.cache_creation_input_tokens
  current.cacheRead += usage.cache_read_input_tokens
  current.output += usage.output_tokens
  current.replies += 1
  summary.models[model] = current
  summary.replies += 1
  if (usage.server_tool_use) {
    summary.webSearchRequests += usage.server_tool_use.web_search_requests
    summary.toolSearch += usage.server_tool_use.tool_search
  }
}

/**
 * 全量扫描会话聚合每条回复记录的 usage。
 * 未记录模型的消息（旧版导入数据一般也不带 usage）跳过不计。
 */
const computeUsage = async (summaries: SessionSummary[]): Promise<UsageSummary> => {
  const summary = emptyUsageSummary()
  for (const { id } of summaries) {
    const session = await db.loadSession(id)
    if (!session) {
      continue
    }
    for (const message of session.messages) {
      if (message.role === 'assistant' && message.usage && message.model) {
        accumulate(summary, message.model, message.usage)
      }
    }
  }
  return summary
}

/**
 * 金额估算区间（元）：tokens 按公开单价的空闲/高峰两档分别累计，搜索次数按次计费；
 * 结果为估算值，实际以官方账单为准。
 */
export const estimateCostRange = (summary: UsageSummary): { min: number; max: number } => {
  let min = 0
  let max = 0
  for (const [id, usage] of Object.entries(summary.models)) {
    if (!usage) {
      continue
    }
    // 静态表之外的模型（导入自新版备份）无法估算单价，token 照常展示
    const meta = getModelMeta(id)
    if (!meta) {
      continue
    }
    const pricing = meta.pricing
    min +=
      (usage.input * pricing.cacheMiss[0] +
        usage.cacheRead * pricing.cacheRead[0] +
        usage.output * pricing.output[0]) /
      1e6
    max +=
      (usage.input * pricing.cacheMiss[1] +
        usage.cacheRead * pricing.cacheRead[1] +
        usage.output * pricing.output[1]) /
      1e6
  }
  const searches = summary.webSearchRequests + summary.toolSearch
  min += (searches * SEARCH_FEE_PER_1K) / 1000
  max += (searches * SEARCH_FEE_PER_1K) / 1000
  return { min, max }
}

/** 用量数据修订号的持久 key：会话保存成功、导入/清空/删除会话后递增 */
const REVISION_KEY = 'chat-demo:usage-revision'

const readRevision = (): number => {
  try {
    const value = Number(localStorage.getItem(REVISION_KEY))
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}

/**
 * 递增用量数据修订号，使缓存签名失效。
 * 流式结束只保存回复的 usage，不改会话列表元数据——签名若只看会话数与最近更新时间
 * 会漏掉这次变化（生成中途打开面板缓存的旧值在回答完成后仍然命中）。
 */
export const bumpUsageRevision = () => {
  try {
    localStorage.setItem(REVISION_KEY, String(readRevision() + 1))
  } catch {
    // 存储不可用时缓存写入同样失败，每次都会重算
  }
}

/** 修订号、会话数量与最近更新时间共同构成数据签名：生成完成、导入、删除都触发重算 */
const signatureOf = (summaries: SessionSummary[]): string =>
  `${readRevision()}:${summaries.length}:${summaries.reduce((max, item) => Math.max(max, item.updatedAt), 0)}`

const readCache = (): { signature: string; summary: UsageSummary } | null => {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as { signature?: unknown; summary?: unknown }
    if (
      typeof parsed.signature !== 'string' ||
      typeof parsed.summary !== 'object' ||
      parsed.summary === null
    ) {
      return null
    }
    const summary = parsed.summary as UsageSummary
    if (!summary.models || typeof summary.models !== 'object' || Array.isArray(summary.models)) {
      return null
    }
    // JSON.parse 会恢复普通对象；重新建立无原型字典，特殊模型在缓存往返后仍是普通键。
    const models = createModels()
    for (const [model, usage] of Object.entries(summary.models)) {
      if (
        !usage ||
        typeof usage !== 'object' ||
        ![usage.input, usage.cacheRead, usage.output, usage.replies].every(
          (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
        )
      ) {
        return null
      }
      models[model] = usage
    }
    if (
      ![summary.webSearchRequests, summary.toolSearch, summary.replies].every(
        (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
      )
    ) {
      return null
    }
    return { signature: parsed.signature, summary: { ...summary, models } }
  } catch {
    return null
  }
}

const writeCache = (signature: string, summary: UsageSummary) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ signature, summary }))
  } catch {
    // 存储不可用时每次重算
  }
}

let inflight: Promise<UsageSummary> | null = null

/**
 * 取用量汇总：签名未变时直接返回缓存；变化（或无缓存）时全量扫描重算。
 * 千会话量级的一次性扫描为数秒，调用方需显示「统计中」占位。
 */
export const getUsageSummary = (): Promise<UsageSummary> =>
  (inflight ??= (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      const signature = signatureOf(summaries)
      const cached = readCache()
      if (cached && cached.signature === signature) {
        return cached.summary
      }
      const summary = await computeUsage(summaries)
      writeCache(signature, summary)
      return summary
    } finally {
      inflight = null
    }
  })())

export const emptyUsageSummary = (): UsageSummary => ({
  ...EMPTY_SUMMARY,
  models: createModels(),
})
