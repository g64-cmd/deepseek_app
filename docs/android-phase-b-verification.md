# Android 阶段 B 功能验证记录

日期：2026-11-19 ～ 2026-11-21（Asia/Singapore）。构建基线：`develop` / `0240d6b`（各功能验证时为对应提交的 APK：B2 `fc9d0ad`、B3 `aed8c01`、B4 `4d62531`、B5 `dc3c5ef`、B6/B7 `0240d6b` 含未提交收尾时为最新构建）。
设备与环境同[阶段 A 验证记录](android-phase-a-verification.md)第 1 节（Pixel_8 AVD / API 34 / WebView 113；CDP 自动化驱动 UI，必要时 adb tap 模拟手势）。
性能测量与虚拟化决策独立成文：[阶段 B 性能报告](android-phase-b-perf.md)。

**结论（2026-11-22）**：B2–B7 的模拟器可验证项全部通过；两轮复审共 5+1 个 P2 全部修复，复现用例纳入正式回归（见第 4 节，`pnpm test` 10 项全绿）；剩余项见第 3 节（真实 API 请求快照、带图拦截实操、402/429 自然出现补录、真机项）。

## 1. 功能验证结果

### B2 模型选择与思考强度 —— 通过（模拟器项）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 模型按钮与菜单 | 通过 | ChatInput toggles 行第三个按钮显示当前模型短名（Flash/V4 Pro）；菜单两项，切换后按钮即时更新 |
| 设置项 | 通过 | 通用设置新增「模型」（Select，描述注明 V4 Pro 不支持图片）与「思考强度」（低/高/最高三档 Select） |
| 思考强度切换 | 通过 | High→Max 切换即时生效 |
| 消息徽标 | 通过 | 回复底部显示模型徽标（如 Flash；effort 非 high 时附加 ·最高）；导入历史无模型不显示 |
| 持久化 | 通过 | 切 V4 Pro + Max → force-stop 重启，按钮与 localStorage（`chat-demo:model`、`chat-demo:thinking-effort`）均保持 |
| 能力守卫测试 | 通过 | tests/review/model-guard.test.mjs：非视觉模型只拦图片不拦文档、注册表定价有序、非法持久值拒绝（含 `__proto__`） |
| 带图拦截弹窗/阻止 toast | **待真实使用** | 弹窗与三选交互、regenerate/continue/edit 阻止 toast 需图片草稿/带图历史实操；拦截判定（findBlockedImages/countRequestImages）已被单测覆盖，UI 条件渲染代码路径简单 |
| 真实请求 model/effort 快照 | **待真实使用** | 需持真实 Key 发送；请求组装（`initial.model ?? settings.model`、仅思考开启携带 `output_config.effort`）经代码审查与类型检查 |

### B3 余额与用量 —— 通过（真实数据）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 设置分区 | 通过 | 第三分区「账户」（General/Account/Data 三 tab） |
| 余额（GET /user/balance） | 通过 | 真实 Key：CNY 总余额 51.86 / 赠金 0.00 / 充值 51.86 正确分组展示 + 更新时间；金额字符串原样展示 |
| 用量聚合 | 通过 | 全部会话扫描聚合按模型分组；真实数据 Flash 未命中 67/命中 0/输出 33 与逐条手算一致 |
| 估算区间 | 通过 | ¥0.0002~0.0004 与手算（67×[1,2]/1M + 33×[4,8]/1M）一致；固定标注估算与时段说明 |
| 缓存自动失效 | 通过（间接） | B4 导入 usage 后打开面板：未命中 200=导入 133+原有 67（「会话数+最近更新时间」签名变化触发重算），估算 ¥0.0156~0.0161 与手算（含搜索 3 次×5 元/千次）一致 |

### B4 完整应用备份（归档 v4）—— 通过（闭环）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| v4 导出结构 | 通过 | manifest `{export_format_version:4, archive_kind:"full"}`；全部附件扁平 `files/{file_id}`（含非图片 PDF 与 MIME）；`app_settings.json` 全项设置+草稿、**无 API Key**；消息携带 model/effort/usage 快照 |
| 导入分流确认 | 通过 | v4 确认弹窗显示完整备份专属文案 + 「先导出备份」按钮（触发分享面板存盘）；v3 弹窗维持原文案无此按钮 |
| 闭环恢复 | 通过 | 导出→run-as 拷出→**破坏数据**（删会话、改设置 en-US/flash/low、删草稿）→UI 导入（DocumentsUI→Downloads）：会话、图片与 **PDF 原件**（v3 不含非图片原件）、设置（zh-CN/V4 Pro/Max）、草稿、model/effort/usage 全部无损恢复；状态「已导入 3 个对话，并恢复应用设置与草稿」 |
| v3 回归 | 通过 | A 阶段手造 v3 ZIP（deepseek_data-link.zip）导入不变：正常导入 1 会话、替换语义正确、无设置恢复 |
| 校验链 | 通过 | tmp/b4-debug.mjs（rspack 编译 schema/toLocal/zipReader 逐步断言）对修补后备份全绿；期间发现并修正**注入数据**漏 parentId 导致的 backupInvalidBranches（读取端树校验正确拒绝了坏数据，非代码缺陷） |
| 分块写 | 代码完成 | ≤8MiB 单次 writeFile、否则 4MiB appendFile；大附件导出内存峰值未构造专门场景（真实数据量小），ZIP32 4GiB 上限沿用 ArchiveLimitError 显式报错 |

### B5 附件图片全屏查看 —— 通过

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 打开/关闭 | 通过 | 点击缩略图（adb tap 与 CDP click 双途径）进入全屏黑底查看器；Esc 关闭、返回键只关查看器（会话保留、应用不退出） |
| 双击缩放 | 通过 | 1x↔2.5x 往返，transform-origin 精确命中双击点（206px 458px 实测），0.25s 过渡 |
| 拖拽平移 | 通过 | 放大态 pointerdown(300,500)→move(200,500)：origin x 206→306（图片朝指针方向平移，方向正确） |
| 保存/分享 | 通过 | 底部按钮拉起系统分享面板（Drive 可见）；分享文件写 cache 并进入清理清单（见 B7） |
| Web 行为变化 | 预期改进 | `<a target=_blank>`（WebView 无效）改为内嵌查看器，双端一致 |
| 验证方法备注 | 记录 | uiautomator dump 对 portal 全屏层失明（一度误判未打开），以 CDP DOM 断言为准 |

### B6 双击退出与预测性返回 —— 通过（含结论）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 双击退出 | 通过 | 根界面首次返回：toast「再按一次返回键退出」、应用存活；0.8s 内二次返回：退出到 Launcher；3.5s 超窗二次返回：仅刷新 toast 不退出，随后 0.8s 连按仍可正常退出 |
| 返回层级不破坏 | 通过 | 侧栏打开时返回只关侧栏（无 toast、不退出）；弹窗栈路径未变（既有测试覆盖） |
| 预测性返回兼容实验 | 通过 | 临时开 `android:enableOnBackInvokedCallback="true"` 重装（改动未提交）：backButton JS 事件仍触发（侧栏关闭、双击退出均正常），与调研结论一致 |

**预测性返回结论**：@capacitor/app 8.1.2 的 AppPlugin 向 OnBackPressedDispatcher 注册**常驻** OnBackPressedCallback。开启 flag 后事件仍可收到（功能不破坏），但系统因常驻回调判定应用自消费返回，**不会播放「返回主屏」预测动画**；要得到动画需在根状态 `App.toggleBackButtonHandler({enabled:false})` 放行系统——放行后首次返回直接退出，与双击退出确认互斥。**本轮维持不启用 flag**；若产品改要预测动画：去掉双击退出 + 根状态禁用插件回调 + 开 manifest flag + 真机重测（API 33+ 手势导航下动画属真机复验项）。

### B7 收尾 —— 通过

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 重命名失败提示 | 代码完成 | renameSession 未加载分支改为返回 Promise：失败回滚列表旧标题，UI toast「重命名失败」；已加载分支仍由保存失败红条体系覆盖。模拟器无法稳定构造 IndexedDB 写失败，按代码审查 + 回滚路径类型检查验收 |
| 导出 cache 清理 | 通过 | 预置前缀残留（whalechat-backup-*/deepseek_data-*）+ 非前缀登记文件（viewer-test.png）+ 无关文件（other-file.txt）：启动后前两者删除、无关文件保留；写入口统一登记（`chat-demo:export-cache` 清单），清单+前缀兜底双路清理，清理后清单置空 |
| 清理时机 | 记录 | 不在分享结束后删：「保存到文件」的 SAF 读取完成时机不可知，立即删除可能截断保存；启动时清理必然安全 |

## 2. 错误路径验证策略（401 / 402 / 429）

- **401（可安全构造）**：错误 Key 可实测聊天/上传/余额三处展示。余额面板的 401 文案（accountBalanceErrorUnauthorized）已在代码路径就绪；聊天 401 与 Web 同路径（describe.ts→replyInvalidApiKey+修改入口，阶段 A 已审查）。**待用户换错 Key 时顺带补测一次**（不主动改用户 Keystore 里的真实 Key）。
- **402 / 429（不主动构造）**：无小额余额 Key；压测构造 429 违反合理使用且影响账号限速。策略与阶段 A 拒答路径相同：代码路径审查（classifyStatus 402→insufficientBalance/429→rateLimited、describe.ts 文案、AssistantMessage 充值链接——阶段 A review 级验证过）+ 真实使用中自然出现时按本表补录。402 的余额面板联动（markBalanceStale）已实现：下次打开账户面板自动重拉。
- 拒答路径：沿阶段 A 记录，日常使用自然出现时补记。

## 3. 剩余项

- [ ] **真实使用验证**（用户日常使用中自然覆盖）：V4 Pro 真实请求与思考块差异、effort low/max 效果、带图拦截弹窗三选实操、regenerate/continue 带图阻止 toast、401 三处文案、402/429/拒答自然出现补录
- [ ] **真机项**（沿用阶段 A 清单另加）：预测性返回动画（API 33+ 手势导航）、WebView 140+ 行为、大附件导出内存峰值（真机大文件）
- [ ] 大附件（>100MB 级）导出分块写的实际内存峰值：模拟器数据量小未构成压力场景，真机有真实大附件时用 `adb shell dumpsys meminfo` 记录

## 4. Review 修复记录（2026-11-21 复审，2026-11-22 修复复审收口）

第一轮复审（tmp/develop-review-phase-b-5aa1594.md）发现 5 个 P2，全部确认属实并修复；第二轮复审（tmp/develop-review-phase-b-5a491e8.md）关闭其中 4 项，指出用量缓存失效时机在「保存失败→重试成功」路径上未完整修复（bump 在 persist 发起后立即执行，与保存成败脱钩），已按建议改为**挂在保存成功路径**。复现用例全部纳入正式回归（tests/review/chat-regressions.test.mjs 共 5 项；修复前全败、修复后全过，`pnpm test` 10 项全绿）：

| # | 问题 | 修复 |
| --- | --- | --- |
| 1 | 「仅发送文字」的历史图片在附件准备阶段被 refreshRequest 从会话换回，Pro 请求仍带 image 块 | 图片剔除改为请求级策略（stripRequest）：refreshRequest 换回会话消息后、prepareFiles 补齐后回读时都重新应用；strip 掉的图片也不再进入补传与失效重置范围 |
| 2 | 两个会话共享同一附件时 v4 备份向 ZIP 写入重复条目（files/{id}）导致整份备份失败 | 附件条目改为按最终路径全局去重（Map 收集，所有引用指向同一份原件）；v3 路径含会话 ID 天然互异不受影响 |
| 3 | 生成中途打开账户面板缓存的用量在回答完成后不失效（流式结束不改会话列表元数据，签名不变） | 用量缓存签名加入数据修订号（chat-demo:usage-revision）。**递增时机（二轮修正）**：persist 增加用法标注，流式收尾的保存与失败重试保存（retrySaveSessions）在**保存成功回调**里递增；保存失败期间数据库是旧数据、修订号未动，缓存与数据保持一致，不会用新签名缓存旧统计。导入/清空替换与删除会话仍在提交成功后递增 |
| 4 | 换 API Key 后旧账户的在途余额响应写入新账户的状态与缓存 | 请求代次（requestEpoch）：每次刷新与缓存清理递增，过期响应（成功与失败）一律丢弃并复位 loading |
| 5 | 图片查看器缩放原点用了遮罩坐标，双击目标在图片有居中留白时偏移 | 改用图片自身边界（1x 时无变换，rect 即未缩放位置）计算局部坐标；模拟器留白场景断言：1200×400 宽图在 412 宽视口上下留白 341px，双击点 origin=288px 110px 与局部坐标一致（旧实现会偏 341px） |
