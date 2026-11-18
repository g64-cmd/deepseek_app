# 平台适配层回归测试

起源：`288ca1c` 的 develop review 发现两项运行时缺陷（返回键绕过最上层弹窗、外链捕获阶段抢先于嵌套引用角标），本目录保留其定向复现作为回归用例。修复于平台适配层入库后，两项均通过。

在仓库根目录运行，使用现有 Node.js 24 和已安装的 Rspack，不安装额外依赖：

```sh
pnpm test
# 或
node --test tests/review/platform-regressions.test.mjs
```

新增测试文件时在 `package.json` 的 `test` 脚本中追加路径（Node 24 在 Windows 下对目录参数的发现不稳定，故显式列出文件）。

覆盖的两个场景：

1. 设置弹窗上叠加确认框时，Android back 只关闭最上层弹窗、底层设置保持、不退出（对照：Escape 同路径）。
2. Markdown 链接内嵌引用角标（`[text [citation:1]](url)`）点击只打开引用来源；普通外链对照只委托打开一次。

测试直接编译并执行 `Modal.tsx`、`CitationLink.tsx`、`parse.ts`、`backButton.ts`、`externalLinks.ts`，没有为被测实现打桩。DOM 事件按真实顺序建模：document 捕获 → 目标 handler（代表 React 根容器委托）→ document 冒泡；React hooks/JSX 渲染、状态仓库与 Capacitor 插件使用最小替身。测试构建输出放在已忽略的 `tmp/review-platform/`。

这些是控制流与组件回调的单元级断言，不代表真实 React 调度、Android 系统浏览器表现、设备生命周期或真实 API 已通过验证。
