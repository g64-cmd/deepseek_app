# Android 阶段 A 四链路验证记录

日期：2026-11-17 ～ 2026-11-19（Asia/Singapore）。
构建基线：`develop` / `3203949`（`build: android 构建脚本与 CI 门禁`）；持 Key 验证与 Keystore/草稿功能在 `691f803` 构建上完成。调试 APK `app-debug.apk`（约 6.5 MB，versionCode 1）。
对应方案：[Android 初步改进方案](android-improvement-proposal.md) 阶段 A 与 3.1 节四条链路。

**结论（2026-11-19）**：四条链路的模拟器可验证项全部通过（真实 API Key）；阶段 A 剩余真机项见第 4 节。

## 1. 环境与版本锁定

| 项 | 值 | 说明 |
| --- | --- | --- |
| 开发机 | Windows 11 + Git Bash | Node 24.11.0 / pnpm 11.21.0 |
| JDK | Temurin/Oracle 21（`C:\Program Files\Java\jdk-21.0.12.1`） | 系统默认 java 为 25，超 Gradle/AGP 上限；经用户级 `%USERPROFILE%\.gradle\gradle.properties` 的 `org.gradle.java.home` 固定，不入库 |
| Gradle | 8.14.3（wrapper，已入库） | Capacitor 8.6.2 模板自带 |
| AGP / SDK | AGP 8.13.0（`android/build.gradle` 第 10 行）；compileSdk 36 / targetSdk 36 / minSdk 24 | `android/variables.gradle` |
| Capacitor | core/cli/android 8.6.2；app 8.1.2、filesystem 8.1.5、share 8.0.3 | 版本由 lockfile 锁定 |
| SecureStorage | 应用内 Java 插件（`com.g64_cmd.whalechat.SecureStoragePlugin`） | AndroidKeyStore AES-256-GCM 加密 API Key，密文落私有 SharedPreferences；MainActivity 注册 |
| 验证设备 | Pixel_8 AVD，Android 14（API 34），Google APIs 镜像 | System WebView 113.0.5672.136（镜像无法升级） |
| 应用 | `com.g64_cmd.whalechat` / WhaleChat，androidScheme `https`（origin `https://localhost`） | 发布前 origin 不可再变 |

构建管线（Windows cmd 与 Git Bash 均通过）：`pnpm apk:debug`（build → `cap sync android` → `gradlew assembleDebug`）、`pnpm apk:install`（`adb install -r`）。

## 2. 链路验证结果

### 链路 1 网络 / SSE —— 通过（2026-11-19，真实 Key）

| 项 | 结果 | 说明 |
| --- | --- | --- |
| WebView 加载内置 dist | 通过 | `publicPath:'auto'` 相对路径，`https://localhost/static/...` 全部本地命中（logcat `Handling local request`） |
| Key 校验与 CORS | 通过 | 用户在 App 内输入真实 Key → `GET /models` 校验通过并保存；后续聊天证明 `https://localhost` origin 下预检与请求全通 |
| SSE 增量渲染 | 通过 | 真实问答流式逐块渲染，节奏与 Web 版相当；自动标题生成正常 |
| 深度思考块 | 通过 | 开启 DeepThink 后回复渲染"已深度思考（用时 N 秒）"折叠块与正文 |
| 停止 | 通过 | 流中点停止立即生效，已收内容保留为停止态 |
| 断流与恢复 | 通过 | 流中开飞行模式 → 红色错误条+重试按钮；恢复网络后新请求正常应答 |
| 附件视觉问答 | 通过 | Photo Picker 选图（content://）→ multipart 上传 → 回答准确描述图片内容 |
| 401 错误路径 | 未复测 | 与 Web 版同一代码路径（classifyStatus→apiKeyInvalid），未在 App 内重复构造 |
| 模拟器网络限制 | 记录 | 镜像对 gstatic 探测超时，不影响 api.deepseek.com 实际调用 |

### 链路 2 语音 —— 通过（2026-11-19，真实 Key）

| 项 | 结果 | 说明 |
| --- | --- | --- |
| 录音权限与 getUserMedia | 通过 | 麦克风按钮启动录音：RECORD_AUDIO 已授权，`getUserMedia` 采集正常，输入框首行实时频谱与计时显示 |
| ASR 语音转文字 | 通过 | 整段录音上传转写，识别文本进入草稿（用户验证确认） |
| TTS 朗读 | 通过 | 点朗读按钮即播：`dumpsys audio` 证实 WhaleChat 进程 AAudio 流 `state:started`（USAGE_MEDIA）；按钮变为播放中波形动画 |
| TTS 停止与释放 | 通过 | 再点立即停止，AAudio 流转 `state:stopped`，无遗留占用 |
| 耳机插拔、来电中断、音频焦点 | **待真机** | 模拟器无法模拟 |
| 真实识别率/回声消除/音质 | **待真机** | 模拟器虚拟麦克风不具代表性 |

### 链路 3 数据 —— 通过（模拟器可自动化部分）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 强杀保留 | 通过 | 导入会话后 `am force-stop` → 重启，会话列表与消息内容完整（IndexedDB 库 `chat-demo` v11 在 WebView origin 下持久） |
| 覆盖安装保留 | 通过 | 修复版（`297d69b` 之后）构建 `install -r` → 重启直接保留既有会话与 locale；上一构建（`3203949`）同项亦通过 |
| localStorage 持久 | 通过（间接） | locale 设置跨 force-stop / 覆盖安装保持（界面语言不回退） |
| Keystore 凭据存取 | 通过 | 无值路径（logcat 插件注册与 `get` 调用）+ **真实 Key 闭环**：填入真实 Key → `force-stop` → 重启不弹设置（解密恢复成功），Web 校验/聊天直接可用 |
| 草稿持久化 | 通过 | 输入框输入文本 → `force-stop` → 重启，未发送文字完整恢复（localStorage `chat-demo:draft-texts`，防抖 400ms 落盘，仅持久化文本不持久化附件） |
| 强杀恢复语义 | 通过（2026-11-19） | 流式回答中途 `force-stop` → 重启后该回复显示停止态、已收内容保留；logcat 确认重启**零自动重发**（不产生重复计费） |

### 链路 4 文件 —— 通过（模拟器范围内）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| SAF 导入 | 通过 | 设置 → Upload → 系统 DocumentsUI → Downloads 提供方 → 选 ZIP → 覆盖确认 → 会话树完整恢复（含消息内容渲染）；`<input type=file>` 零改动即用（Capacitor `onShowFileChooser` 内建） |
| 导入替换语义 | 通过 | 第二次导入后旧会话被替换（符合"导入覆盖全部"设计） |
| 导出 | 通过 | Download → `Filesystem.writeFile`（base64 过桥）→ 系统分享面板带 `deepseek_data-日期.zip` 出现，可选"Save to Files/Drive/Gmail"等；SharePlugin 的 FileProvider 读取成功（否则插件会 reject） |
| 用户取消分享 | 设计支持 | 插件以 `Share canceled` reject，native 实现归一为 `cancelled`，UI 不报错（静态审查 + 插件源码核实 SharePlugin.java:78） |
| Markdown 外链 | 通过 | 消息内 `[text](https://...)` 点击 → 捕获阶段委托 → 隐藏锚点导航 → Capacitor `launchIntent` 转交系统 ACTION_VIEW。模拟器无浏览器 app，系统弹"Chrome isn't available"恰证明 intent 已正确发出；真机将直接打开浏览器 |
| 云盘 content:// 提供方 | **待真机/装云盘 app** | 模拟器仅覆盖 Downloads 提供方 |
| 附件原件外部打开 | 已知限制 | 本地附件为 blob: URL，系统浏览器无法跨进程打开；native `openExternal` 对非 http(s) 静默忽略。完整方案（全屏查看器或经分享转存）留阶段 B |

### 交互（超出四链路，顺带验证）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 系统返回键 | 通过（3/3） | 优先级依次生效：设置弹窗收起（应用存活）→ 侧栏抽屉收起（应用存活）→ 无浮层时退出到桌面（`App.exitApp`，焦点交回 Launcher）；键盘展开时首次返回由 IME 消费，未观察到误退出 |
| 状态栏 / insets | 通过（API 34） | Capacitor 8 SystemBars 默认策略：未声明 `viewport-fit=cover` 时由原生 decor padding 避开系统栏，应用 CSS 零改动；`--safe-area-inset-*` 变量注入为 0。**Android 15 强制 edge-to-edge 场景待 API 35+ 镜像复验** |
| 深色渲染 | 通过 | 跟随系统深色模式正常渲染 |

## 3. 环境问题与限制（非应用缺陷）

1. **模拟器窗口管理不稳定**：长时间 adb 自动化操作后偶发 activity 自发 pause/stop 退后台、`Activity pause timeout` / `top resumed state loss timeout`、`mCurrentFocus=null`（系统设置应用同样出现）。重启模拟器（`-no-snapshot` 全新启动）后恢复，期间应用无对应崩溃日志。影响验证操作节奏，不影响已通过项的结论；**真机复验时关注是否复现**。
2. **WebView 113 无法升级**：Google APIs 镜像无 Play 商店。rspack 目标 Chrome 105+ 满足；真机 WebView 140+ 行为（含 SystemBars passthrough 路径）需复验。
3. **模拟器无 Chrome 浏览器 app**：外链 intent 只能弹出"浏览器不可用"解析页，无法验证最终页面打开。
4. **Filesystem Cache 落点待查**：导出链路成功，但 ZIP 未出现在 `run-as ls ./cache/`（内部 cacheDir）；@capacitor/filesystem 8.x 新实现的目录解析（content:// 体系）与重复导出的清理策略需在阶段 B 明确，避免 cache 堆积。
5. `pnpm format` 会重排上游从未格式化的文件（docs 表格、生成的 `*.css.d.ts`、个别源码换行），产生与功能无关的大范围 diff。本次已回退无关格式化；后续如需统一格式应独立提交。

## 4. 待验证清单（阶段 A 收尾条件）

持 Key 模拟器验证已于 2026-11-19 全部完成（见上文各链路）。剩余：

- [x] **CI**：develop 推送后 quality.yml 首跑全绿（2026-11-19，run 44399788976：type/lint/test/web build/JDK21 assembleDebug + APK artifact）
- [ ] **真机项**（有设备后补测；模拟器已验证项不再重复）：
  - [ ] 耳机插拔、来电中断、音频焦点（ASR/TTS 使用中）
  - [ ] Android 15+ 强制 edge-to-edge 下的 insets（当前 API 34 未覆盖）
  - [ ] 云盘 content:// 提供方选附件；附件原件跨应用打开
  - [ ] WebView 140+ 行为（含 SystemBars passthrough 路径）；低端设备性能基线
  - [ ] 从上一正式版本覆盖升级的数据迁移（首个正式版发布前）
- [ ] **可选补测**：错误 Key 的 401 文案在 App 内复现（与 Web 同代码路径，优先级低）；智能搜索/读链接的引用渲染（链路 1 已含 SSE 与工具链路基础）

## 5. 阶段 A 实施决策记录

| 决策 | 内容与理由 |
| --- | --- |
| insets 策略 | 不加 `viewport-fit=cover`、不改 CSS：走 Capacitor SystemBars 原生 decor padding，Web 版零变化；未来若需要内容延伸到系统栏后（沉浸式），再切换 passthrough 模式并用 `--safe-area-inset-*` 变量适配 |
| 外链 | 事件委托（**冒泡阶段**拦截 `a[target="_blank"]` http(s)，跳过已 `defaultPrevented` 的事件）+ `window.open` 调用点改走 `platform.openExternal`；不引入 @capacitor/browser（系统浏览器已够用）。捕获阶段会在嵌套引用角标处理前抢先开链，已按 review 修正 |
| 返回键退出 | **弹窗栈优先**：`Modal.closeTopModal()` 与 Esc 共用关闭路径（含 busy 守卫，有弹窗时一律消费返回操作），无弹窗时依次收起侧栏、搜索面板，最后 `App.exitApp()` 退出；双击退出确认、预测性返回动画适配留阶段 B |
| 导出 | cache + Share 分享面板（含"保存到文件"），替代 WebView 无效的 `a.download`；Web 分支保持原下载行为 |
| 传输层 | 未抽象，直接用 WebView fetch + ReadableStream；`src/platform/index.ts` 注释预留原生传输替换点。若链路 1 持 Key 验证失败，按方案 4.1 评估 Kotlin 原生 SSE 桥 |
| 凭据存储（2026-11-18 划入 A） | 应用内 `SecureStoragePlugin`（Java，约 120 行）：AndroidKeyStore AES-256-GCM，密文落私有 SharedPreferences；JS 侧 `src/platform/secureStorage.ts` + settings 收口，Web 分支保持 localStorage 不变；含 localStorage 明文一次性迁移。渲染前 `hydrateApiKey()` 注水，读取失败按无 Key 处理 |
| 草稿持久化（2026-11-18 划入 A） | 仅持久化草稿文本（localStorage `chat-demo:draft-texts`，防抖 400ms，随内存状态同步清理）；附件上传态不持久化。Web 侧同样生效（刷新页面草稿保留） |
