import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildFixture,
  describeFixture,
  installFixture,
  randomBytes,
  PREFIX,
} from '../scripts/perf/fixtures.mjs'
import { summarizeFrames, summarizeLongtasks, visibleState } from '../scripts/perf/browser.mjs'
import { branchShape } from '../scripts/perf/branch-shape.mjs'

test('C0 fixture counts describe actual code, formula and graph payloads', () => {
  const manifest = describeFixture(buildFixture())
  const mixed = manifest.sessions.find((s) => s.id === PREFIX + 'mixed')
  assert.equal(manifest.sessions.length, 1007)
  assert.deepEqual(
    [mixed.messages, mixed.codeBlocks, mixed.codeLines, mixed.displayMath, mixed.mermaid],
    [300, 30, 24000, 240, 30]
  )
  const heavy = manifest.sessions.find((s) => s.id === PREFIX + 'heavy')
  assert.deepEqual(
    [heavy.messages, heavy.users, heavy.assistants, heavy.mermaid, heavy.displayMath],
    [50, 25, 25, 13, 96]
  )
  // 长尾场景：单条回答开头两条屏外公式 + 末尾可见公式，无代码/图表
  const longtail = manifest.sessions.find((s) => s.id === PREFIX + 'longtail')
  assert.deepEqual(
    [longtail.messages, longtail.users, longtail.assistants, longtail.displayMath],
    [2, 1, 1, 3]
  )
  assert.deepEqual(buildFixture(), buildFixture())
  assert.deepEqual(randomBytes(100), randomBytes(100))
  assert.notDeepEqual(randomBytes(100, 1), randomBytes(100, 2))
})

test('C0 branch fixture retains a valid alternate path with alternating roles', () => {
  const session = buildFixture().sessions.find((s) => s.id === PREFIX + 'branches')
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  for (const message of session.messages) {
    if (message.parentId) {
      assert.notEqual(byId.get(message.parentId).role, message.role)
    } else {
      assert.equal(message.id, session.rootMessageId)
    }
    if (message.selectedChildId) {
      assert.equal(byId.get(message.selectedChildId).parentId, message.id)
    }
  }
  let id = session.rootMessageId
  const visible = []
  while (id) {
    visible.push(id)
    id = byId.get(id).selectedChildId
  }
  assert.equal(visible.length, 6)
  assert.equal(session.messages.length, 10)
})

test('C0 backup validation accepts message renumbering and still detects changed branches', () => {
  const original = buildFixture().sessions.find((session) => session.id === PREFIX + 'branches')
  const renamed = structuredClone(original)
  const ids = new Map(original.messages.map((message, index) => [message.id, String(index + 1)]))
  renamed.rootMessageId = ids.get(original.rootMessageId)
  renamed.messages = renamed.messages.map((message) => ({
    ...message,
    id: ids.get(message.id),
    parentId: message.parentId ? ids.get(message.parentId) : null,
    selectedChildId: message.selectedChildId ? ids.get(message.selectedChildId) : undefined,
  }))
  assert.deepEqual(branchShape(renamed), branchShape(original))
  renamed.messages[1].selectedChildId = renamed.messages[6].id
  assert.notDeepEqual(branchShape(renamed), branchShape(original))
  renamed.messages[1].selectedChildId = 'missing'
  assert.throws(() => branchShape(renamed), /unknown message/)
})

// Transaction boundary substitute: writes become visible only on completion.
function database({ nonempty, failAdd = false } = {}) {
  const committed = []
  return {
    committed,
    transaction() {
      let aborted = false
      const writes = []
      const tx = {
        error: null,
        abort() {
          if (!aborted) {
            aborted = true
            queueMicrotask(() => tx.onabort?.())
          }
        },
        objectStore(name) {
          return {
            count() {
              const request = {}
              queueMicrotask(() => {
                if (!aborted) {
                  request.result = name === nonempty ? 1 : 0
                  request.onsuccess()
                }
              })
              return request
            },
            add(value) {
              if (failAdd) {
                tx.error = new Error('Injected storage failure')
                tx.abort()
              } else {
                writes.push({ name, value })
              }
            },
          }
        },
      }
      setImmediate(() => {
        if (!aborted) {
          committed.push(...writes)
          tx.oncomplete()
        }
      })
      return tx
    },
  }
}

test('C0 injection refuses nonempty data in every store without changing records', async () => {
  const fixture = buildFixture()
  for (const nonempty of [
    'sessions',
    'sessionSummaries',
    'files',
    'sessionsStaging',
    'filesStaging',
  ]) {
    const db = database({ nonempty })
    await assert.rejects(installFixture(db, fixture), /empty isolated database/)
    assert.equal(db.committed.length, 0)
  }
})

test('C0 injection commits only the full fixture and rolls back failed storage', async () => {
  const fixture = buildFixture()
  const db = database()
  await installFixture(db, fixture)
  assert.equal(db.committed.filter((write) => write.name === 'sessions').length, 1007)
  assert.equal(db.committed.filter((write) => write.name === 'sessionSummaries').length, 1007)
  const failing = database({ failAdd: true })
  await assert.rejects(installFixture(failing, fixture), /Injected storage failure/)
  assert.equal(failing.committed.length, 0)
})

test('C0 longtask metrics clip to the observation window and distinguish duration from blocking', () => {
  const result = summarizeLongtasks(
    [
      { startTime: 0, duration: 120 },
      { startTime: 150, duration: 100 },
      { startTime: 290, duration: 100 },
      { startTime: 500, duration: 100 },
    ],
    100,
    300
  )
  assert.equal(result.count, 3)
  assert.equal(result.totalMs, 130)
  assert.equal(result.maxMs, 100)
  assert.equal(result.blockingMs, 50)
})

test('C0 reports frame latency percentiles directly, with unavailable metrics kept null', () => {
  const result = summarizeFrames([...Array(18).fill(16), 40, 100])
  assert.equal(result.medianMs, 16)
  assert.equal(result.p95Ms, 40)
  assert.equal(result.maxMs, 100)
  assert.equal(result.medianFps, 62.5)
  assert.equal(summarizeFrames([]).medianFps, null)
})

test('C0 tail readiness ignores historical geometry and waits for tail attachments', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS')
  globalThis.CSS = { escape: (value) => value }
  const image = { complete: true, naturalWidth: 2048 }
  const question = {
    dataset: { messageRole: 'user', imageCount: '1' },
    querySelectorAll: (selector) => (selector === 'img' ? [image] : []),
  }
  const tail = {
    dataset: { messageRole: 'assistant' },
    previousElementSibling: question,
    getBoundingClientRect: () => ({ top: 40, bottom: 500 }),
    querySelectorAll: () => [],
  }
  const view = {
    querySelector: () => tail,
    querySelectorAll: () => {
      throw new Error('Historical geometry must not be scanned')
    },
  }
  const scroll = {
    scrollTop: 0,
    getBoundingClientRect: () => ({ height: 600, top: 0, bottom: 600 }),
  }
  globalThis.document = {
    fonts: { status: 'loaded' },
    querySelector: (selector) => (selector.includes('data-message-scroll') ? scroll : view),
  }
  try {
    assert.equal(visibleState('fixture', 'tail').ready, true)
    image.naturalWidth = 0
    assert.equal(visibleState('fixture', 'tail').ready, false)
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'document', descriptor)
    } else {
      delete globalThis.document
    }
    if (cssDescriptor) {
      Object.defineProperty(globalThis, 'CSS', cssDescriptor)
    } else {
      delete globalThis.CSS
    }
  }
})

test('C0 tail readiness waits for visible rich blocks but not off-screen gated ones', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS')
  globalThis.CSS = { escape: (value) => value }
  const rich = (rect, ready, gated) => ({
    dataset: gated ? { richReady: ready, richGated: 'true' } : { richReady: ready },
    getBoundingClientRect: () => rect,
  })
  // 同一条长回答末轮：开头公式远在视口上方（门控源码形态），末尾公式可见
  const offscreenGated = rich({ height: 60, top: -3296, bottom: -3236 }, 'false', true)
  const visibleReady = rich({ height: 60, top: 100, bottom: 160 }, 'true')
  const visibleGated = rich({ height: 60, top: 300, bottom: 360 }, 'false', true)
  const tail = {
    dataset: { messageRole: 'assistant' },
    getBoundingClientRect: () => ({ top: 40, bottom: 500 }),
    querySelectorAll: (selector) =>
      selector === '[data-rich-kind]'
        ? [offscreenGated, visibleReady, visibleGated]
        : selector === 'img'
          ? []
          : [],
  }
  const view = { querySelector: () => tail }
  const scroll = {
    scrollTop: 3000,
    getBoundingClientRect: () => ({ height: 600, top: 0, bottom: 600 }),
  }
  globalThis.document = {
    fonts: { status: 'loaded' },
    querySelector: (selector) => (selector.includes('data-message-scroll') ? scroll : view),
  }
  try {
    const state = visibleState('fixture', 'tail')
    assert.equal(state.ready, false, 'a visible gated block is still pending')
    assert.equal(state.pending, 1)
    assert.equal(state.rich, 2, 'only visible rich blocks are waited on')
    assert.equal(state.richOffscreen, 1, 'off-screen gated block is excluded, not missing')
    visibleGated.dataset.richReady = 'true'
    const ready = visibleState('fixture', 'tail')
    assert.equal(ready.ready, true, 'off-screen gated block no longer blocks tail readiness')
    assert.equal(ready.richOffscreen, 1)
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'document', descriptor)
    } else {
      delete globalThis.document
    }
    if (cssDescriptor) {
      Object.defineProperty(globalThis, 'CSS', cssDescriptor)
    } else {
      delete globalThis.CSS
    }
  }
})
