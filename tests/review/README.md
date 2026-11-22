# 定向回归测试

起源：develop review 陆续发现的运行时缺陷，修复后将其定向复现保留为回归用例。

- **platform-regressions**（`288ca1c` review）：返回键绕过最上层弹窗、外链捕获阶段抢先于嵌套引用角标。
- **model-guard**（阶段 B2）：非视觉模型只拦图片不拦文档、模型注册表定价有序、非法持久值拒绝。
- **chat-regressions**（阶段 B review，`5aa1594`/`5a491e8`/`fb96db8` 三轮）：dropHistoryImages 被附件刷新恢复、共享附件使 v4 备份产生重复条目、生成期间缓存的用量不失效、换 Key 后旧余额请求写入新缓存、保存失败→重试/自动保存/重命名恢复成功后用量缓存仍失效不完整（现行方案：会话级「待落盘用量」标记，任意保存入口成功统一失效）。

在仓库根目录运行，使用现有 Node.js 24 和已安装的 Rspack，不安装额外依赖：

```sh
pnpm test
# 或
node --test tests/review/platform-regressions.test.mjs tests/review/model-guard.test.mjs tests/review/chat-regressions.test.mjs
```

新增测试文件时在 `package.json` 的 `test` 脚本中追加路径（Node 24 在 Windows 下对目录参数的发现不稳定，故显式列出文件）。

platform-regressions 覆盖的两个场景：

1. 设置弹窗上叠加确认框时，Android back 只关闭最上层弹窗、底层设置保持、不退出（对照：Escape 同路径）。
2. Markdown 链接内嵌引用角标（`[text [citation:1]](url)`）点击只打开引用来源；普通外链对照只委托打开一次。

测试直接编译并执行 `Modal.tsx`、`CitationLink.tsx`、`parse.ts`、`backButton.ts`、`externalLinks.ts`，没有为被测实现打桩。DOM 事件按真实顺序建模：document 捕获 → 目标 handler（代表 React 根容器委托）→ document 冒泡；React hooks/JSX 渲染、状态仓库与 Capacitor 插件使用最小替身。测试构建输出放在已忽略的 `tmp/review-platform/`。

chat-regressions 编译真实聊天服务（store / drafts / settings / 备份 / 用量 / 余额），仅替换 IndexedDB（内存 Map）、Keystore（关闭）、翻译（透传）；fetch 完全由用例接管（受控 SSE 与挂起请求），不产生 API 费用。构建输出在已忽略的 `tmp/review-chat-regressions/`。

这些是控制流与组件回调的单元级断言，不代表真实 React 调度、Android 系统浏览器表现、设备生命周期或真实 API 已通过验证。
