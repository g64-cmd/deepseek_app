import type { ChatModel, EffortLevel } from './api/types.js'
import type { FileAttachment } from './chat/types.js'

/**
 * 模型静态注册表：能力与计费估算的编译期来源，不做运行时 /models 拉取。
 * 原因：定价信息 /models 不返回（估算必须静态）；ChatModel 是联合类型，请求组装与
 * UI 拦截依赖编译期检查；离线或旧服务响应缺字段时 UI 仍完整。新模型上线需更新本文件。
 * 能力与价格来源：docs/deepseek-api 快照（2026-11-17）quick_start/pricing.md 与 api/list-models.md。
 */
export type ModelMeta = {
  id: ChatModel
  /** 按钮与消息徽标用的展示短名（品牌名，不翻译） */
  shortName: string
  /** 是否支持图片输入 */
  vision: boolean
  effortLevels: readonly EffortLevel[]
  defaultEffort: EffortLevel
  /** 计费估算（元 / 百万 tokens，[空闲价, 高峰价]）；高峰为北京时间工作日 9-12、14-18 */
  pricing: {
    cacheRead: [number, number]
    cacheMiss: [number, number]
    output: [number, number]
  }
}

export const MODEL_METAS: Record<ChatModel, ModelMeta> = {
  'deepseek-flash': {
    id: 'deepseek-flash',
    shortName: 'Flash',
    vision: true,
    effortLevels: ['low', 'high', 'max'],
    defaultEffort: 'high',
    pricing: {
      cacheRead: [0.02, 0.04],
      cacheMiss: [1, 2],
      output: [4, 8],
    },
  },
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    shortName: 'V4 Pro',
    vision: false,
    effortLevels: ['low', 'high', 'max'],
    defaultEffort: 'high',
    pricing: {
      cacheRead: [0.15, 0.3],
      cacheMiss: [4.5, 9],
      output: [13.5, 27],
    },
  },
}

export const DEFAULT_MODEL: ChatModel = 'deepseek-flash'
export const DEFAULT_EFFORT: EffortLevel = 'high'

export const isChatModel = (value: string): value is ChatModel =>
  Object.hasOwn(MODEL_METAS, value)

export const isEffortLevel = (value: string): value is EffortLevel =>
  value === 'low' || value === 'high' || value === 'max'

/** 导入自完整备份的模型名可能不在静态表里（新版备份导入到旧版应用），调用方自行兜底 */
export const getModelMeta = (model: string): ModelMeta | null =>
  Object.hasOwn(MODEL_METAS, model) ? MODEL_METAS[model as ChatModel] : null

/**
 * 是否支持图片输入。未知模型按支持处理：请求交由服务端裁决，避免仅因静态表未更新而拦截。
 */
export const supportsVision = (model: string): boolean => getModelMeta(model)?.vision ?? true

/**
 * 返回 model 不支持图片输入时 files 中的图片附件。
 * 文档附件不拦：PDF/Word 经 Files API 解析为文本输入（document 内容块），与视觉通道无关。
 */
export const findBlockedImages = (model: string, files: FileAttachment[]): FileAttachment[] =>
  supportsVision(model) ? [] : files.filter((file) => file.isImage)
