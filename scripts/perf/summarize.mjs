import { readFile } from 'node:fs/promises'

export function summarize(report) {
  const stats = (values) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
    if (!sorted.length) {
      return { count: 0, median: null, max: null }
    }
    const middle = Math.floor(sorted.length / 2)
    return {
      count: sorted.length,
      median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
      max: sorted.at(-1),
      ...(sorted.length >= 20 ? { p95: sorted[Math.ceil(sorted.length * 0.95) - 1] } : {}),
    }
  }
  const groups = new Map()
  for (const sample of report.samples) {
    const key = `${sample.kind}/${sample.sessionId}`
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key).push(sample)
  }
  return {
    schemaVersion: 1,
    measurementVersion: report.measurementVersion ?? 1,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    status: report.status,
    stages: report.stages ?? null,
    build: report.build,
    environment: report.environment,
    fixture: report.manifest
      ? {
          version: report.manifest.version,
          seed: report.manifest.seed,
          now: report.manifest.now,
          fixtureSourceSha256: report.manifest.fixtureSourceSha256,
          sessions: report.manifest.sessions.length,
          messages: report.manifest.sessions.reduce((sum, session) => sum + session.messages, 0),
          originalBytes: report.manifest.originalBytes,
          files: report.manifest.files,
          mainScenarios: report.manifest.sessions.filter(
            (session) => !session.id.includes('-list-')
          ),
        }
      : null,
    switchGroups: Object.fromEntries(
      [...groups].map(([key, samples]) => [
        key,
        {
          tailPaintProxyMs: stats(samples.map((s) => s.tailPaintProxyMs)),
          shellPaintProxyMs: stats(samples.map((s) => s.shellPaintProxyMs)),
          maxLongtaskMs: stats(samples.map((s) => s.longtasks?.maxMs)),
          blockingMs: stats(samples.map((s) => s.longtasks?.blockingMs)),
          domNodes: stats(samples.map((s) => s.domNodes)),
          jsHeapUsedBytes: stats(samples.map((s) => s.heap?.usedBytes)),
          invalidVisibleSamples: samples.filter((s) => !s.visible.ready || s.visible.errors).length,
        },
      ])
    ),
    startup: {
      nativeTotalTimeMs: stats(report.startup.map((s) => s.nativeTotalTimeMs)),
      interactiveUpperBoundMs: stats(report.startup.map((s) => s.appInteractiveUpperBoundMs)),
      note: report.startup[0]?.note,
    },
    scroll: report.scroll,
    memory: report.memory,
    memoryRounds:
      report.memoryRounds?.length
        ? {
            rounds: report.memoryRounds.length,
            note: 'Per-round switch results during the 20-round memory loop; long-task observation covers each full operation (probe v4 settleInside).',
            perSession: Object.fromEntries(
              ['mixed', 'images'].map((key) => {
                const samples = report.memoryRounds.map((round) => round[key]).filter(Boolean)
                return [
                  key,
                  {
                    rounds: samples.length,
                    tailPaintProxyMs: stats(samples.map((s) => s.tailPaintProxyMs)),
                    maxLongtaskMs: stats(samples.map((s) => s.longtasks?.maxMs)),
                    totalBlockingMs: samples.reduce((n, s) => n + (s.longtasks?.blockingMs ?? 0), 0),
                  },
                ]
              })
            ),
          }
        : null,
    memoryProtocol: report.memoryProtocol ?? null,
    trace: report.trace,
    ...(report.error ? { error: report.error } : {}),
  }
}

if (process.argv[1]?.endsWith('summarize.mjs')) {
  const report = JSON.parse(await readFile(process.argv[2], 'utf8'))
  process.stdout.write(JSON.stringify(summarize(report), null, 2) + '\n')
}
