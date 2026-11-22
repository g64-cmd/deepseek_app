import { readFile } from 'node:fs/promises'

const input = JSON.parse(await readFile(process.argv[2], 'utf8'))
const events = input.traceEvents ?? input
const threads = new Map(
  events
    .filter((event) => event.ph === 'M' && event.name === 'thread_name')
    .map((event) => [`${event.pid}:${event.tid}`, event.args.name])
)
const groups = new Map()
for (const event of events) {
  if (event.ph !== 'X' || !Number.isFinite(event.dur)) {
    continue
  }
  const thread = threads.get(`${event.pid}:${event.tid}`) ?? String(event.tid)
  const key = `${event.pid}/${thread}/${event.name}`
  const group = groups.get(key) ?? {
    pid: event.pid,
    tid: event.tid,
    thread,
    name: event.name,
    count: 0,
    totalInclusiveMs: 0,
    maxMs: 0,
  }
  group.count++
  group.totalInclusiveMs += event.dur / 1000
  group.maxMs = Math.max(group.maxMs, event.dur / 1000)
  groups.set(key, group)
}
const durations = [...groups.values()].sort((a, b) => b.maxMs - a.maxMs)
const profileChunks = events.filter((event) => event.name === 'ProfileChunk')
const profileNodes = new Map()
for (const event of profileChunks) {
  for (const node of event.args.data.cpuProfile?.nodes ?? []) {
    profileNodes.set(`${event.pid}:${event.id}:${node.id}`, node)
  }
}
const geometryCallers = new Map()
for (const event of profileChunks) {
  const prefix = `${event.pid}:${event.id}:`
  for (const sample of event.args.data.cpuProfile?.samples ?? []) {
    let node = profileNodes.get(prefix + sample)
    if (node?.callFrame.functionName !== 'getBoundingClientRect') {
      continue
    }
    let caller = 'unknown'
    for (let depth = 0; node && depth < 80; depth++) {
      if (node.callFrame.url) {
        caller = node.callFrame.url.startsWith('data:') ? 'C0 probe module' : node.callFrame.url
        break
      }
      node = profileNodes.get(prefix + node.parent)
    }
    geometryCallers.set(caller, (geometryCallers.get(caller) ?? 0) + 1)
  }
}
process.stdout.write(
  JSON.stringify(
    {
      eventCount: events.length,
      note: 'Event durations are inclusive and overlap. Do not sum across event types or infer exclusive CPU percentages.',
      longestEvents: durations.slice(0, 30),
      renderingAndGc: durations.filter((event) =>
        /Layout|Paint|UpdateLayout|GC|Garbage|V8.Execute|FunctionCall/.test(event.name)
      ),
      geometrySampleCallers: {
        note: 'Sampled getBoundingClientRect leaf frames grouped by closest JavaScript caller; not CPU percentages.',
        samples: Object.fromEntries(geometryCallers),
      },
    },
    null,
    2
  ) + '\n'
)
