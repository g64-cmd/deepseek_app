type Mermaid = typeof import('mermaid').default

let mermaidPromise: Promise<Mermaid> | null = null
let nextId = 0

/** 转义图片标签，对同一图中的全部标签生效。 */
const sanitizeMermaid = (code: string) => code.replace(/<((?:img|image)\s+)/gi, '&lt;$1')

type RenderJob = {
  run: (mermaid: Mermaid) => Promise<string | null>
  isCancelled: () => boolean
  resolve: (svg: string | null) => void
  reject: (error: unknown) => void
}

// 串行执行初始化和绘制，避免不同图表互相覆盖 Mermaid 的全局配置。
// 库就绪前不挑选任务（首批请求先全部入队），随后从最新请求开始绘制：
// 滚动中新进入视口的图表先于预取的屏外图表；已取消（组件卸载）的任务
// 直接丢弃，不把串行名额让给不再需要的结果。
let pendingJobs: RenderJob[] = []
let running = false

const pump = async () => {
  if (running) {
    return
  }
  running = true
  try {
    const mermaid = await loadMermaid()
    for (;;) {
      let job = pendingJobs.at(-1)
      while (job && job.isCancelled()) {
        pendingJobs.pop()
        job.resolve(null)
        job = pendingJobs.at(-1)
      }
      if (!job) {
        break
      }
      pendingJobs.pop()
      try {
        job.resolve(await job.run(mermaid))
      } catch (error) {
        // 某张图失败不阻塞后续图表；调用方仍收到原始任务的错误。
        job.reject(error)
      }
    }
  } catch (error) {
    // 库加载失败：排队中的调用方全部收到同一错误；下次调用重新尝试加载。
    for (const job of pendingJobs.splice(0)) {
      job.reject(error)
    }
  } finally {
    running = false
  }
}

const loadMermaid = () => {
  mermaidPromise ??= import('mermaid')
    .then((module) => module.default)
    .catch((error: unknown) => {
      mermaidPromise = null
      throw error
    })
  return mermaidPromise
}

export const renderMermaid = (
  code: string,
  dark: boolean,
  isCancelled: () => boolean
): Promise<string | null> =>
  new Promise((resolve, reject) => {
    pendingJobs.push({
      isCancelled,
      resolve,
      reject,
      run: async (mermaid) => {
        if (isCancelled() || !code.trim()) {
          return null
        }

        mermaid.initialize({
          theme: dark ? 'dark' : 'default',
          securityLevel: 'strict',
          startOnLoad: false,
          suppressErrorRendering: true,
        })

        const { svg } = await mermaid.render(`standalone-mermaid-${nextId++}`, sanitizeMermaid(code))
        return isCancelled() ? null : svg
      },
    })
    void pump()
  })
