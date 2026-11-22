import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { before, after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { rspack } from '@rspack/core'

/**
 * 阶段 B review（tmp/develop-review-phase-b-5aa1594.md、tmp/develop-review-phase-b-5a491e8.md）
 * 检出的 5 个回归：
 * 1) dropHistoryImages 在附件准备阶段被 refreshRequest 恢复历史图片；
 * 2) 跨会话共享附件使 v4 完整备份生成重复 ZIP 条目；
 * 3) 生成期间缓存的用量在回答完成后不失效；
 * 4) 换 Key 后旧余额请求写入新账户缓存；
 * 5) 最终保存失败后重试成功，仍沿用旧用量缓存（修订号需挂在保存成功路径）。
 * 编译真实聊天服务模块，仅替换 IndexedDB / Keystore / 翻译，fetch 由用例接管。
 */
const root = fileURLToPath(new URL('../../', import.meta.url))
const runtimePath = path.join(root, 'tests/review/chat-regressions-runtime.cjs')
const mockedModules = new Set(
  ['src/services/chat/db.js', 'src/platform/secureStorage.js', 'src/i18n/index.js'].map(
    (name) => path.join(root, name)
  )
)
const keys = ['fetch', 'localStorage', 'document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame']
const originalGlobals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
let api

before(async () => {
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, String(value))
    },
    removeItem: (key) => {
      storage.delete(key)
    },
    clear: () => storage.clear(),
  }
  // 最小事件目标：visibilityState 保持 hidden（流式增量立即 flush，跳过 rAF），
  // 事件方法供 bindChatPersistence 注册与用例派发 visibilitychange/pagehide
  const makeEventTarget = () => {
    const listeners = new Map()
    return {
      addEventListener(type, handler) {
        if (!listeners.has(type)) {
          listeners.set(type, new Set())
        }
        listeners.get(type).add(handler)
      },
      removeEventListener(type, handler) {
        listeners.get(type)?.delete(handler)
      },
      dispatchEvent(event) {
        for (const handler of listeners.get(event.type) ?? []) {
          handler(event)
        }
        return true
      },
    }
  }
  globalThis.document = { visibilityState: 'hidden', ...makeEventTarget() }
  globalThis.window = makeEventTarget()
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  const compiler = rspack({
    context: root,
    mode: 'development',
    target: 'node',
    devtool: false,
    entry: './tests/review/chat-regressions-entry.ts',
    output: {
      path: path.join(root, 'tmp/review-chat-regressions'),
      filename: 'review.cjs',
      library: { type: 'commonjs2' },
    },
    resolve: { extensions: ['.tsx', '.ts', '.js'], extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          loader: 'builtin:swc-loader',
          options: { jsc: { parser: { syntax: 'typescript', tsx: true }, target: 'es2022' } },
        },
      ],
    },
    plugins: [
      new rspack.DefinePlugin({ __API_ORIGIN__: JSON.stringify('https://fixture.invalid') }),
      new rspack.NormalModuleReplacementPlugin(/./, (resource) => {
        if (mockedModules.has(path.resolve(resource.context, resource.request))) {
          resource.request = runtimePath
        }
      }),
    ],
  })
  await new Promise((resolve, reject) =>
    compiler.run((error, stats) =>
      compiler.close((closeError) => {
        if (error || closeError) reject(error ?? closeError)
        else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })))
        else resolve()
      })
    )
  )
  api = createRequire(import.meta.url)(path.join(root, 'tmp/review-chat-regressions/review.cjs'))
})

after(() => {
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

const image = {
  id: 'shared-image',
  serverId: 'file-existing',
  name: 'image.png',
  size: 3,
  isImage: true,
  mimeType: 'image/png',
}
const session = (id) => ({
  id,
  title: id,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  messages: [
    {
      id: `${id}-user`,
      role: 'user',
      content: 'Describe this picture',
      files: [image],
      createdAt: 1_700_000_000_000,
    },
    {
      id: `${id}-reply`,
      role: 'assistant',
      model: 'deepseek-flash',
      thinking: false,
      search: false,
      prefix: true,
      status: 'done',
      stopReason: 'end_turn',
      blocks: [{ type: 'text', text: 'A picture.' }],
      createdAt: 1_700_000_000_001,
    },
  ],
})

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 100 && predicate(); attempt++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

test('Pro text-only confirmation excludes historical images from the actual HTTP request', async () => {
  const history = session('history')
  api.useChatStore.setState({
    ready: true,
    importingHistory: false,
    sessions: [history],
    sessionCache: { history },
    streaming: {},
    activeId: 'history',
  })
  api.setApiKey('fixture-only')
  api.setModel('deepseek-v4-pro')
  api.setDraftText('history', 'Continue with text only')
  let requestBody
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body)
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  assert.equal(api.sendMessage('history', { dropHistoryImages: true }), true)
  await waitFor(() => api.useChatStore.getState().streaming.history)
  assert.ok(requestBody, 'production streamMessage must reach the mocked HTTP boundary')
  assert.equal(requestBody.model, 'deepseek-v4-pro')
  const images = requestBody.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'image')
      : []
  )
  assert.equal(images.length, 0, `text-only request unexpectedly contains ${images.length} image block(s)`)
})

test('full backup supports an attachment shared by two valid sessions', async () => {
  api.runtime.files.set(image.id, new Blob(['png'], { type: 'image/png' }))
  const sessions = [session('first'), session('second')]
  // Control: each session alone and the shared pair in the legacy format both succeed.
  assert.ok((await api.exportArchive([sessions[0]], { full: true })).size > 0)
  assert.ok((await api.exportArchive(sessions)).size > 0)
  const archive = await api.exportArchive(sessions, { full: true })
  assert.ok(archive.size > 0)
})

test('a balance response from a replaced API key cannot refill the new account cache', async () => {
  api.setApiKey('fixture-account-A')
  let resolveFetch
  globalThis.fetch = () =>
    new Promise((resolve) => {
      resolveFetch = resolve
    })
  const refresh = api.refreshBalance()
  api.setApiKey('fixture-account-B')
  assert.equal(api.useBalance.getState().data, null, 'changing keys clears the old cache initially')
  resolveFetch(
    Response.json({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '123.00', granted_balance: '0.00', topped_up_balance: '123.00' },
      ],
    })
  )
  await refresh
  assert.equal(api.useBalance.getState().data, null, 'account A response must be discarded after switching to account B')
})

test('usage cached during generation is recomputed after the same reply completes', async () => {
  localStorage.clear()
  api.runtime.sessions.clear()
  const empty = {
    id: 'usage-session',
    title: 'usage-session',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    messages: [],
  }
  api.useChatStore.setState({
    ready: true,
    importingHistory: false,
    sessions: [empty],
    sessionCache: { [empty.id]: empty },
    streaming: {},
    activeId: empty.id,
  })
  api.setModel('deepseek-flash')
  api.setDraftText(empty.id, 'A harmless usage fixture')
  let streamController
  let requested = false
  globalThis.fetch = async () => {
    requested = true
    return new Response(
      new ReadableStream({
        start(controller) {
          streamController = controller
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  }
  assert.equal(api.sendMessage(empty.id), true)
  for (let i = 0; i < 100 && !requested; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(requested, true)
  const during = await api.getUsageSummary()
  assert.equal(during.replies, 0)
  const timestamp = api.runtime.sessions.get(empty.id).updatedAt
  const usage = { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }
  const events = [
    { type: 'message_start', message: { usage } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'A harmless answer.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
    { type: 'message_stop' },
  ]
  streamController.enqueue(new TextEncoder().encode(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')))
  streamController.close()
  await waitFor(() => api.useChatStore.getState().streaming[empty.id])
  const saved = api.runtime.sessions.get(empty.id)
  assert.equal(saved.messages.at(-1).usage.output_tokens, 10, 'completed usage must already be persisted')
  assert.equal(saved.updatedAt, timestamp, 'normal production completion retains the summary timestamp')
  const completed = await api.getUsageSummary()
  localStorage.removeItem('chat-demo:usage-summary')
  const uncached = await api.getUsageSummary()
  assert.equal(uncached.models['deepseek-flash']?.output, 10, 'control: scanning the same persisted data without the stale cache is correct')
  assert.equal(completed.models['deepseek-flash']?.output, 10, 'reopening the account panel must include the completed response')
})

test('usage cache is invalidated when saving a completed response succeeds on retry', async () => {
  localStorage.clear()
  api.runtime.sessions.clear()
  const id = 'save-retry-session'
  const empty = {
    id,
    title: id,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    messages: [],
  }
  api.useChatStore.setState({
    ready: true,
    importingHistory: false,
    sessions: [empty],
    sessionCache: { [id]: empty },
    streaming: {},
    activeId: id,
    sessionSaveErrors: {},
  })
  api.setModel('deepseek-flash')
  api.setDraftText(id, 'A harmless save retry fixture')
  const usage = { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }
  const events = [
    { type: 'message_start', message: { usage } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'A harmless answer.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
    { type: 'message_stop' },
  ]
  globalThis.fetch = async () =>
    new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  // 注入最终保存失败：流式完成后的 persist 落盘被拒，数据库保留旧 pending 快照
  api.runtime.rejectCompletedSave = true
  assert.equal(api.sendMessage(id), true)
  for (let i = 0; i < 100 && !api.useChatStore.getState().sessionSaveErrors[id]; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(api.useChatStore.getState().sessionSaveErrors[id], true, 'the production store exposes the failed transaction')
  assert.equal(
    api.useChatStore.getState().sessionCache[id].messages.at(-1).usage.output_tokens,
    10,
    'the in-memory response is retained'
  )
  // 失败期间打开面板：聚合数据库旧快照。修订号未递增，缓存与旧数据保持一致（非污染）
  const beforeRetry = await api.getUsageSummary()
  assert.equal(beforeRetry.replies, 0, 'failed transaction leaves the previous pending snapshot in storage')
  const revisionBeforeRetry = localStorage.getItem('chat-demo:usage-revision')
  // 存储恢复后重试保存（真实 UI 的保存失败提示重试入口）
  api.runtime.rejectCompletedSave = false
  api.retrySaveSessions()
  for (let i = 0; i < 100 && api.useChatStore.getState().sessionSaveErrors[id]; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(api.useChatStore.getState().sessionSaveErrors[id], undefined, 'the save error clears after successful retry')
  assert.equal(
    api.runtime.sessions.get(id).messages.at(-1).usage.output_tokens,
    10,
    'the retry has committed the completed usage'
  )
  const completed = await api.getUsageSummary()
  localStorage.removeItem('chat-demo:usage-summary')
  const uncached = await api.getUsageSummary()
  assert.equal(uncached.models['deepseek-flash']?.output, 10, 'control: fresh aggregation reads the committed usage correctly')
  assert.equal(
    completed.models['deepseek-flash']?.output,
    10,
    `successful retry must invalidate cached usage; revision before=${revisionBeforeRetry}, after=${localStorage.getItem('chat-demo:usage-revision')}`
  )
})

// 同一失败恢复问题在另外两个真实保存入口（自动保存 / 重命名）下的复现：
// 用量缓存失效不能依赖调用方标注，任意入口提交成功都必须生效
for (const recovery of ['visibilitychange', 'rename']) {
  test(`usage is invalidated when failed final save is recovered through ${recovery}`, async () => {
    localStorage.clear()
    api.runtime.sessions.clear()
    const id = `recover-${recovery}`
    const empty = {
      id,
      title: id,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      messages: [],
    }
    api.useChatStore.setState({
      ready: true,
      importingHistory: false,
      sessions: [empty],
      sessionCache: { [id]: empty },
      streaming: {},
      activeId: id,
      sessionSaveErrors: {},
    })
    api.setModel('deepseek-flash')
    api.setDraftText(id, 'A harmless persistence recovery fixture')
    const usage = { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }
    const events = [
      { type: 'message_start', message: { usage } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'A harmless answer.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
      { type: 'message_stop' },
    ]
    globalThis.fetch = async () =>
      new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    api.runtime.rejectCompletedSave = true
    assert.equal(api.sendMessage(id), true)
    for (let i = 0; i < 100 && !api.useChatStore.getState().sessionSaveErrors[id]; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(api.useChatStore.getState().sessionSaveErrors[id], true)
    assert.equal(api.useChatStore.getState().sessionCache[id].messages.at(-1).usage.output_tokens, 10)
    // 失败期间账户面板缓存数据库旧数据（修订号未动，缓存与旧数据一致）
    const pending = await api.getUsageSummary()
    assert.equal(pending.replies, 0, 'the failed transaction leaves old data for the account panel to cache')
    const revisionBefore = localStorage.getItem('chat-demo:usage-revision')
    api.runtime.rejectCompletedSave = false
    if (recovery === 'visibilitychange') {
      // 真实生产监听器：切后台/离开页面触发的自动保存
      const cleanup = api.bindChatPersistence()
      try {
        document.visibilityState = 'hidden'
        document.dispatchEvent(new Event('visibilitychange'))
      } finally {
        cleanup()
      }
    } else {
      // 已加载会话的重命名：整份会话随标题一同保存
      assert.equal(await api.renameSession(id, 'Recovered title'), true)
    }
    for (let i = 0; i < 100 && api.useChatStore.getState().sessionSaveErrors[id]; i++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(api.useChatStore.getState().sessionSaveErrors[id], undefined, 'recovery clears the production save error')
    assert.equal(api.runtime.sessions.get(id).messages.at(-1).usage.output_tokens, 10, 'recovery commits the completed usage')
    const cached = await api.getUsageSummary()
    localStorage.removeItem('chat-demo:usage-summary')
    const uncached = await api.getUsageSummary()
    assert.equal(uncached.models['deepseek-flash']?.output, 10, 'control: reading committed data without cache is correct')
    assert.equal(
      cached.models['deepseek-flash']?.output,
      10,
      `recovery=${recovery}, revision=${revisionBefore}->${localStorage.getItem('chat-demo:usage-revision')}`
    )
  })
}
