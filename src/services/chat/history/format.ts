/**
 * 历史会话导出产物（deepseek_data-*.zip）的类型定义。
 *
 * - 时间均为 UTC RFC 3339、Z 结尾，小数秒精度不固定；
 * - 消息树按 id 排序和引用；
 * - 可空字段用 null 表示；可选字段允许缺省。
 */

/** 2026-11-11T02:33:23.270Z */
export type Iso8601Utc = string

export const EXPORT_FORMAT_VERSION = 3

/**
 * 完整应用备份格式：在 v3 会话格式上增加每条回复的 model/effort/usage、
 * 全部附件原件（files/ 目录，含非图片与 MIME）与应用设置（app_settings.json，不含 API Key）。
 * manifest 以 archive_kind 区分；官方后续若发布 v4 历史格式，kind 不是 'full' 即不适用本格式。
 */
export const FULL_FORMAT_VERSION = 4

export type ArchiveKind = 'legacy' | 'full'

/** manifest.json，ZIP 的第一个条目；full 备份额外携带 archive_kind */
export type Manifest = {
  export_format_version: number
  archive_kind?: 'full'
}

/** chat_session_index.json 的一项，只列出成功写出的会话；位于全部会话 JSON 之后、图片之前 */
export type SessionIndexEntry = {
  id: string
  title: string | null
  pinned: boolean
  message_count: number
  inserted_at: Iso8601Utc
  updated_at: Iso8601Utc
}

/** chat_sessions/{session_id}.json */
export type SessionFile = {
  id: string
  title: string | null
  pinned: boolean
  /** 用户当前停留的消息，线性化消息树的唯一依据 */
  current_message_id: number
  inserted_at: Iso8601Utc
  updated_at: Iso8601Utc
  /** 消息树，分支靠 parent_id */
  messages: ChatMessage[]
}

export type ChatRole = 'USER' | 'ASSISTANT'

export type ChatMessageStatus =
  | 'WIP'
  | 'FINISHED'
  | 'CONTENT_FILTER'
  | 'FAILED'
  | 'INCOMPLETE'
  | 'CONTEXT_LENGTH_EXCEEDED'
  | 'TIMEOUT'

export type ChatMessage = {
  /** 会话内自增 */
  id: number
  /** null 表示该会话的第一条 */
  parent_id: number | null
  role: ChatRole
  status: ChatMessageStatus
  thinking_enabled: boolean
  search_enabled: boolean
  /** 沿分支累计的上下文 token */
  accumulated_token_usage: number
  inserted_at: Iso8601Utc
  /** 按发生顺序排列 */
  fragments: Fragment[]
  /** 完整备份（v4）专有：回复生成时的模型快照；assistant 消息可选 */
  model?: string | null
  /** 完整备份（v4）专有：思考强度快照 */
  effort?: string | null
  /** 完整备份（v4）专有：最近一次请求的用量明细 */
  usage?: TokenUsageEntry | null
}

/** 完整备份里的每条回复用量，字段与本地 MessageUsage 一致 */
export type TokenUsageEntry = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  server_tool_use?: { web_search_requests: number; tool_search: number }
}

/** 用户的提问 */
export type RequestFragment = { type: 'REQUEST'; content: string }

/** 模型的回答，引用标记已剥除 */
export type ResponseFragment = { type: 'RESPONSE'; content: string }

export type ThinkFragment = {
  type: 'THINK'
  content: string
  /** 思考耗时（秒） */
  elapsed_secs: number | null
}

/** 服务端模板（过载、内容过滤、超长等），不能当正常回答放进上下文 */
export type TemplateResponseFragment = { type: 'TEMPLATE_RESPONSE'; content: string }

export type TipStyle = 'INFO' | 'WARNING' | 'CAUTION'

/** 文案使用导出时的兜底语言（en） */
export type TipFragment = { type: 'TIP'; content: string; style: TipStyle }

/** 内容风险提示条，保留原回答内容 */
export type ContentRiskFragment = { type: 'CONTENT_RISK'; content: string; style: TipStyle }

export type PartialFileReadFragment = {
  type: 'PARTIAL_FILE_READ'
  /** 截断后占原文的百分比，0–100 */
  ratio: number
}

export type SearchResult = {
  url: string
  title: string
  snippet: string
  published_at: Iso8601Utc | null
  site_name: string | null
  /** 可选的站点图标。 */
  site_icon?: string | null
}

/** 普通搜索与边想边搜共用的搜索片段，包含可见结果 */
export type ToolSearchFragment = {
  type: 'TOOL_SEARCH'
  queries: string[]
  results: SearchResult[]
  /** 可选的搜索状态；FINISHED 允许空结果 */
  status?: SearchStatus
  /** 可选的模型推理轮次编号 */
  stage_id?: number
  /** 部分产物携带的分组标识，原样保留 */
  group_id?: number
}

export type SearchStatus = 'WIP' | 'FINISHED' | 'FAILED'

export type ToolOpenStatus = 'WIP' | 'FINISHED' | 'FAILED'

/** 边想边搜里打开的页面；页面信息同时为 null 时只有动作、没有内容 */
export type ToolOpenFragment = {
  type: 'TOOL_OPEN'
  status: ToolOpenStatus
  url: string | null
  title: string | null
  snippet?: string | null
  site_name?: string | null
  published_at: Iso8601Utc | null
  stage_id?: number
  group_id?: number
}

export type ToolFindStatus = 'WIP' | 'FINISHED' | 'NO_RESULT' | 'FAILED'

/** 页面内查找，查找词可选 */
export type ToolFindFragment = {
  type: 'TOOL_FIND'
  status: ToolFindStatus
  pattern?: string
  stage_id?: number
  group_id?: number
}

/** 阅读链接结果：可选的 url/title 用于展示；signature 由服务端解密恢复正文 */
export type ReadLinkResult = {
  url?: string
  title?: string | null
  signature: string
}

export type ReadLinkFragment = { type: 'READ_LINK'; results: ReadLinkResult[] }

export type FileEntry = {
  /** 不带 file- 前缀的 UUID */
  id: string
  /** 用户上传时的文件名 */
  file_name: string
  file_size: number
  token_usage: number | null
  inserted_at: Iso8601Utc
  /** 图片导出成功时为 ZIP 条目名，否则为 null；条目也可能不存在 */
  export_path: string | null
  is_image: boolean
  width: number | null
  height: number | null
  /** 完整备份（v4）专有：本地记录的 MIME，导入时直接还原 */
  mime_type?: string | null
}

/** app_settings.json，仅完整备份携带；永不包含 API Key */
export type AppSettingsFile = {
  schema: 1
  exported_at: Iso8601Utc
  settings: {
    locale: string
    theme_preference: string
    tts_voice: string
    location: unknown
    thinking: boolean
    search: boolean
    sider_collapsed: boolean
    model: string
    thinking_effort: string
  }
  /** 未发送的草稿文本：会话 ID（新对话为 'null'）→ 文本 */
  drafts: Record<string, string>
}

/** 非图片文件只有元数据，本体不在产物里 */
export type FileFragment = { type: 'FILE'; files: FileEntry[] }

export type ImageSearchStatus = SearchStatus

export type ImageSearchResult = {
  title: string
  source_page_url: string
  snippet: string
  site_name: string | null
  published_at: Iso8601Utc | null
}

/** 图搜结果元数据，支持可选的 image_indexes */
export type ToolImageSearchFragment = {
  type: 'TOOL_IMAGE_SEARCH'
  status: ImageSearchStatus
  image_indexes?: number[]
  results: ImageSearchResult[]
  stage_id?: number
  group_id?: number
}

export type Fragment =
  | RequestFragment
  | ResponseFragment
  | ThinkFragment
  | TemplateResponseFragment
  | TipFragment
  | ContentRiskFragment
  | PartialFileReadFragment
  | ToolSearchFragment
  | ToolOpenFragment
  | ToolFindFragment
  | ReadLinkFragment
  | FileFragment
  | ToolImageSearchFragment
