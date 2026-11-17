# 第一阶段交付与验证记录

日期：2026-11-17（Asia/Singapore）。代码审查基线：`develop` / `5d5dd75`。

## 本轮交付

1. [现有项目设计与 Android 差距](project-design.md)：基于源码和新官方文档的静态核对，包含关键代码位置。
2. [完整官方 API 资料快照](deepseek-api/README.md)：中英文正文、Schema、示例、官方图片、本地导航、来源及校验清单。
3. [初步改进方案](android-improvement-proposal.md)：候选技术路线、建议架构、优先级、实施阶段、验收条件及待审阅决策。
4. 文档同步/校验脚本、Git 换行与格式化保护，以及中英文 README 的资料入口。

## 实际检查结果

| 检查 | 结果 | 证据或边界 |
| --- | --- | --- |
| 工作分支 | `develop` | 开始及收尾检查均在该分支；没有切换到 main |
| 官方目录覆盖 | 140 / 140 页 | 中文/英文 sitemap 各 70 页，两个清单均保存到 inventory |
| 导航补充 | 2 页 | 中英文 comparison_testing，官网已将内容标为过时；原样保留 |
| 文档总数 | 142 页 | 每语言 71 页；source 原文和 pages 离线链接版各一份 |
| API 参考完整性 | 每语言 15 页 | Schema 引用均有本页定义；原文请求/响应及代码示例保留 |
| 正文官方图片 | 162 个 URL / 142 个文件 | 按内容 SHA-256 去重，包含动图；另保留一个第三方 Reasonix logo 外链 |
| 文件 SHA-256 | 429 个文件通过 | 284 份 Markdown + 142 个图片文件 + 3 个站点目录文件 |
| 离线文件链接 | 986 条通过 | 不把 fenced/inline code 里的示例路径当真实导航；不检查所有标题锚点或远端网站 |
| 原文与离线版差异 | 独立复核通过 | 只加来源说明与改写归档链接；fenced 代码块保持一致 |
| 清单与磁盘一致性 | 独立复核通过 | 归档内容无缺失或未记录文件，INDEX / manifest 为生成索引元文件 |
| 抓取失败 / 缺页 / 未解析官方文档链接 | 均为 0 | 见 manifest 的 failures / missing_sitemap_pages / unresolved_official_links |
| Python 工具语法 | 通过 | Python 解析与编译检查；不依赖第三方包 |
| Git 换行保护 | 通过 | `git check-attr text` 对 source/pages/inventory 均返回 unset，防止 core.autocrlf 改变校验字节 |
| 应用源代码变动 | 无 | 本轮未修改 src、依赖、锁文件、构建入口或 CI |

快照文件合计约 **124 MiB**，最大单文件约 9.9 MiB；主要体积来自官方截图和动图。它们用于开发查阅，不是拟随 APK 打包的应用资源。

## 复核命令

在仓库根目录执行：

```powershell
python -X utf8 scripts/verify_deepseek_docs.py docs/deepseek-api/snapshot-2026-11-17
git diff --check
git branch --show-current
git check-attr text -- docs/deepseek-api/snapshot-2026-11-17/source/zh-cn/api/create-message.md
```

校验结果为 `errors: []`。同步程序实际抓取过官方页面和官方 CDN，发现并修正了一处官网旧页面不带尾斜杠返回首页的问题；未将其返回的 HTTP 200 首页当作成功文档。已完成的快照禁止原地再次同步，后续创建新快照再审阅差异。

## 验证范围

本轮未安装应用依赖、执行 pnpm type/lint/build、启动 Web 客户端、调用需要 API Key 的真实接口、构建 Android 工程、操作模拟器/真机、测试签名安装或发布。方案和设计中“已有功能”指代码存在，不表示本轮已进行运行时验收。

文档校验不能证明最新 API 组合、服务器计费、官方历史导入、Android WebView 流式网络/录音、系统权限或升级可靠性已通过。四条技术验证链、实际服务组合和设备验收仍属于后续工作。第一阶段仅完成调研、资料归档和待审阅方案。

所有变动保留在 develop 工作区；本轮未提交、推送或发布。
