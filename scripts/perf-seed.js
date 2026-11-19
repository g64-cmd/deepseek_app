/**
 * WhaleChat 长对话性能测量：合成数据注入与测量辅助（阶段 B1）。
 *
 * 在 App 的 WebView 控制台（chrome://inspect）粘贴本文件执行，然后：
 *   await perfSeed.inject()          注入合成会话与附件（全部 id 带 perf- 前缀，只新增不修改）
 *   await perfSeed.cleanup()         删除全部 perf- 前缀记录
 *   await perfSeed.stats()           查看注入统计
 *   await perfMeasure.switchTo(title)  点击侧栏会话，测切换首帧与全量渲染完成
 *   await perfMeasure.scrollPass(ms)   当前会话内向上匀速滚动，统计 FPS 与 longtask
 *   perfMeasure.heap()                 当前 JS 堆用量（字节）
 *
 * 注入后 App 内存中的会话列表不会自动刷新，需要重启应用（adb am force-stop + am start）。
 * 注入只新增记录、不修改既有数据；仍建议注入前先做一次历史导出备份。
 */
;(() => {
  'use strict'

  const PREFIX = 'perf-'
  const DAY = 24 * 60 * 60 * 1000
  const now = Date.now()

  const open = () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open('chat-demo')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })

  const putAll = (db, store, values) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite')
      for (const value of values) {
        tx.objectStore(store).put(value)
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })

  const getAll = (db, store) =>
    new Promise((resolve, reject) => {
      const req = db.transaction(store).objectStore(store).getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })

  const clearPrefixed = (db, store) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite')
      const objectStore = tx.objectStore(store)
      const req = objectStore.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) {
          return
        }
        if (typeof cursor.key === 'string' && cursor.key.startsWith(PREFIX)) {
          cursor.delete()
        }
        cursor.continue()
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })

  // ---------- 内容模板 ----------

  const filler =
    '这是一个用于性能测量的合成段落，模拟真实问答中出现的中文与 English 混排文本，' +
    '包含标点、数字 12345、代码标识符 getMessageUsage，以及较长的从句结构。'

  const textAnswer = (i) =>
    `第 ${i} 轮回答。\n\n${Array.from({ length: 6 }, () => filler).join('\n\n')}`

  const codeAnswer = (i) =>
    `第 ${i} 轮回答（长代码块）。\n\n\`\`\`ts\n${Array.from(
      { length: 200 },
      (_, line) =>
        `export function handler${i}_${line}(input: PipelineInput): PipelineOutput {\n` +
        `  const intermediate = transform(input, ${line});\n` +
        `  return validate(intermediate) ? intermediate : fallback(input, ${line});\n` +
        `}`,
    ).join('\n')}\n\`\`\``

  const mathAnswer = (i) =>
    `第 ${i} 轮回答（公式密集）。\n\n${Array.from(
      { length: 8 },
      (_, k) => `$$\nE_{${i},${k}} = \\sum_{n=1}^{\\infty} \\frac{(-1)^n x^{2n+k}}{(2n)!} = \\frac{\\pi^2}{6} - \\frac{1}{${k + 1}}\n$$`,
    ).join('\n\n')}`

  const mermaidAnswer = (i) =>
    `第 ${i} 轮回答（流程图）。\n\n\`\`\`mermaid\nflowchart TD\n${Array.from(
      { length: 30 },
      (_, n) => `  N${n}["节点 ${n}：处理步骤与分支判断"]`,
    ).join('\n')}\n${Array.from({ length: 29 }, (_, n) => `  N${n} --> N${n + 1}`).join('\n')}\n  N0 --> N29\n\`\`\``

  const thinkingBlock = (i) => ({
    type: 'thinking',
    thinking: `思考过程 ${i}：${Array.from({ length: 40 }, () => filler).join('')}`,
    elapsedSeconds: 20 + (i % 5) * 15,
  })

  const textBlock = (i, body) => ({ type: 'text', text: body(i) })

  const usage = (i) => ({
    input_tokens: 2000 + ((i * 137) % 18000),
    cache_creation_input_tokens: 500 + ((i * 61) % 2000),
    cache_read_input_tokens: 4000 + ((i * 977) % 56000),
    output_tokens: 300 + ((i * 43) % 1200),
  })

  const userMsg = (id, i, files = []) => ({
    id,
    role: 'user',
    content: `请回答问题 ${i}：${filler}`,
    files,
    createdAt: now - (400 - i) * 60_000,
  })

  const asstMsg = (id, i, blocks) => ({
    id,
    role: 'assistant',
    createdAt: now - (400 - i) * 59_000,
    model: 'deepseek-flash',
    thinking: i % 5 === 0,
    search: false,
    prefix: true,
    status: 'done',
    blocks,
    stopReason: 'end_turn',
    usage: usage(i),
  })

  const summaryOf = (session) => ({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    fileIds: [...new Set(session.messages.flatMap((m) => (m.role === 'user' ? m.files.map((f) => f.id) : [])))],
  })

  const buildSession = (id, title, messages) => ({
    id,
    title,
    createdAt: messages.at(0)?.createdAt ?? now,
    updatedAt: messages.at(-1)?.createdAt ?? now,
    messages,
  })

  /** 300 条消息主力会话：文本/长代码/公式/Mermaid/思考块混合，线性分支。 */
  const buildMainSession = () => {
    const messages = []
    for (let i = 0; i < 150; i++) {
      messages.push(userMsg(`${PREFIX}main-u${i}`, i * 2))
      const kind = i % 5
      let blocks
      if (kind === 0) {
        blocks = [thinkingBlock(i), textBlock(i, textAnswer)]
      } else if (kind === 1) {
        blocks = [textBlock(i, codeAnswer)]
      } else if (kind === 2) {
        blocks = [textBlock(i, mathAnswer)]
      } else if (kind === 3) {
        blocks = [textBlock(i, mermaidAnswer)]
      } else {
        blocks = [textBlock(i, textAnswer)]
      }
      messages.push(asstMsg(`${PREFIX}main-a${i}`, i * 2 + 1, blocks))
    }
    return buildSession(`${PREFIX}session-300`, 'perf-300 条混合消息', messages)
  }

  /** 重图表会话：Mermaid 与公式密集交替。 */
  const buildHeavySession = () => {
    const messages = []
    for (let i = 0; i < 25; i++) {
      messages.push(userMsg(`${PREFIX}heavy-u${i}`, i))
      messages.push(
        asstMsg(`${PREFIX}heavy-a${i}`, i, [
          textBlock(i, i % 2 === 0 ? mermaidAnswer : mathAnswer),
        ]),
      )
    }
    return buildSession(`${PREFIX}session-heavy`, 'perf-重图表会话', messages)
  }

  /** 图片会话：5 张真实 PNG（canvas 噪点生成），原件入库、消息引用、serverId 为 null。 */
  const makePng = (size) =>
    new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = Math.round((size * 3) / 4)
      const ctx = canvas.getContext('2d')
      const imageData = ctx.createImageData(canvas.width, canvas.height)
      for (let p = 0; p < imageData.data.length; p += 4) {
        imageData.data[p] = Math.random() * 256
        imageData.data[p + 1] = Math.random() * 256
        imageData.data[p + 2] = Math.random() * 256
        imageData.data[p + 3] = 255
      }
      ctx.putImageData(imageData, 0, 0)
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png')
    })

  const buildImageSession = async () => {
    const files = []
    const attachments = []
    for (let i = 0; i < 5; i++) {
      const blob = await makePng(2048)
      const id = `${PREFIX}img${i}`
      files.push({ id, blob })
      attachments.push({ id, serverId: null, name: `perf-image-${i}.png`, size: blob.size, isImage: true, mimeType: 'image/png' })
    }
    const messages = []
    for (let i = 0; i < 5; i++) {
      messages.push(userMsg(`${PREFIX}img-u${i}`, i, [attachments[i]]))
      messages.push(asstMsg(`${PREFIX}img-a${i}`, i, [textBlock(i, textAnswer)]))
    }
    return { session: buildSession(`${PREFIX}session-images`, 'perf-5 张大图会话', messages), files }
  }

  /** 1000 个小会话：驱动侧栏列表长度。 */
  const buildListSessions = () =>
    Array.from({ length: 1000 }, (_, n) => {
      const messages = [
        userMsg(`${PREFIX}list-${n}-u`, 0),
        asstMsg(`${PREFIX}list-${n}-a`, 1, [textBlock(n, textAnswer)]),
      ]
      const session = buildSession(`${PREFIX}list-${n}`, `perf-列表会话 ${String(n).padStart(4, '0')}`, messages)
      session.createdAt = now - DAY - n * 60_000
      session.updatedAt = now - DAY - n * 60_000
      return session
    })

  /** 纯文本对照会话：同样 300 条，不含代码/公式/Mermaid，分离条数与富内容成本。 */
  const buildTextOnlySession = () => {
    const messages = []
    for (let i = 0; i < 150; i++) {
      messages.push(userMsg(`${PREFIX}text-u${i}`, i * 2))
      messages.push(asstMsg(`${PREFIX}text-a${i}`, i * 2 + 1, [textBlock(i, textAnswer)]))
    }
    return buildSession(`${PREFIX}session-text`, 'perf-300 条纯文本', messages)
  }

  // ---------- perfSeed ----------

  const perfSeed = {
    /** 追加纯文本对照会话（幂等，同 id 覆盖）。 */
    async injectTextOnly() {
      const db = await open()
      const session = buildTextOnlySession()
      await putAll(db, 'sessions', [session])
      await putAll(db, 'sessionSummaries', [summaryOf(session)])
      db.close()
      return 'injected: perf-session-text'
    },

    async inject() {
      const db = await open()
      const main = buildMainSession()
      const heavy = buildHeavySession()
      const { session: images, files } = await buildImageSession()
      const list = buildListSessions()
      const sessions = [main, heavy, images, ...list]
      await putAll(db, 'sessions', sessions)
      await putAll(db, 'sessionSummaries', sessions.map(summaryOf))
      await putAll(db, 'files', files)
      db.close()
      return `injected: ${sessions.length} sessions, ${files.length} images (${files
        .map((f) => f.blob.size)
        .join(', ')} bytes)`
    },

    async cleanup() {
      const db = await open()
      const counts = {}
      for (const store of ['sessions', 'sessionSummaries', 'files']) {
        const before = (await getAll(db, store)).length
        await clearPrefixed(db, store)
        counts[store] = before - (await getAll(db, store)).length
      }
      db.close()
      return counts
    },

    async stats() {
      const db = await open()
      const out = {}
      for (const store of ['sessions', 'sessionSummaries', 'files']) {
        const all = await getAll(db, store)
        out[store] = { total: all.length, perf: all.filter((v) => String(v.id).startsWith(PREFIX)).length }
      }
      db.close()
      return out
    },
  }

  // ---------- perfMeasure ----------

  /** 消息列表滚动层：页面里最大的可滚动元素。 */
  const findScrollEl = () => {
    const candidates = [...document.querySelectorAll('div')].filter(
      (el) => el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 200,
    )
    return candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0] ?? null
  }

  const startLongtasks = () => {
    window.__perfLongtasks = []
    try {
      window.__perfLongtaskObserver?.disconnect()
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__perfLongtasks.push({ start: entry.startTime, duration: entry.duration })
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
      window.__perfLongtaskObserver = observer
    } catch {
      window.__perfLongtasks = null
    }
  }

  const stopLongtasks = () => {
    window.__perfLongtaskObserver?.disconnect()
    window.__perfLongtaskObserver = null
    return window.__perfLongtasks ?? []
  }

  const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /** 等待滚动容器内容 DOM 稳定（quietMs 内无变更），返回从 t0 起的毫秒数。 */
  const waitForStable = (el, t0, quietMs = 500, timeoutMs = 20000) =>
    new Promise((resolve) => {
      let lastChange = performance.now()
      const observer = new MutationObserver(() => {
        lastChange = performance.now()
      })
      observer.observe(el, { childList: true, subtree: true, attributes: true })
      const timer = setInterval(() => {
        const t = performance.now()
        if (t - lastChange >= quietMs || t - t0 > timeoutMs) {
          clearInterval(timer)
          observer.disconnect()
          resolve(t - t0)
        }
      }, 50)
    })

  const perfMeasure = {
    /** 点击侧栏标题包含 title 的会话，测量切换首帧与全量渲染完成。移动端先打开侧栏抽屉。 */
    async switchTo(title) {
      // 会话项不是 button 而是 div 行：按叶子文本找标题，向上取第一层有行高的祖先作为点击目标
      const findTarget = () => {
        const leaves = [...document.querySelectorAll('div')].filter(
          (el) => el.childElementCount === 0 && el.textContent.trim() === title,
        )
        for (const leaf of leaves) {
          let el = leaf
          for (let i = 0; i < 5 && el.parentElement; i++) {
            el = el.parentElement
            if (el.offsetHeight >= 28 && el.offsetWidth >= 80) {
              return el
            }
          }
        }
        return null
      }
      let target = findTarget()
      if (!target) {
        document
          .querySelector('button[aria-label*="sidebar" i], button[aria-label*="边栏"], button[aria-label*="侧栏"]')
          ?.click()
        await waitFor(700)
        target = findTarget()
      }
      if (!target) {
        return { error: 'session item not found: ' + title }
      }
      await waitFor(300)
      startLongtasks()
      const t0 = performance.now()
      target.click()
      await waitFor(150) // 等 React 切换视图，消息容器出现
      const el = findScrollEl()
      if (!el) {
        return { error: 'scroll element not found' }
      }
      const firstMs = performance.now() - t0
      const fullMs = await waitForStable(el, t0, 600, 30000)
      const domNodes = el.querySelectorAll('*').length
      const longtasks = stopLongtasks()
      return {
        title,
        firstMs: Math.round(firstMs),
        fullMs: Math.round(fullMs),
        domNodes,
        longtasks: longtasks.length,
        maxLongtask: longtasks.length ? Math.round(Math.max(...longtasks.map((l) => l.duration))) : 0,
      }
    },

    /** 当前会话从底部向上匀速滚动 durationMs，统计 FPS 与 longtask。 */
    async scrollPass(durationMs = 8000) {
      const el = findScrollEl()
      if (!el) {
        return { error: 'scroll element not found' }
      }
      el.scrollTop = el.scrollHeight
      await waitFor(400)
      const frames = []
      startLongtasks()
      const t0 = performance.now()
      await new Promise((resolve) => {
        const step = () => {
          const t = performance.now()
          if (t - t0 >= durationMs || el.scrollTop <= 0) {
            resolve()
            return
          }
          el.scrollTop -= 6
          frames.push(t)
          requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      })
      const longtasks = stopLongtasks()
      const intervals = []
      for (let i = 1; i < frames.length; i++) {
        intervals.push(frames[i] - frames[i - 1])
      }
      intervals.sort((a, b) => a - b)
      const fps = (xs) => (xs.length ? Math.round(1000 / xs[Math.floor(xs.length / 2)]) : 0)
      return {
        scrolledMs: Math.round(performance.now() - t0),
        frames: frames.length,
        fpsMedian: fps(intervals),
        fpsP95: fps(intervals.slice(Math.floor(intervals.length * 0.95))),
        reachedTop: el.scrollTop <= 0,
        longtasks: longtasks.length,
        maxLongtask: longtasks.length ? Math.round(Math.max(...longtasks.map((l) => l.duration))) : 0,
      }
    },

    heap() {
      const memory = performance.memory
      return memory
        ? { usedMB: Math.round(memory.usedJSHeapSize / 1048576), totalMB: Math.round(memory.totalJSHeapSize / 1048576) }
        : { error: 'performance.memory unavailable' }
    },
  }

  window.perfSeed = perfSeed
  window.perfMeasure = perfMeasure
  console.log('[perf] ready: perfSeed.inject() / cleanup() / stats(), perfMeasure.switchTo(title) / scrollPass() / heap()')
})()
