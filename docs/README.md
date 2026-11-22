# Android 项目资料

日期：2026-11-17 ～ 2026-11-22（Asia/Singapore）。建议先阅读[Android 初步改进方案](android-improvement-proposal.md)，再按需要查看实现依据和官方资料。

| 文档 | 用途 |
| --- | --- |
| [初步改进方案](android-improvement-proposal.md) | 路线比较、建议架构、改进优先级、阶段验收与产品决策 |
| [阶段 A 验证记录](android-phase-a-verification.md) | Capacitor 工程与四链路验证结果、环境限制、待办清单与实施决策 |
| [阶段 B 验证记录](android-phase-b-verification.md) | 日常使用功能、上游 v0.1.3 整合、集中 review 修复矩阵及本地回归/构建结果 |
| [阶段 B 性能报告](android-phase-b-perf.md) | 长会话基线与阶段 C 性能待办 |
| [当前项目设计](project-design.md) | 现有源码架构、功能与数据流、协议、存储和 Android 差距 |
| [DeepSeek API 本地资料入口](deepseek-api/README.md) | 完整文档范围、能力导航、更新和校验命令 |
| [官方文档快照目录](deepseek-api/snapshot-2026-11-17/INDEX.md) | 中英文各 71 页的逐页离线入口（快照仅存本地，可重新生成） |
| [第一阶段验证记录](phase-1-verification.md) | 抓取覆盖、哈希/链接校验结果与未做的运行时验收 |

阶段 A 与阶段 B 的已实施内容、历史模拟器证据及剩余真实使用/真机项分别见对应验证记录。2026-11-22 的上游整合、集中 review 修复及测试整理已获用户同意提交；本轮正式回归、类型、lint、Web 与 Android 调试构建通过，未进行新的设备或真实 API 验证。
