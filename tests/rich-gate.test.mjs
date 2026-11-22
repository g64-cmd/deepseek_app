import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { compile, root } from './helpers/compile.mjs'

/**
 * C1 富内容按需渲染回归：
 * 1) 已结束回答中的代码块/图表/展示公式在进入视口预取范围前保留可读源码，
 *    不执行高亮、语言包加载或图表绘制；
 * 2) 进入预取范围或获得焦点后增强并保留，流式内容始终立即渲染，
 *    流式期间已渲染的块在回答结束后不退回源码形态；
 * 3) Mermaid 串行队列最新请求优先、跳过已取消任务、单图失败不阻塞后续。
 * 编译真实门控/调度器/组件，仅替换 react、prismjs、mermaid 包与高亮/公式服务。
 */
const runtimeDir = path.join(root, 'tests/helpers/runtime')
const mainRuntime = path.join(runtimeDir, 'rich-gate.cjs')
const packageMocks = new Map([
  ['react', mainRuntime],
  ['react/jsx-runtime', mainRuntime],
  ['react/jsx-dev-runtime', mainRuntime],
  ['prismjs', path.join(runtimeDir, 'rich-gate-prism.cjs')],
  ['mermaid', path.join(runtimeDir, 'rich-gate-mermaid.cjs')],
])
const moduleMocks = new Set(
  [
    'src/services/markdown/highlight.js',
    'src/services/markdown/katex.js',
    'src/app/theme.js',
    'src/i18n/index.js',
    'src/components/base/icons.js',
    'src/components/base/toastState.js',
    'src/utils/clipboard.js',
  ].map((name) => path.join(root, name))
)
const originalIO = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver')

class FakeIntersectionObserver {
  static instances = []
  static unobserved = []
  constructor(callback, options) {
    this.callback = callback
    this.options = options
    this.observed = new Set()
    FakeIntersectionObserver.instances.push(this)
  }
  observe(element) {
    this.observed.add(element)
  }
  unobserve(element) {
    this.observed.delete(element)
    FakeIntersectionObserver.unobserved.push(element)
  }
  disconnect() {
    this.observed.clear()
  }
  fire(element, isIntersecting = true) {
    this.callback([{ target: element, isIntersecting }], this)
  }
}

let api
let scrollRef

before(async () => {
  globalThis.IntersectionObserver = FakeIntersectionObserver
  const replacements = new Map([
    ...packageMocks,
    ...[...moduleMocks].map((absolute) => [absolute, mainRuntime]),
  ])
  api = await compile('./tests/helpers/entries/rich-gate.ts', 'rich-gate', replacements)
})

beforeEach(() => {
  api.hooks.cleanup()
  api.fixture.reset()
  api.resetContextValues()
  FakeIntersectionObserver.instances.length = 0
  FakeIntersectionObserver.unobserved.length = 0
  scrollRef = { current: {} }
})

after(() => {
  api?.hooks.cleanup()
  if (originalIO) Object.defineProperty(globalThis, 'IntersectionObserver', originalIO)
  else delete globalThis.IntersectionObserver
})

const flush = () => new Promise((resolve) => setImmediate(resolve))
const settle = async (rounds = 4) => {
  for (let i = 0; i < rounds; i++) await flush()
}
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of [node.props?.children].flat(Infinity)) {
    const match = find(child, predicate)
    if (match) return match
  }
  return null
}
const findPre = (tree) => find(tree, (node) => node.type === 'pre')
const observer = () => FakeIntersectionObserver.instances.at(-1)

/** 在真实 useRichGateRoot 供给的 Context 下渲染被测组件（memo 为恒等，可直接调用） */
const renderGated = (component, props) => {
  const wrapper = (wrapperProps) => {
    const gateRoot = api.useRichGateRoot(scrollRef, 'test')
    api.setContextValue(api.RichGateContext, gateRoot)
    return component(wrapperProps.props)
  }
  return api.hooks.render(wrapper, { props })
}

test('off-screen code block keeps source text without highlighting or language loading', () => {
  const props = { code: 'const answer = 42', infostring: 'json' }
  renderGated(api.CodeBlock, props)
  let tree = renderGated(api.CodeBlock, props)
  const block = find(tree, (node) => node.props?.['data-rich-kind'] === 'code')
  assert.equal(block.props['data-rich-ready'], 'false')
  const pre = findPre(tree)
  assert.equal(pre.props.children, 'const answer = 42', 'source text stays readable')
  assert.equal(pre.props.dangerouslySetInnerHTML, undefined)
  assert.deepEqual(api.fixture.highlightCalls, [], 'no Prism work off-screen')
  assert.deepEqual(api.fixture.loadCalls, [], 'no language pack fetch off-screen')
})

test('entering the prefetch range enhances the code block once and keeps it', () => {
  const props = { code: 'const answer = 42', infostring: 'json' }
  renderGated(api.CodeBlock, props)
  const tree = renderGated(api.CodeBlock, props)
  const block = find(tree, (node) => node.props?.['data-rich-kind'] === 'code')
  observer().fire(block)
  const enhanced = renderGated(api.CodeBlock, props)
  assert.ok(findPre(enhanced).props.dangerouslySetInnerHTML, 'highlight runs after entering')
  assert.deepEqual(api.fixture.loadCalls, ['json'])
  assert.ok(FakeIntersectionObserver.unobserved.includes(block), 'entry unobserves the block')
  // 离开视口（不再有观察）后增强保留：再次渲染不回到源码形态
  const again = renderGated(api.CodeBlock, props)
  assert.ok(findPre(again).props.dangerouslySetInnerHTML)
})

test('focus inside an off-screen block activates enhancement', () => {
  const props = { code: 'const answer = 42', infostring: 'json' }
  const tree = renderGated(api.CodeBlock, props)
  const block = find(tree, (node) => node.props?.['data-rich-kind'] === 'code')
  block.props.onFocus()
  const focused = renderGated(api.CodeBlock, props)
  assert.ok(findPre(focused).props.dangerouslySetInnerHTML, 'focus replaces source view')
})

test('streaming code blocks render immediately and stay enhanced after completion', async () => {
  const streaming = { code: 'const answer = 42', infostring: 'json', loading: true }
  // 流式：不等待观察，立即高亮并加载语言包
  let tree = renderGated(api.CodeBlock, streaming)
  assert.ok(findPre(tree).props.dangerouslySetInnerHTML, 'streaming tail renders immediately')
  assert.deepEqual(api.fixture.loadCalls, ['json'])
  await settle()
  tree = renderGated(api.CodeBlock, streaming)
  assert.equal(
    find(tree, (node) => node.props?.['data-rich-kind'] === 'code').props['data-rich-ready'],
    'true'
  )
  // 回答结束（loading=false）后不退回源码形态等待观察
  const completed = { code: 'const answer = 42', infostring: 'json', loading: false }
  tree = renderGated(api.CodeBlock, completed)
  assert.ok(
    findPre(tree).props.dangerouslySetInnerHTML,
    'completed reply keeps its already-rendered block'
  )
})

test('off-screen mermaid keeps source and mounts the diagram only after entering', async () => {
  const props = { code: 'flowchart TD\n  a --> b', infostring: 'mermaid' }
  renderGated(api.CodeBlock, props)
  let tree = renderGated(api.CodeBlock, props)
  const block = find(tree, (node) => node.props?.['data-rich-kind'] === 'mermaid-code')
  assert.equal(block.props['data-rich-ready'], 'false')
  assert.equal(findPre(tree).props.children, 'flowchart TD\n  a --> b')
  assert.deepEqual(api.fixture.renderCalls, [], 'no mermaid render off-screen')

  observer().fire(block)
  tree = renderGated(api.CodeBlock, props)
  assert.ok(find(tree, (node) => node.props?.['data-rich-kind'] === 'mermaid'), 'diagram mounts')
  await settle()
  tree = renderGated(api.CodeBlock, props)
  const diagram = find(tree, (node) => node.props?.['data-rich-kind'] === 'mermaid')
  assert.equal(diagram.props['data-rich-ready'], 'true')
  assert.match(diagram.props.dangerouslySetInnerHTML.__html, /flowchart TD/)
})

test('off-screen display math keeps TeX source and renders KaTeX after entering', () => {
  const props = { value: 'E = mc^2', loading: false }
  renderGated(api.MathBlock, props)
  let tree = renderGated(api.MathBlock, props)
  const math = find(tree, (node) => node.props?.['data-rich-kind'] === 'math')
  assert.equal(math.props['data-rich-ready'], 'false')
  assert.equal(math.props.children, 'E = mc^2', 'TeX source stays readable')
  assert.deepEqual(api.fixture.katexCalls, [], 'no KaTeX layout off-screen')

  observer().fire(math)
  tree = renderGated(api.MathBlock, props)
  assert.deepEqual(api.fixture.katexCalls, ['E = mc^2'])
  assert.ok(find(tree, (node) => node.props?.className?.includes?.('katex-display')))
})

test('streaming display math renders immediately', () => {
  const tree = renderGated(api.MathBlock, { value: 'E = mc^2', loading: true })
  assert.deepEqual(api.fixture.katexCalls, ['E = mc^2'])
  assert.ok(find(tree, (node) => node.props?.className?.includes?.('katex-display')))
})

test('blocks outside a message list (no provider) render fully', () => {
  api.resetContextValues()
  const tree = api.hooks.render(api.CodeBlock, { code: 'x', infostring: 'json' })
  assert.ok(findPre(tree).props.dangerouslySetInnerHTML, 'no provider means immediate rendering')
})

test('environments without IntersectionObserver keep immediate rendering', () => {
  delete globalThis.IntersectionObserver
  try {
    renderGated(api.CodeBlock, { code: 'x', infostring: 'json' })
    renderGated(api.CodeBlock, { code: 'x', infostring: 'json' })
    const tree = renderGated(api.CodeBlock, { code: 'x', infostring: 'json' })
    assert.ok(
      findPre(tree).props.dangerouslySetInnerHTML,
      'legacy fallback enhances without an observer'
    )
  } finally {
    globalThis.IntersectionObserver = FakeIntersectionObserver
  }
})

test('mermaid serial queue draws the newest request first and skips cancelled jobs', async () => {
  let releaseRender
  api.fixture.renderGate = new Promise((resolve) => {
    releaseRender = resolve
  })
  const first = api.renderMermaid('graph A', false, () => false)
  const second = api.renderMermaid('graph B', false, () => false)
  const stale = api.renderMermaid('graph stale', false, () => true)
  await settle()
  assert.deepEqual(
    api.fixture.renderCalls.map((call) => call.code),
    ['graph B'],
    'the newest request is drawn first'
  )
  releaseRender()
  const values = await Promise.all([first, second, stale])
  assert.deepEqual(
    api.fixture.renderCalls.map((call) => call.code),
    ['graph B', 'graph A'],
    'cancelled jobs are dropped without drawing'
  )
  assert.equal(values[2], null)
  for (const value of [values[0], values[1]]) assert.match(value, /svg/)
})

test('a failing mermaid job rejects only its caller and the queue continues', async () => {
  api.fixture.failRenderFor.add('graph bad')
  const bad = api.renderMermaid('graph bad', false, () => false)
  const good = api.renderMermaid('graph good', false, () => false)
  await assert.rejects(bad, /Fixture mermaid failure/)
  assert.match(await good, /svg/)
  assert.deepEqual(
    api.fixture.renderCalls.map((call) => call.code),
    ['graph good', 'graph bad']
  )
})
