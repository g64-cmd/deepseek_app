# WhaleChat

[English](README.md) | 简体中文

基于 [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo) 通过 Capacitor 8 构建的**非官方 Android 端聊天客户端**（同时保留上游的静态 Web 构建能力）。无需自建应用后端，应用使用个人 API Key 直接连接所配置的 API 服务。

> **免责与归属声明**：本项目仅是基于上游 [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo) 制作的第三方 Android 端适配与扩展工程，与 DeepSeek 官方无任何关联、授权或背书关系，亦不对 `deepseek-ai/chat-demo`、DeepSeek 品牌/API 及上游代码主张任何归属权。上游原始版权声明（`Copyright (c) 2026 DeepSeek`）与 [MIT 许可证](LICENSE)均原样保留。

> **当前状态说明**：自动化 Node/浏览器回归与模拟器验证已完成，但真机性能、TalkBack 读屏流程、真机音频路由/焦点及真实付费文档重解析链路仍待在目标真机上验收。

## 功能特性

### 基于 `deepseek-ai/chat-demo` 的 Android 端适配

- **Capacitor 8 Android 工程**：支持 Android 7.0+（`minSdk 24`、`compileSdk 36`、`targetSdk 36`，应用 ID `com.g64_cmd.whalechat`，WebView origin `https://localhost`）。
- **Keystore 凭据加密**：API Key 使用 Android Keystore 保护的 AES-256-GCM 密钥加密（`SecureStoragePlugin`），密文与 IV 存入应用私有 `SharedPreferences`。
- **原生交互与文件链路**：系统返回键优先级栈（浮层弹窗 → 侧栏/检索 → 双击退出）、外链委托系统浏览器打开、基于缓存目录的文件导出分享（`@capacitor/filesystem` + `@capacitor/share`）及启动清理、移动端抽屉与键盘视口适配。

### 在上游基础上补充的扩展能力

- **模型与思考强度切换**：支持切换 `DeepSeek Flash`（`deepseek-flash`）与 `DeepSeek V4 Pro`（`deepseek-v4-pro`），配置思考强度（低 / 高 / 最高）。
- **历史标题与全分支正文检索**：支持标题快速过滤，以及可取消的全分支用户/助手正文分批扫描，可一键跳转并定位至深层未选分支中的命中消息。
- **附件与费用/上下文保护**：支持版面文档解析方式选择（仅文字 / 图文混排）、上传前按页计费确认、单次请求 20 个文档聚合上限守卫、缺失/失效历史附件的重试或显式省略，以及内嵌全屏图片查看、缩放平移与保存/分享。
- **富内容按需渲染**：长对话中对屏外代码高亮（Prism）、KaTeX 公式与 Mermaid 图表启用视口门控按需增强。
- **账户与完整备份**：支持查询账户余额（`GET /user/balance`）、按模型聚合本地 Token/搜索用量及空闲/高峰费用区间估算；在兼容上游历史导出（v3）基础上新增完整应用备份恢复（v4）。
- **草稿与无障碍**：未发送草稿文本持久化（`chat-demo:draft-texts`）、共享浮层焦点栈及减少动态效果（`prefers-reduced-motion`）适配。

### 继承自上游 `deepseek-ai/chat-demo` 的核心能力

- 多会话与消息分支树、SSE 流式回答、深度思考、智能搜索、链接阅读、来源引用，以及停止和符合条件的继续生成。
- 附件上传/粘贴/拖拽、整段语音录音转写（`POST /v1/tools/asr`，移动端输入框首行实时频谱）与流式 PCM 回复朗读（`POST /v1/tools/tts`）。
- Markdown、代码高亮（Prism）、KaTeX 公式、Mermaid 图表、简体中文与英文界面、浅色/深色/跟随系统主题、位置设置，以及静态 Web 产物构建（`dist/`）。

## 快速开始

### 环境准备

- **Node.js 22.12+** 与 **pnpm**
- 构建 Android APK 另需 **Android SDK** 与 **JDK 21**（Capacitor 8 / Gradle 8.14.3 / AGP 8.13.0；若系统默认 JDK 高于 21，可在用户级 `~/.gradle/gradle.properties` 中通过 `org.gradle.java.home` 指定 JDK 21）

```sh
git clone https://github.com/g64-cmd/deepseek_app.git
cd deepseek_app
pnpm install
```

### 构建与安装 Android APK

**调试版（Debug APK）**：

```sh
# Windows
pnpm apk:debug
pnpm apk:install

# macOS / Linux
pnpm build:android && cd android && ./gradlew assembleDebug
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

**发布版（Release APK）**（需设置 `NODE_ENV=production`，确保 Rspack 输出压缩且不含 Source Map 的生产 Web 产物）：

```powershell
# Windows (PowerShell)
$env:NODE_ENV = 'production'
pnpm apk:release
```

```sh
# macOS / Linux
NODE_ENV=production pnpm build:android && cd android && ./gradlew assembleRelease
```

如需生成可直接安装到设备的**已签名** `android/app/build/outputs/apk/release/app-release.apk`，可在本地创建已被 `.gitignore` 忽略的 `android/keystore.properties`：

```properties
storeFile=your-release.jks
storePassword=...
keyAlias=...
keyPassword=...
```

或通过环境变量 `RELEASE_STORE_FILE`、`RELEASE_STORE_PASSWORD`、`RELEASE_KEY_ALIAS`、`RELEASE_KEY_PASSWORD` 注入签名信息（均不入库）。未配置签名时，Gradle 会输出未签名的 `app-release-unsigned.apk`。已签名 APK 可通过以下命令安装：

```sh
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

首次使用前，请在应用 **设置** 中填写个人 DeepSeek API Key。

### 运行或构建 Web 版

```sh
pnpm dev
```

打开 http://localhost:8090 。生成静态 Web 生产产物到 `dist/`：

```sh
# macOS / Linux（Windows PowerShell 请先执行 $env:NODE_ENV = 'production'）
NODE_ENV=production pnpm build
```

产物可部署到静态服务器，也可直接打开 `dist/index.html`（通过 `file://` 直接打开时，浏览器和 API 服务需允许本地页面存储与跨域请求）。

## 数据、权限与存储

- **Android 权限**：`INTERNET`（API 请求），以及 `RECORD_AUDIO`、`MODIFY_AUDIO_SETTINGS`（仅在使用语音输入时按需申请麦克风运行时权限）。
- **本地存储**：Android 端 API Key 经 Android Keystore 加密存储（`SecureStoragePlugin`），其他设置与未发送草稿文本（`chat-demo:draft-texts`）存于 WebView `localStorage`；Web 端 API Key 与设置存于浏览器 `localStorage`。会话及附件原件保存在 IndexedDB（`chat-demo`），按应用/浏览器配置与 origin 隔离（Android 端为 `https://localhost`，发布后不可变更）。
- **外部请求**：发送消息、上传附件、查询余额及使用语音功能时，相应数据会直接提交给所配置的 API 服务。

**设置 → 数据管理** 提供两种 ZIP 归档格式（详见[历史导入导出说明](src/services/chat/history/README.md)）：

- **导出所有历史对话（`v3`，`deepseek_data-日期.zip`）**：兼容上游 `deepseek-ai/chat-demo` / DeepSeek 官方导出格式，包含全部会话消息树与本地可用的图片原件，不包含非图片原件、应用设置或 API Key。
- **完整备份（`v4`，`whalechat-backup-日期.zip`）**：仅限本应用恢复；额外包含本地可用的非图片附件原件、应用设置、草稿文本、文档解析方式以及每条回复的模型/思考强度/用量快照。未发送的草稿附件与本地缺失的原件不在备份范围内，**API Key 永不导出**。

确认并校验成功后，导入会替换全部本地会话和附件（`v4` 同时恢复应用设置与草稿文本）。**设置 → 数据管理 → 删除所有对话**会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话；API Key 和其他设置保留，已上传到 API 服务的文件不受影响。

## 开发

| 命令                 | 用途                                                               |
| -------------------- | ------------------------------------------------------------------ |
| `pnpm dev`           | 启动 Web 开发服务器（`http://localhost:8090`）                     |
| `pnpm build`         | 构建静态 Web 产物到 `dist/`（生产环境需设置 `NODE_ENV=production`） |
| `pnpm build:android` | 构建 Web 产物并经 Capacitor 同步到 `android/`                      |
| `pnpm apk:debug`     | 构建 Web 并打包 Android 调试 APK（Windows `gradlew.bat`）          |
| `pnpm apk:release`   | 构建 Web 并打包 Android 发布 APK（Windows `gradlew.bat`）          |
| `pnpm apk:install`   | 通过 `adb install -r` 安装调试 APK                                 |
| `pnpm type`          | TypeScript 类型检查                                                |
| `pnpm lint`          | oxlint 代码检查                                                    |
| `pnpm test`          | 运行 Node 功能与数据安全回归测试                                   |
| `pnpm test:c2`       | 运行真实浏览器可访问性与布局回归测试                               |
| `pnpm test:c3`       | 运行真实浏览器历史检索与分支定位回归测试                           |
| `pnpm format`        | oxfmt 代码格式化                                                   |

- [rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`，`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址和开发服务器代理。
- 平台差异集中在 [src/platform/](src/platform/)，保持 Web 行为与上游 `chat-demo` 兼容。
- 聊天默认使用 `deepseek-flash`（可切换 `deepseek-v4-pro`），通过 Anthropic 兼容的 Messages / Files API 通信，并接入 `/user/balance`、`/v1/tools/asr` 与 `/v1/tools/tts`；请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。
- 测试覆盖说明见 [tests/README.md](tests/README.md)。

```text
android/               Capacitor 8 Android 原生工程与 SecureStoragePlugin（Keystore AES-GCM）
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

## 上游致谢与许可证

本项目衍生自 [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo)，继续遵循相同的 [MIT 许可证](LICENSE)（`Copyright (c) 2026 DeepSeek`），不主张任何上游代码归属权或官方背书。构建会将 `LICENSE` 复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖各自遵循其对应许可证。
