# Android 阶段 A 四链路验证记录

日期：2026-11-17 ～ 2026-11-18（Asia/Singapore）。
构建基线：`develop` / `3203949`（`build: android 构建脚本与 CI 门禁`），调试 APK `app-debug.apk`（约 6.5 MB，versionCode 1）。
对应方案：[Android 初步改进方案](android-improvement-proposal.md) 阶段 A 与 3.1 节四条链路。

本文区分"模拟器已验证""待真实 API Key""待真机"三类结论。截图证据保留于验证过程，未随仓库存档；每项的通过判定以可复现的操作与日志为准。

## 1. 环境与版本锁定

| 项 | 值 | 说明 |
| --- | --- | --- |
| 开发机 | Windows 11 + Git Bash | Node 24.11.0 / pnpm 11.21.0 |
| JDK | Temurin/Oracle 21（`C:\Program Files\Java\jdk-21.0.12.1`） | 系统默认 java 为 25，超 Gradle/AGP 上限；经用户级 `%USERPROFILE%\.gradle\gradle.properties` 的 `org.gradle.java.home` 固定，不入库 |
| Gradle | 8.14.3（wrapper，已入库） | Capacitor 8.6.2 模板自带 |
| AGP / SDK | AGP 8.7.x；compileSdk 36 / targetSdk 36 / minSdk 24 | `android/variables.gradle` |
| Capacitor | core/cli/android 8.6.2；app 8.1.2、filesystem 8.1.5、share 8.0.3 | 版本由 lockfile 锁定 |
| 验证设备 | Pixel_8 AVD，Android 14（API 34），Google APIs 镜像 | System WebView 113.0.5672.136（镜像无法升级） |
| 应用 | `com.g64_cmd.whalechat` / WhaleChat，androidScheme `https`（origin `https://localhost`） | 发布前 origin 不可再变 |

构建管线（Windows cmd 与 Git Bash 均通过）：`pnpm apk:debug`（build → `cap sync android` → `gradlew assembleDebug`）、`pnpm apk:install`（`adb install -r`）。

## 2. 链路验证结果

### 链路 1 网络 / SSE —— 部分通过，待真实 API Key

| 项 | 结果 | 说明 |
| --- | --- | --- |
| WebView 加载内置 dist | 通过 | `publicPath:'auto'` 相对路径，`https://localhost/static/...` 全部本地命中（logcat `Handling local request`） |
| SSE 增量 / 停止 / 断流 / 上传 | **待真实 API Key** | 需要 DeepSeek 账号的付费 Key；阶段 A 未持有，未调用计费接口 |
| CORS 预判 | 高置信未验证 | Web Pages 版跨 origin 可用；模拟器未装可用的 Chrome 浏览器 app，chrome://inspect 无法完整取证。**待 Key 输入校验（GET /models）时一并验证 401 路径** |
| 模拟器网络限制 | 记录 | 镜像对 gstatic/google.com 连通性探测超时（NetworkMonitor 日志），不影响 api.deepseek.com 直连判断，但真实网络行为以真机为准 |

### 链路 2 语音 —— 待真实 API Key 与真机

- 录音权限链路的声明已就位（Manifest `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS`；Capacitor `BridgeWebChromeClient.onPermissionRequest` 内建运行时授权，无需自定义 Kotlin）。
- `window.isSecureContext` 闸门通过（`https://localhost` 为安全上下文），录音按钮可用。
- ASR / TTS 实际调用与识别率：**待真实 API Key**（ASR/TTS 按量计费）；模拟器需在 Extended controls → Microphone 手动勾选宿主麦克风输入。
- 耳机插拔、来电中断、音频焦点：**待真机**。

### 链路 3 数据 —— 通过（模拟器可自动化部分）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 强杀保留 | 通过 | 导入会话后 `am force-stop` → 重启，会话列表与消息内容完整（IndexedDB 库 `chat-demo` v11 在 WebView origin 下持久） |
| 覆盖安装保留 | 通过 | `adb install -r` 重装同一 APK → 启动直接进入既有会话，数据无丢失 |
| localStorage 持久 | 通过（间接） | locale 设置跨 force-stop / 覆盖安装保持（界面语言不回退） |
| 强杀恢复语义 | 部分验证 | 无进行中流式任务时强杀正常恢复；流式中途强杀的"显示已中断、不自动重发"**待真实 Key 产生流式任务后补测** |

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

以下各项完成后，阶段 A 方可标记"已验证可实施"（方案 3.1 节要求真实 API 与目标设备证据）：

- [ ] **持 Key 方验证**（用户提供 API Key，模拟器即可）：
  - [ ] 设置中输入 Key → `GET /models` 校验通过并保存（同时证明 CORS 预检与请求在 `https://localhost` origin 下全通）
  - [ ] 错误 Key → 401 提示文案正确（apiKeyInvalid）
  - [ ] 流式问答：首帧到达、增量渲染节奏、思考块/搜索/引用展示、停止保留已收内容
  - [ ] 断流：`adb shell cmd connectivity airplane-mode enable/disable` 后错误呈现与恢复
  - [ ] 附件：SAF 选图片/PDF → multipart 上传 → file_id 引用问答
  - [ ] 录音权限弹窗（允许/拒绝各一次）→ ASR 识别入草稿；TTS 朗读与停止
  - [ ] 流式中途 force-stop → 重启显示"已中断"、不自动重发
- [ ] **真机项**（有设备后）：耳机/来电/音频焦点、Android 15 edge-to-edge、云盘 content://、WebView 140+ 行为、覆盖安装从上一版本升级、性能基线
- [ ] **CI**：develop 推送后在 GitHub Actions 首跑 quality.yml（type/lint/web build/JDK21 assembleDebug + APK artifact）

## 5. 阶段 A 实施决策记录

| 决策 | 内容与理由 |
| --- | --- |
| insets 策略 | 不加 `viewport-fit=cover`、不改 CSS：走 Capacitor SystemBars 原生 decor padding，Web 版零变化；未来若需要内容延伸到系统栏后（沉浸式），再切换 passthrough 模式并用 `--safe-area-inset-*` 变量适配 |
| 外链 | 事件委托（捕获阶段拦截 `a[target="_blank"]` http(s)）+ `window.open` 调用点改走 `platform.openExternal`；不引入 @capacitor/browser（系统浏览器已够用） |
| 返回键退出 | 无浮层时 `App.exitApp()` 直接退出；双击退出确认、预测性返回动画适配留阶段 B |
| 导出 | cache + Share 分享面板（含"保存到文件"），替代 WebView 无效的 `a.download`；Web 分支保持原下载行为 |
| 传输层 | 未抽象，直接用 WebView fetch + ReadableStream；`src/platform/index.ts` 注释预留原生传输替换点。若链路 1 持 Key 验证失败，按方案 4.1 评估 Kotlin 原生 SSE 桥 |
