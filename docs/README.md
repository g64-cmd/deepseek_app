# Android 项目资料

日期：2026-11-17 ～ 2026-11-22（Asia/Singapore）。建议先阅读[Android 初步改进方案](android-improvement-proposal.md)，再按需要查看实现依据和官方资料。

| 文档 | 用途 |
| --- | --- |
| [初步改进方案](android-improvement-proposal.md) | 路线比较、建议架构、改进优先级、阶段验收与产品决策 |
| [阶段 A 验证记录](android-phase-a-verification.md) | Capacitor 工程与四链路验证结果、环境限制、待办清单与实施决策 |
| [阶段 B 验证记录](android-phase-b-verification.md) | 日常使用功能、上游 v0.1.3 整合、集中 review 修复矩阵及本地回归/构建结果 |
| [阶段 B 性能报告](android-phase-b-perf.md) | 长会话基线与阶段 C 性能待办 |
| [阶段 C 推进方案](android-phase-c-plan.md) | 当前源码研究、测量校准、富内容渲染、可访问性、历史检索与附件可靠性实施顺序 |
| [C0 测量与基线](android-phase-c0-baseline.md) | 固定夹具、独立测试包、75 样本矩阵、trace、20 轮内存及大备份闭环与证据索引 |
| [当前项目设计](project-design.md) | 现有源码架构、功能与数据流、协议、存储和 Android 差距 |
| [DeepSeek API 本地资料入口](deepseek-api/README.md) | 完整文档范围、能力导航、更新和校验命令 |
| [官方文档快照目录](deepseek-api/snapshot-2026-11-17/INDEX.md) | 中英文各 71 页的逐页离线入口（快照仅存本地，可重新生成） |
| [第一阶段验证记录](phase-1-verification.md) | 抓取覆盖、哈希/链接校验结果与未做的运行时验收 |

阶段 A 与阶段 B 的已实施内容、历史模拟器证据及剩余真实使用/真机项分别见对应验证记录。2026-11-22 的上游整合、集中 review 修复及测试整理已获用户同意提交；本轮正式回归、类型、lint、Web 与 Android 调试构建通过，未进行新的设备或真实 API 验证。

阶段 C 已于 2026-11-22 完成研究、C0 工具和离线模拟器基线；代码基线为 `develop@981428e` 加 C0 测量改动。当前 74 项回归、类型、lint、Web、C0 与常规 debug 构建通过。C1–C4 功能及目标真机验收按新方案推进，不将模拟器基线等同阶段 C 通过。
