/** Browser-side C0 measurement. No API calls; imported over CDP into the isolated app. */
export const MEASUREMENT_VERSION = 3
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
const paintOpportunity = async () => {
  await frame()
  await frame()
}
const escape = (value) => CSS.escape(value)
const viewport = () => document.querySelector('[data-message-scroll="true"]')

// Keep tool metadata out of the application's v11 schema. Transaction completion is
// awaited before force-stop; a localStorage write is not a durable shutdown barrier.
async function metadataDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('whalechat-c0-metadata', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('manifest')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function readManifest() {
  const db = await metadataDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('manifest').objectStore('manifest').get('active')
      request.onsuccess = () => resolve(request.result ?? null)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

export async function writeManifest(manifest) {
  const db = await metadataDatabase()
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('manifest', 'readwrite', { durability: 'strict' })
      transaction.objectStore('manifest').put(manifest, 'active')
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('C0 manifest write aborted'))
    })
  } finally {
    db.close()
  }
}

export async function waitFor(predicate, timeoutMs = 180_000) {
  const start = performance.now()
  while (true) {
    const value = predicate()
    if (value) {
      return value
    }
    if (performance.now() - start > timeoutMs) {
      throw new Error('C0 readiness timeout')
    }
    await frame()
  }
}

export function summarizeLongtasks(entries, start, end) {
  const tasks = entries
    .map(({ startTime, duration }) => ({
      startMs: Math.max(startTime, start) - start,
      durationMs: Math.max(0, Math.min(startTime + duration, end) - Math.max(startTime, start)),
    }))
    .filter((task) => task.durationMs > 0)
  return {
    count: tasks.length,
    maxMs: Math.max(0, ...tasks.map((task) => task.durationMs)),
    totalMs: tasks.reduce((n, task) => n + task.durationMs, 0),
    blockingMs: tasks.reduce((n, task) => n + Math.max(0, task.durationMs - 50), 0),
    tasks,
  }
}

export function summarizeFrames(intervals) {
  const sorted = [...intervals].sort((a, b) => a - b)
  const percentile = (p) =>
    sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null
  const medianMs = percentile(0.5)
  return {
    count: sorted.length,
    medianMs,
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1) ?? null,
    medianFps: medianMs ? 1000 / medianMs : null,
  }
}

function observe() {
  const entries = []
  let observer = null
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    observer = new PerformanceObserver((list) => entries.push(...list.getEntries()))
    observer.observe({ type: 'longtask' })
  }
  const frames = []
  let running = true
  let raf
  const tick = (time) => {
    frames.push(time)
    if (running) {
      raf = requestAnimationFrame(tick)
    }
  }
  raf = requestAnimationFrame(tick)
  return async (start, end) => {
    // Delivery of the task containing the click must get an event-loop opportunity.
    await sleep(0)
    if (observer) {
      entries.push(...observer.takeRecords())
    }
    observer?.disconnect()
    running = false
    cancelAnimationFrame(raf)
    const within = frames.filter((time) => time >= start && time <= end)
    const intervals = within.slice(1).map((time, n) => time - within[n])
    return {
      longtasksSupported: observer !== null,
      longtasks: observer ? summarizeLongtasks(entries, start, end) : null,
      frames: summarizeFrames(intervals),
    }
  }
}

function viewOf(sessionId) {
  return document.querySelector(`[data-session-view="${escape(sessionId)}"]`)
}

export function visibleState(sessionId, tailId) {
  const view = viewOf(sessionId)
  const scroll = viewport()
  const tail = view?.querySelector(`[data-message-id="${escape(tailId)}"]`)
  if (!tail || !scroll) {
    return { ready: false }
  }
  const bounds = scroll.getBoundingClientRect()
  const tailBounds = tail.getBoundingClientRect()
  if (bounds.height <= 0 || tailBounds.bottom <= bounds.top || tailBounds.top >= bounds.bottom) {
    return { ready: false }
  }
  // Bound the probe to the final round. Do not synchronously measure every
  // historical rich block, even when hundreds of them are outside the viewport.
  const previous = tail.previousElementSibling
  const rows = previous?.dataset.messageRole === 'user' ? [previous, tail] : [tail]
  const rich = rows.flatMap((row) => [...row.querySelectorAll('[data-rich-kind]')])
  const images = rows.flatMap((row) => [...row.querySelectorAll('img')])
  const missingImages = rows
    .filter((row) => row.dataset.imageCount)
    .reduce(
      (count, row) =>
        count + Math.max(0, Number(row.dataset.imageCount) - row.querySelectorAll('img').length),
      0
    )
  const errors = rich.filter((element) => element.dataset.richReady === 'error').length
  const pending =
    rich.filter((element) => element.dataset.richReady !== 'true').length +
    images.filter((image) => !image.complete || image.naturalWidth === 0).length +
    missingImages +
    (document.fonts.status === 'loaded' ? 0 : 1)
  return {
    ready: pending === 0,
    errors,
    pending,
    rich: rich.length,
    images: images.length,
    missingImages,
    scope: 'tail-round',
    scrollTop: scroll.scrollTop,
    tailTop: tailBounds.top,
  }
}

export async function settle(sessionId, timeoutMs = 180_000) {
  await waitFor(() => {
    const view = viewOf(sessionId)
    // C1 按需渲染下，屏外门控块（data-rich-gated）有意保持 'false' 且没有
    // 正在执行的任务；就绪等待只跟踪已开始增强的块。
    return view && !view.querySelector('[data-rich-ready="false"]:not([data-rich-gated="true"])')
  }, timeoutMs)
  await paintOpportunity()
  const errors = viewOf(sessionId).querySelectorAll('[data-rich-ready="error"]').length
  if (errors) {
    throw new Error(`C0 rich render failed: ${sessionId}, ${errors} blocks`)
  }
}

export async function switchTo(sessionId, tailId, { windowMs = 3000, timeoutMs = 180_000 } = {}) {
  if (viewOf(sessionId)) {
    throw new Error('C0 switch requires a different current session')
  }
  let item = document.querySelector(`[data-session-item="${escape(sessionId)}"]`)
  if (!item) {
    document.querySelector('[data-open-sidebar]')?.click()
    item = await waitFor(() => document.querySelector(`[data-session-item="${escape(sessionId)}"]`))
  }
  const finish = observe()
  const start = performance.now()
  performance.mark('c0-switch-start', { detail: sessionId })
  try {
    item.click()
    await waitFor(() => viewOf(sessionId), timeoutMs)
    await paintOpportunity()
    const shellPaintProxyMs = performance.now() - start
    await waitFor(() => visibleState(sessionId, tailId).ready, timeoutMs)
    await paintOpportunity()
    const tailPaintProxyMs = performance.now() - start
    if (tailPaintProxyMs < windowMs) {
      await sleep(windowMs - tailPaintProxyMs)
    }
    const end = performance.now()
    const observation = await finish(start, end)
    const view = viewOf(sessionId)
    return {
      sessionId,
      shellPaintProxyMs,
      tailPaintProxyMs,
      targetWindowMs: windowMs,
      actualWindowMs: end - start,
      windowOverrunMs: Math.max(0, end - start - windowMs),
      visible: visibleState(sessionId, tailId),
      domNodes: view.querySelectorAll('*').length,
      renderedMessages: view.querySelectorAll('[data-message-id]').length,
      ...observation,
      heap: heap(),
    }
  } catch (error) {
    await finish(start, performance.now())
    throw error
  } finally {
    performance.mark('c0-switch-end', { detail: sessionId })
  }
}

export async function scrollPass(durationMs = 6000, pixelsPerSecond = 1500) {
  const scroll = viewport()
  if (!scroll) {
    throw new Error('C0 message scroller missing')
  }
  scroll.scrollTop = scroll.scrollHeight
  await paintOpportunity()
  const initialTop = scroll.scrollTop
  const finish = observe()
  const start = performance.now()
  let previous = start
  while (performance.now() - start < durationMs && scroll.scrollTop > 0) {
    const time = await frame()
    scroll.scrollTop = Math.max(0, scroll.scrollTop - ((time - previous) * pixelsPerSecond) / 1000)
    previous = time
  }
  const end = performance.now()
  return {
    actualWindowMs: end - start,
    pixelsPerSecond,
    initialTop,
    finalTop: scroll.scrollTop,
    moved: initialTop - scroll.scrollTop,
    reachedTop: scroll.scrollTop <= 0,
    ...(await finish(start, end)),
    heap: heap(),
  }
}

export function heap() {
  const memory = performance.memory
  return memory
    ? {
        usedBytes: memory.usedJSHeapSize,
        totalBytes: memory.totalJSHeapSize,
        limitBytes: memory.jsHeapSizeLimit,
      }
    : null
}

export async function dismissInitialSettings() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await paintOpportunity()
  if (document.querySelector('[role="dialog"]')) {
    throw new Error('C0 initial settings did not close')
  }
}
