# WhaleChat

[English](README.md) | 简体中文

基于 DeepSeek API 的 Android 与静态 Web 聊天客户端，采用 React、TypeScript 与 Capacitor 8 构建（演进自上游 [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo)）。无需自建应用后端，客户端使用个人 API Key 直接连接所配置的 API 服务。

架构设计与阶段验证记录见[文档索引](docs/README.md)：
- [阶段 A 验证记录](docs/android-phase-a-verification.md)：Capacitor 8 Android 工程、Keystore 凭据加密、草稿文本持久化，以及网络、语音、数据、文件四条链路的真实 API / 模拟器验证。
- [阶段 B 验证记录](docs/android-phase-b-verification.md)：Flash / V4 Pro 模型切换与思考强度、账户余额与本地用量面板、完整应用备份（归档 v4）、内嵌图片全屏查看器与双击返回退出。
- [阶段 C 验证记录](docs/android-phase-c-verification.md)：长会话富内容视口按需渲染、键盘与焦点无障碍改进、标题与全分支正文检索定位、附件上下文与解析计费保护。

> 真机性能、TalkBack 读屏流程、真机音频焦点/路由以及 C4 真实付费重解析链路仍待验收；自动回归与模拟器记录不替代目标真机完整验收。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/g64-cmd/deepseek_app.git
cd deepseek_app
pnpm install
pnpm dev
```

打开 http://localhost:8090 ，首次对话前请在设置中填写 DeepSeek API Key。

生成静态 Web 产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`（通过 `file://` 直接打开时，浏览器和 API 服务需允许本地页面存储与跨域请求）。

## 功能

- **多会话与分支树**：自动标题、重命名与删除；编辑提问、重新生成与切换消息分支。
- **历史标题与全分支正文检索**：支持标题快速过滤，以及可取消的全分支用户/助手正文分批扫描，支持一键跳转并定位至深层未选分支中的命中消息。
- **模型选择与深度推理**：支持切换 `DeepSeek Flash`（`deepseek-flash`）与 `DeepSeek V4 Pro`（`deepseek-v4-pro`），配置思考强度（低 / 高 / 最高）；支持流式回答、深度思考、智能搜索、链接阅读、来源引用，以及停止和符合条件的继续生成。
- **附件与费用/上下文保护**：支持上传、粘贴或拖拽附件；提供版面文档解析方式选择（仅文字 / 图文混排）、上传前按页计费确认、单次请求 20 个文档聚合上限守卫，以及缺失/失效历史附件的重试或显式省略；支持内嵌全屏图片查看、缩放平移与保存/分享。
- **语音输入与朗读**：支持整段语音录音转写（`POST /v1/tools/asr`，移动端输入框首行显示实时频谱）与流式 PCM 回复朗读（`POST /v1/tools/tts`）。
- **富文本与按需渲染**：支持 Markdown、代码高亮（Prism）、KaTeX 公式和 Mermaid 图表；长对话中对屏外富内容启用视口门控按需增强。
- **账户与备份恢复**：支持查询账户余额（`GET /user/balance`）、按模型聚合本地 Token/搜索用量与空闲/高峰费用区间估算；支持官方兼容格式历史导出（v3）与完整应用备份（v4）。
- **多端体验与无障碍**：支持简体中文与英文、浅色/深色/跟随系统主题、位置设置、移动端抽屉与键盘视口适配、共享浮层焦点栈及减少动态效果（`prefers-reduced-motion`）适配。

## 数据与存储

Web 端的 API Key 和设置保存在浏览器 `localStorage`。Android 端的 API Key 使用 Android Keystore 保护的 AES-256-GCM 密钥加密（`SecureStoragePlugin`），密文与 IV 存入应用私有 `SharedPreferences`；其他设置与未发送的草稿文本（`chat-demo:draft-texts`）仍使用 WebView `localStorage`。会话及附件原件保存在 IndexedDB（`chat-demo`），本地数据按应用或浏览器用户配置和站点源（origin）隔离。发送对话、上传附件和使用语音功能时，相应内容会提交给配置的 API 服务。

设置 → 数据管理提供两种 ZIP 归档格式（详见[历史导入导出说明](src/services/chat/history/README.md)）：
- **导出所有历史对话（v3，`deepseek_data-日期.zip`）**：兼容 DeepSeek 官方导出格式，包含全部会话消息树与本地可用的图片原件，不包含非图片原件、应用设置或 API Key。
- **完整备份（v4，`whalechat-backup-日期.zip`）**：仅限本应用恢复；额外包含本地可用的非图片附件原件、应用设置、草稿文本、文档解析方式以及每条回复的模型/思考强度/用量快照。未发送的草稿附件与本地缺失的原件不在备份范围内，**API Key 永不导出**。

确认并校验成功后，导入会替换全部本地会话和附件（v4 同时恢复应用设置与草稿文本）。设置 → 数据管理 → 删除所有对话会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话；API Key 和其他设置保留，已上传到 API 服务的文件不受影响。

## 开发

| 命令                 | 用途                                       |
| -------------------- | ------------------------------------------ |
| `pnpm dev`           | 启动开发服务器（`http://localhost:8090`）  |
| `pnpm build`         | 构建静态 Web 产物到 `dist/`                |
| `pnpm build:android` | 构建 Web 产物并同步到 Capacitor Android    |
| `pnpm apk:debug`     | 构建 Web 并打包 Android 调试 APK           |
| `pnpm apk:install`   | `adb install -r` 安装调试 APK              |
| `pnpm type`          | TypeScript 类型检查                        |
| `pnpm lint`          | oxlint 代码检查                            |
| `pnpm test`          | 运行 Node 功能与数据安全回归测试           |
| `pnpm test:c2`       | 运行真实浏览器可访问性与布局回归测试       |
| `pnpm test:c3`       | 运行真实浏览器历史检索与分支定位回归测试   |
| `pnpm perf:c0`       | 运行 Android C0 性能与内存测量驱动         |
| `pnpm format`        | oxfmt 代码格式化                           |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址和开发服务器代理。测试覆盖说明见 [tests/README.md](tests/README.md)，Android 性能测量工具说明见 [scripts/perf/README.md](scripts/perf/README.md)。

### Android 调试构建

基于 Capacitor 8（Gradle 8.14.3 / AGP 8.13.0 / compileSdk 36 / minSdk 24）。需要 Android SDK 与 **JDK 21**（Gradle 守护进程经用户级 `~/.gradle/gradle.properties` 的 `org.gradle.java.home` 指定，路径见[阶段 A 验证记录](docs/android-phase-a-verification.md)，不入库）：

```sh
pnpm apk:debug    # 构建 Web → cap sync → gradlew assembleDebug
pnpm apk:install  # 安装到已连接的设备/模拟器
```

平台差异集中在 [src/platform/](src/platform/)（Android Keystore 凭据存储、外链点击委托、基于缓存目录的文件导出分享与启动清理、浮层返回栈与双击退出），Web 行为不变；应用 ID 为 `com.g64_cmd.whalechat`，WebView origin 为 `https://localhost`（发布后不可变更）。

聊天默认使用 `deepseek-flash`（可切换 `deepseek-v4-pro`），通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 `/v1/tools/asr` 与 `/v1/tools/tts` 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。

```text
android/               Capacitor Android 原生工程与 SecureStoragePlugin（Keystore AES-GCM）
docs/                  架构设计、DeepSeek API 本地快照与阶段 A/B/C 验证记录
scripts/perf/          Android C0/C3 性能、规模与 trace 测量脚本
src/
  app/                 应用布局、主题、视口处理与全局样式
  components/          聊天输入、消息列表、历史检索、设置与 Markdown 组件
  i18n/                中英文文案
  platform/            Web 与 Android 平台适配层（Keystore、文件保存/分享、返回键、外链）
  services/
    api/               API 请求、SSE 解码、错误分类与协议类型
    chat/              会话、消息分支树、IndexedDB 存储、历史检索与 ZIP 导入导出
    markdown/          Markdown AST 解析、代码高亮、KaTeX 与 Mermaid 渲染队列
    speech/            录音采集（WAV）与流式 PCM 朗读播放
  utils/               通用工具（图片缩放、剪贴板、格式化、ID 生成）
tests/                 Node 与真实浏览器回归测试套件
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
