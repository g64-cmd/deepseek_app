# Android C0 测量工具

本工具在独立包 `com.g64_cmd.whalechat.c0` 中运行固定合成数据，不配置 Key，不发起聊天/上传请求。C0 仅增加测量标识，不实施按需渲染、虚拟化或数据库迁移。旧 `scripts/perf-seed.js` 保留为阶段 B 历史复现工具，不用于新指标。

## C3 历史检索验证

`run-history-search-android.mjs` 使用 production Web + `-Pc0Perf` debug APK，核对预先安装的独立 C0 包与所选 APK 的 SHA-256；驱动本身不安装 APK，误选常规输出会拒绝继续。此驱动会替换该测试包中已知前缀的合成数据；遇到未知会话 ID 拒绝继续，不操作日常包 `com.g64_cmd.whalechat`。API 域名被阻断，本地 `https://localhost` 异步资源正常加载。

按下文方式构建并安装 C0 APK，启动 Pixel_8 后执行：

```powershell
node scripts/perf/run-history-search-android.mjs --apk=android/app/build/outputs/apk/debug/app-debug.apk --output=tmp/c3-android --cold=5 --warm=10
```

可传 `--serial`、`--adb`（与 C0 一样使用 `--参数=值`）。输出必须在仓库 `tmp/` 内。驱动仅注入固定 C0 的 1,000 个列表会话（2,000 条消息、826,000 字节正文），先采集标题过滤、正文首批与完成耗时，再另加一个深层未选分支验证路径、目标富内容就绪、焦点和 Android 返回。冷样本每次重启应用进程，热样本同进程重新改词；不清系统/磁盘缓存。正文时间含 160ms 防抖，完成时间另跨两次 rAF；标题时间为输入到过滤结果提交并跨两次 rAF。长任务只覆盖正文查询窗口。

该夹具的首轮工程目标为标题结果 <100ms、正文首批 <1s、完成 <5s；完整原始样本与设备信息留在报告中，少于 20 次不报告 P95。它不验证千个长会话、混合富内容性能矩阵或峰值内存，真机与 TalkBack 另验。浏览器组件/IndexedDB 与输入竞争回归见 `pnpm test:c3`。

## 构建与运行

前提是 JDK 21、现有 Android SDK/AVD 和依赖已安装。模拟器与 ADB 需在操作系统允许的环境运行；构建缓存的权限与普通项目写权限不同。

在仓库根目录执行：

```powershell
$env:NODE_ENV = 'production'
pnpm build:android
Push-Location android
.\gradlew.bat assembleDebug -Pc0Perf --offline --no-daemon
Pop-Location
# 先检查 output-metadata.json 中 applicationId 确为 com.g64_cmd.whalechat.c0。
adb -s emulator-5554 install -r android/app/build/outputs/apk/debug/app-debug.apk
pnpm perf:c0 --serial=emulator-5554 --cold=5 --warm=10 --memory --trace
```

`-Pc0Perf` 只为 debug 添加 `.c0` 包名后缀与 C0 名称；常规构建不传该参数。C0 APK 与常规 debug APK 输出到同一路径，安装前必须核对包名。它打包 production Web 资源，同时保留 Android debug 的 CDP 连接能力，不作为签名发布性能证据。

驱动会对比设备实际安装包与本地选定 APK 的 SHA-256。默认使用上述 debug 输出；若已保存 C0 APK，可通过 `--apk=tmp/c0/某次构建/app-c0.apk` 选择。源码修改后仍须重新构建/安装，二进制匹配本身不证明源码已经编入该 APK；保留当时的 runtime patch 与工具副本。

Node 24 提供内置 WebSocket。ADB 路径按 `--adb=路径`、`ANDROID_SDK_ROOT`/`ANDROID_HOME`、`android/local.properties`、PATH 的顺序解析。参数均用 `--name=value`；布尔开关直接写 `--trace` 等，不支持用 `=false` 关闭。

输出默认放在新的 `tmp/c0/时间戳/` 目录；可用 `--output=tmp/c0/自定义目录`。每个样本后写 `results.json`，诊断 trace 单独保存。`--skip-matrix --memory --trace --reuse-fixture` 可只补内存/trace；复用仅接受同一夹具源码哈希及相同记录数量的隔离测试库。不要同时运行两个驱动，它们共用 9223 端口和同一个测试包。

首次运行要求 sessions、summaries、files 和两张 staging 表全部为空；注入通过一个事务完成，碰到已有记录即拒绝。工具不执行清库/前缀删除。需要重新生成数据时，只能针对已确认的 C0 测试包清除数据；日常应用的数据不属于此操作范围。

清单另存于工具专用 `whalechat-c0-metadata` IndexedDB，通过严格持久性事务完成后再强停，不依赖 localStorage 写入后的退出时机。完整备份导入会规范化消息 ID，之后若要重新运行渲染驱动，应重建独立测试库；复用检查会拒绝已重编号的夹具。

## 固定数据与清单

`fixtures.mjs` 固定版本、UTC 时间和伪随机种子，生成 1,007 个会话：300 条纯文本、300 条混合、50 条重图表、10 条图片、10 个消息节点的多层分支、一条长尾单答（开头两条屏外公式 + 长正文 + 末尾可见公式）、一个备份会话，以及 1,000 个列表会话。分支默认可见 6 条消息，另外 4 条位于其他分支。

混合场景包含 30 个 800 行代码块、240 个 display 公式、30 张 30 节点 Mermaid；重图表场景包含 13 张 Mermaid、96 个公式。统计由生成内容计算，并有回归检查。

图片使用种子生成 5 张 2048×1536 PNG；另有约 64 MiB 的单页 PDF，总原件超过 100 MiB。图片在不同浏览器编码器间可能字节不同，所以每次实测记录文件字节、尺寸和 SHA-256。图片与备份会话共享同一原件，用于去重验收。文件全部离线，不将归档规模当作服务端上传额度。

## 指标定义

- `shellPaintProxyMs`：从程序化点击会话项，到目标会话节点出现并跨过两次 rAF。它是 DOM 提交后的绘制机会代理，不是屏幕实际首帧。
- `tailPaintProxyMs`：v2 从同一起点，到目标尾消息进入可见区、末轮两条消息中的富内容/图片与字体就绪，再跨过两次 rAF。不逐个测全历史块的几何信息；随后等待当前已挂载富内容任务结束，再开始下个样本。v1 按全部可见块检查，结果中 `measurementVersion` 缺省为 1；不同版本的样本分别保留。v3 起，样本间等待（settle）排除屏外门控块（`data-rich-gated="true"`，C1 按需渲染下有意保持未增强且无任务执行）。**v4 起，末轮就绪只等待视口内可见的富内容块**——同一回答开头的屏外门控块保留源码形态不算未就绪，可见但未增强的块仍计入等待；就绪范围记为 `tail-round-visible`，样本另含 `richOffscreen` 计数。附件（含未挂载的 `data-image-count` 缺失统计）与字体检查不变。
- 观察窗目标为点击起 3 秒；如果可读时间或主线程阻塞超过 3 秒，记录实际窗口和超出量，不裁掉冻结。长任务按实际窗口截取，分别记录总时长、最大值及 `Σ max(0, duration−50ms)`，不称作页面加载 TBT。**v4 起，驱动的每次切换把长任务观察延伸到该轮已启动增强任务结束**（`settleInside`，样本含 `settleUntilMs`/`observedUntilMs`）：尾部可读时间定义不变，但窗口之后仍在执行的主线程阻塞计入该样本统计，不再漏记。
- rAF 帧间隔直接报告中位数、P95 和最大值，FPS 为中位帧间隔的倒数；不能用这一中位数否认首切长任务。滚动从底部以 1,500 CSS px/s 上行，最多 6 秒或到顶即停，按实际时间推进并报告距离，不代表遍历全会话。
- 冷样本每次 force-stop/启动应用进程，再从小会话切至目标；Android/磁盘缓存未清除。热样本先预热对应场景，再做 10 次切换。两者都不等于全新安装或设备冷启动。
- `am start -W` 保留原生 TotalTime；Node 到“可交互”的上界还包含 CDP 连接和关闭初始设置的耗时，单列报告，不叫真实首帧。
- 每组少于 20 个样本只报告中位数与最大值，保留全部原始值；诊断 trace 的样本不混入无 trace 统计。
- 内存先排除一轮预热，再往返混合/图片 20 次；第 0/5/10/20 次均停在同一图片会话、静置 10 秒，记录应用与全部 WebView sandbox renderer 的 PID、存活时长、PSS 及 JS 堆。**每轮往返的切换耗时与长任务结果逐轮保存**（`memoryRounds`，观察覆盖整轮操作），“N 轮无冻结”以这组数据为证据。专用 AVD 上若存在其他 WebView，也会被列入，需辨认；JS 堆不再叠加到 PSS。此项是静置采样，不是峰值测量。

PSS 使用 `dumpsys meminfo --local PID`，由系统本地收集，避免回调目标进程。首次正式运行在直接调用旧 WebView 的 `dumpMemInfo` 路径时发生 native 崩溃；已保留失败记录，后续改用该模式。每个进程记录采样时间，分进程采样并非原子快照。

浏览器 `performance.memory` 是[非标准且可能不准确的辅助估计](https://developer.mozilla.org/en-US/docs/Web/API/Performance/memory)，不能据几个相同值断言 JS 堆没有增长，也不能替代 PSS。必要时单列 CDP `Runtime.getHeapUsage` 补充值，并记录采样上下文；不强制 GC。

当前驱动的检查点会同时保存 `heapCdp`；旧结果缺少该字段时表示当时未采集，不用后来的值回填。

用 `node scripts/perf/summarize.mjs tmp/c0/运行目录/results.json` 生成摘要。原始报告记录代码提交、工作区运行时代码 diff 哈希、关键源码哈希、APK 哈希、production 标识、设备/WebView、视口和夹具文件哈希；比较优化版时保持这些条件一致。

## 证据范围

渲染驱动结束并退出后，可以运行 `node scripts/perf/run-scale.mjs --output=tmp/c0/scale`，在同一独立测试包中测用量冷/热缓存、完整备份生成和原生缓存写入、覆盖恢复及原件哈希。它通过现有设置界面操作，不增加产品测试入口；备份阶段记录 Filesystem 调用时间，拦截 Share 请求以免启动接收应用，随后从原生缓存读回 ZIP，经 DOM File 输入进行恢复。此项不验证 SAF/分享接收应用。

规模驱动每 2 秒采样应用与 WebView PSS，报告的最大值仅是采样观察值。两次采样之间可能有更高瞬时峰值，生成 ZIP 到首次 native mkdir 也只是 ZIP 完成时间的上界。恢复校验包含 1,006 会话、六份原件哈希和其他分支节点；低存储与失败恢复仍需专项场景。

`node scripts/perf/analyze-trace.mjs 路径/render-trace.json` 汇总 trace 的最长事件及布局/绘制/GC。事件时长包含子事件且互相重叠，不能相加得 CPU 百分比，也不能据事件名称直接认定根因。

较低性能真机、主力真机、现代 WebView、TalkBack 和存储失败路径仍按阶段 C 验收清单推进。工具运行结束不等于阶段 C 整体验收通过。
