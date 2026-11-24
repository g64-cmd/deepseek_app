# DeepSeek 官方 API 本地资料

快照日期：2026-11-17（Asia/Singapore）。来源仅为 DeepSeek 官方文档站及正文使用的官方 CDN 图片；不以搜索摘要或第三方教程代替官方正文。

从[完整目录](snapshot-2026-11-17/INDEX.md)开始阅读。`pages/zh-cn/index.md` 是中文首次调用指南，`pages/en/index.md` 是英文指南。

## 归档范围与完整性

- 保存中英文官方 sitemap 的全部 **140 页**，另沿站内导航发现并保存中英文 `comparison_testing` 两页，共 **142 页，每种语言 71 页**。
- 覆盖首次调用、模型与价格、Token、错误和限速、全部 API 参考、功能与兼容协议指南、Agent 接入、发布说明和更新日志。API 参考保存完整参数、Schema、示例和响应内容，没有只截取摘要。
- `source/` 保存官网“看 Markdown”提供的原始 UTF-8 内容，校验值对应下载字节；`pages/` 只加来源信息、把已归档链接改为相对链接，适合离线阅读。
- 正文引用的官方图片及动图已归档：162 个官方 URL 对应 142 个去重后的本地文件。唯一未镜像的正文图片为第三方 Reasonix GitHub logo，保持外部链接，并列于 manifest。
- `inventory/` 保留 robots.txt 和两份 sitemap；[manifest.json](snapshot-2026-11-17/manifest.json) 记录每页/图片 URL、抓取时间、响应类型、字节数、SHA-256、失败与缺失清单。

这里的“完整”指抓取时官方站点两份目录及可发现的文档导航所列正文、Schema、示例和官方内容图片。它不是离线可运行的 Docusaurus 网站，不包含站点样式/脚本、控制台、SDK 源码、Harness 外站、政策外站、第三方文档或登录后内容。外链保留官网地址；离线正文不依赖这些页面。官方站点没有在本次归档入口提供一份可直接下载的全站 OpenAPI 文件，因此不把自行拼装的 Schema 冒充官方统一规范文件。

## 实现时优先查阅

| 场景 | 本地官方资料 | 当前项目关系 |
| --- | --- | --- |
| 总体聊天能力 | [构建 Chatbot](snapshot-2026-11-17/pages/zh-cn/guides/build_a_chatbot.md) | 当前 Demo 的主要能力来源 |
| 主聊天协议 | [Messages 参考](snapshot-2026-11-17/pages/zh-cn/api/create-message.md)、[Anthropic 兼容指南](snapshot-2026-11-17/pages/zh-cn/guides/anthropic_api.md) | 正在使用 |
| 搜索、读链接与引用 | [联网工具](snapshot-2026-11-17/pages/zh-cn/guides/web_tools.md) | 已用服务端工具，无需客户端手动执行搜索循环 |
| 上传与文档问答 | [Files](snapshot-2026-11-17/pages/zh-cn/guides/files_api.md)、[文件解析](snapshot-2026-11-17/pages/zh-cn/guides/document_parsing.md)、[视觉](snapshot-2026-11-17/pages/zh-cn/guides/vision.md) | 已有上传、平台适配、解析方式与费用确认、失效重试或明确省略；C4 真实收费链路仍待验 |
| 语音 | [ASR](snapshot-2026-11-17/pages/zh-cn/guides/asr.md)、[TTS（含 WebSocket）](snapshot-2026-11-17/pages/zh-cn/guides/tts.md) | 已有整段 ASR、HTTP 流式 TTS；无 WebSocket TTS |
| 模型、思考与费用 | [价格](snapshot-2026-11-17/pages/zh-cn/quick_start/pricing.md)、[思考模式](snapshot-2026-11-17/pages/zh-cn/guides/thinking_mode.md)、[余额](snapshot-2026-11-17/pages/zh-cn/api/get-user-balance.md) | 已有 Flash / V4 Pro 与思考强度选择、余额及按模型聚合的用量与费用估算；估算不包含解析、ASR、TTS 完整账单 |
| 多轮、标题、元信息与安全 | [多轮](snapshot-2026-11-17/pages/zh-cn/guides/multi_round_chat.md)、[标题](snapshot-2026-11-17/pages/zh-cn/guides/conversation_title.md)、[元信息](snapshot-2026-11-17/pages/zh-cn/guides/latest_reminder.md)、[安全](snapshot-2026-11-17/pages/zh-cn/guides/safety.md) | 已有对应代码，需核对组合契约 |
| 其他聊天协议 | [Chat Completions](snapshot-2026-11-17/pages/zh-cn/api/create-chat-completion.md)、[Responses](snapshot-2026-11-17/pages/zh-cn/api/create-response.md) | 资料已备，应用未全面封装 |
| 独立工具 | [Search/Fetch](snapshot-2026-11-17/pages/zh-cn/guides/search.md)、[OCR](snapshot-2026-11-17/pages/zh-cn/guides/ocr.md) | 可选工具场景；区别于聊天工具与文件问答 |
| 参数/协议与故障 | [错误码](snapshot-2026-11-17/pages/zh-cn/quick_start/error_codes.md)、[限速保活](snapshot-2026-11-17/pages/zh-cn/quick_start/rate_limit.md) | 用于补协议及网络验收 |

## API 参考入口清单

以下为官方 API 参考的 15 页；其中 Files 的兼容端点和 TTS WebSocket 的说明还须结合对应指南，不能只读这一张表。

| 参考页 | HTTP 路径（相对于 `https://api.deepseek.com`） |
| --- | --- |
| [Chat Completions](snapshot-2026-11-17/pages/zh-cn/api/create-chat-completion.md) | `POST /chat/completions` |
| [Messages](snapshot-2026-11-17/pages/zh-cn/api/create-message.md) | `POST /anthropic/v1/messages` |
| [Responses](snapshot-2026-11-17/pages/zh-cn/api/create-response.md) | `POST /responses` |
| [FIM（Beta）](snapshot-2026-11-17/pages/zh-cn/api/create-completion.md) | `POST /beta/completions` |
| [上传文件](snapshot-2026-11-17/pages/zh-cn/api/create-file.md) | `POST /files` |
| [列出文件](snapshot-2026-11-17/pages/zh-cn/api/list-files.md) | `GET /files` |
| [文件元信息](snapshot-2026-11-17/pages/zh-cn/api/retrieve-file.md) | `GET /files/{file_id}` |
| [删除文件](snapshot-2026-11-17/pages/zh-cn/api/delete-file.md) | `DELETE /files/{file_id}` |
| [模型](snapshot-2026-11-17/pages/zh-cn/api/list-models.md) | `GET /models` |
| [余额](snapshot-2026-11-17/pages/zh-cn/api/get-user-balance.md) | `GET /user/balance` |
| [Search](snapshot-2026-11-17/pages/zh-cn/api/search.md) | `POST /v1/tools/search` |
| [Fetch](snapshot-2026-11-17/pages/zh-cn/api/fetch.md) | `POST /v1/tools/fetch` |
| [OCR](snapshot-2026-11-17/pages/zh-cn/api/ocr.md) | `POST /v1/tools/ocr` |
| [ASR](snapshot-2026-11-17/pages/zh-cn/api/asr.md) | `POST /v1/tools/asr` |
| [TTS](snapshot-2026-11-17/pages/zh-cn/api/tts.md) | `POST /v1/tools/tts`；另有 `wss://api.deepseek.com/v1/tools/tts` |

Anthropic Files 的上传/列表/元信息/删除使用 `/anthropic/v1/files` 及 `/{file_id}`，鉴权、beta 头、purpose 与返回字段的差别见 [Files 兼容部分](snapshot-2026-11-17/pages/zh-cn/guides/files_api.md#anthropic-compatible-files-api)。文件元信息查询不是原始文件下载；官方文件解析指南说明原件与解析结果不能下载。

## 更新与校验

在仓库根目录，用 Python 3.11+ 执行；脚本不需要第三方 Python 包。同步需要访问 `api-docs.deepseek.com` 及正文图片的 `cdn.deepseek.com/api-docs/`，不需要 API Key，不调用付费推理接口。

```powershell
python -X utf8 scripts/sync_deepseek_docs.py
python -X utf8 scripts/verify_deepseek_docs.py docs/deepseek-api/snapshot-2026-11-17
```

同步默认创建当前 UTC+8 日期的新快照，已完成目录拒绝覆写；同一天再次抓取可以传 `--output docs/deepseek-api/snapshot-2026-11-17-refresh`。新快照成功后，人工复核差异，再更新本文和项目文档中的固定版本链接。不要在官方原文上直接修订笔记。

`.gitattributes` 禁用快照目录的 Git 换行转换，避免 Windows 检出改变校验字节；`.oxfmtrc.json` 排除快照目录，避免全仓格式化改写官方原文和清单。忽略规则用法见 [Oxfmt 官方说明](https://oxc.rs/docs/guide/usage/formatter/ignore-files)。

抓取校验会拒绝“返回 HTTP 200 但实际为首页 HTML”的伪 Markdown；本次还处理了旧英文 `news250325` 页面必须带尾斜杠才正确返回正文的站点行为。失败时保留 `manifest.incomplete.json`，不把残缺数据标记为完整。离线校验覆盖 sitemap 全量页、文件哈希及 Markdown/HTML 本地文件链接，不检查所有标题锚点、远端外链或服务端行为。

价格、折扣、限速、模型映射和平台能力均会变化；后续实施与发布前重新核对官网。历史发布说明中的旧价、旧模型和过期端点只是历史，不能用于当前调用配置。

## 来源与保留

[官方中文入口](https://api-docs.deepseek.com/zh-cn/)、[官方英文入口](https://api-docs.deepseek.com/)、[中文 sitemap](https://api-docs.deepseek.com/zh-cn/sitemap.xml)、[英文 sitemap](https://api-docs.deepseek.com/sitemap.xml)。每页保留来源和时间，官方文本/图片的权利仍归相应权利人；仓库本身的 MIT 许可证不能自动代表所有文档图片的授权。对外发布镜像或随安装包分发资料前另核对相应条款；App 构建只打包应用资源，不需要打包这些研究资料。
