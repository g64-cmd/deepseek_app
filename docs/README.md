# Android 项目资料

日期：2026-11-17 ～ 2026-11-18（Asia/Singapore）。建议先阅读[Android 初步改进方案](android-improvement-proposal.md)，再按需要查看实现依据和官方资料。

| 文档 | 用途 |
| --- | --- |
| [初步改进方案](android-improvement-proposal.md) | 路线比较、建议架构、改进优先级、阶段验收与产品决策 |
| [阶段 A 验证记录](android-phase-a-verification.md) | Capacitor 工程与四链路验证结果、环境限制、待办清单与实施决策 |
| [当前项目设计](project-design.md) | 现有源码架构、功能与数据流、协议、存储和 Android 差距 |
| [DeepSeek API 本地资料入口](deepseek-api/README.md) | 完整文档范围、能力导航、更新和校验命令 |
| [官方文档快照目录](deepseek-api/snapshot-2026-11-17/INDEX.md) | 中英文各 71 页的逐页离线入口（快照仅存本地，可重新生成） |
| [第一阶段验证记录](phase-1-verification.md) | 抓取覆盖、哈希/链接校验结果与未做的运行时验收 |

阶段 A（工程基础）已实施：Capacitor 8 Android 工程（`com.g64_cmd.whalechat`）、`src/platform/` 平台适配层、返回键/外链/导出桥接与 CI 门禁已入库，调试 APK 可在 Windows 构建。数据与文件链路已在模拟器验证通过；网络/语音链路需真实 API Key 后按[验证记录](android-phase-a-verification.md)第 4 节清单补测。未调用任何付费 API。
