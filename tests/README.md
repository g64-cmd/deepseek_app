# 功能测试

这里保留需要持续维护的功能、无障碍与数据安全回归测试；测试按模块组织，不读取真实凭据、不发起外部网络请求。

## 运行

在仓库根目录执行：

```sh
# 默认 Node 回归测试（CI 门禁，12 个模块）
pnpm test

# 单独运行一个模块
node --test tests/requests.test.mjs

# 真实浏览器无障碍与布局回归（需本机安装 Chrome / Edge / Chromium，可用 C2_BROWSER 指定路径）
pnpm test:c2

# 真实浏览器历史检索与分支定位回归（可用 C3_BROWSER 指定路径）
pnpm test:c3
```

## 测试模块

| 文件 | 覆盖范围 |
| --- | --- |
| `chat.test.mjs` | 用量提交与失败恢复、账户隔离、共享附件、备份草稿/原件/设置、未知模型导入与缓存 |
| `storage.test.mjs` | 并发重命名、中途加载、删除/替换历史后的旧异步回调 |
| `models.test.mjs` | 模型图片能力限制、持久化模型与思考强度的输入校验 |
| `requests.test.mjs` | 图片缩放与上传表单、20 文档聚合上限守卫、缺失附件重试/省略、文档重解析授权与取消、新旧备份兼容、回复链接过滤 |
| `attachment-policy.test.mjs` | 上传前计费确认与取消、文字/图文解析模式选择、导入期间守卫、重新解析/缺失附件按钮的请求路径 |
| `upload-lifecycle.test.mjs` | 排队停止、共享上传任务、迟到成功与部分成功保存、缓存复用及失败后重新授权 |
| `attachment-view.test.mjs` | MIME/SVG 处理、Blob URL 生命周期、文件交付、内嵌全屏图片查看器与浮层行为 |
| `native-files.test.mjs` | Android 分享文件身份、分块写入、写入/清理失败恢复、启动清理与并发分享 |
| `settings.test.mjs` | 设置分组的界面点击与程序导航 |
| `platform.test.mjs` | Android 返回键优先级栈与外链/引用点击委托 |
| `rich-gate.test.mjs` | 富内容视口门控按需增强（代码高亮/公式/Mermaid）、流式立即渲染、Mermaid 队列最新优先与失败隔离 |
| `history-search.test.mjs` | 标题/全分支正文检索、跨块命中、取消与限量、完整祖先路径与环/孤儿防护、并发与中断恢复 |
| `accessibility-browser.test.mjs` | 真实浏览器键盘与焦点管理（浮层/菜单/导入确认/草稿图片查看器）、图片 MIME 拦截、320px/200% 字体缩放与触控目标尺寸 |
| `history-search-browser.test.mjs` | 真实浏览器组件/IndexedDB 历史检索、深层未选分支富内容定位与锚点、取消竞态、千会话规模与 320px/200% 抽屉布局 |

## 目录与隔离说明

- `helpers/entries/`：导出被测生产模块或浏览器测试入口。
- `helpers/runtime/`：提供存储、浏览器和平台边界的轻量替身。
- `helpers/compile.mjs` 与两个浏览器测试套件均在系统临时目录（`os.tmpdir()`）中创建隔离编译/配置目录并在结束后自动清理，不向仓库写入临时文件。
- 浏览器测试在独立无头配置下阻止外部 HTTPS 请求，不纳入默认 `pnpm test`，避免无浏览器 CI 环境阻塞。
- 新增默认 Node 测试模块时，请同步更新 `package.json` 的 `test` 文件列表以保证本地与 CI 一致。
