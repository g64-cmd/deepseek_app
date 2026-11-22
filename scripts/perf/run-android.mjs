import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cdp } from './cdp.mjs'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))
const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, '').split('=')
    return [key, value.length ? value.join('=') : true]
  })
)
const serial = String(options.serial ?? 'emulator-5554')
const packageId = 'com.g64_cmd.whalechat.c0'
const activity = `${packageId}/com.g64_cmd.whalechat.MainActivity`
const localProperties = await readFile(path.join(root, 'android/local.properties'), 'utf8').catch(
  () => ''
)
const sdkDirectory =
  process.env.ANDROID_SDK_ROOT ??
  process.env.ANDROID_HOME ??
  localProperties
    .match(/^sdk\.dir=(.+)$/m)?.[1]
    .trim()
    .replace(/\\:/g, ':')
    .replace(/\\\\/g, '\\')
const adbPath = String(
  options.adb ??
    (sdkDirectory
      ? path.join(sdkDirectory, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
      : 'adb')
)
const output = path.resolve(
  root,
  String(options.output ?? `tmp/c0/${new Date().toISOString().replace(/[:.]/g, '-')}`)
)
if (!output.startsWith(path.join(root, 'tmp', 'c0') + path.sep)) {
  throw new Error('C0 output must be below tmp/c0/')
}
const coldCount = Number(options.cold ?? 5)
const warmCount = Number(options.warm ?? 10)
if (![coldCount, warmCount].every((n) => Number.isInteger(n) && n >= 0 && n <= 100)) {
  throw new Error('Invalid sample count')
}
const port = 9223
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const adb = async (...args) =>
  (
    await exec(adbPath, ['-s', serial, ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 45_000 })
  ).stdout.trim()
const shell = (...args) => adb('shell', ...args)
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  packageId,
  serial,
  build: {},
  environment: {},
  manifest: null,
  samples: [],
  scroll: [],
  memory: [],
  startup: [],
  trace: null,
  stages: { matrix: 'not-run', memory: 'not-run', trace: 'not-run' },
  status: 'running',
}
let cdp
const log = (value) => process.stdout.write(`${new Date().toISOString()} ${value}\n`)
await mkdir(output, { recursive: true })
const save = async () =>
  writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')

async function attach() {
  const pid = await shell('pidof', packageId)
  if (!/^\d+$/.test(pid)) {
    throw new Error('C0 app PID unavailable')
  }
  await adb('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`)
  let lastError
  for (let n = 0; n < 60; n++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const target = targets.find(
        (target) => target.type === 'page' && target.url.startsWith('https://localhost')
      )
      if (target) {
        const client = await Cdp.connect(target.webSocketDebuggerUrl)
        await client.call('Network.enable')
        await client.call('Network.setBlockedURLs', { urls: ['*api.deepseek.com*'] })
        await client.call('Runtime.enable')
        return client
      }
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error('C0 WebView target unavailable', { cause: lastError })
}

const moduleSource = async (name) => {
  const source = await readFile(new URL(name, import.meta.url), 'utf8')
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}
const fixtureUrl = await moduleSource('./fixtures.mjs')
const browserUrl = await moduleSource('./browser.mjs')
const fixtureHash = hash(await readFile(new URL('./fixtures.mjs', import.meta.url)))
async function prepare() {
  await cdp.evaluate(`(async()=>{
    window.perfC0=await import(${JSON.stringify(browserUrl)});
    await perfC0.waitFor(()=>document.querySelector('[data-app-ready="true"]'));
    await perfC0.dismissInitialSettings();
    return true;
  })()`)
}

async function launch() {
  cdp?.close()
  await shell('am', 'force-stop', packageId)
  const started = performance.now()
  const native = await shell('am', 'start', '-W', '-n', activity)
  cdp = await attach()
  await prepare()
  const startup = {
    capturedAt: new Date().toISOString(),
    appInteractiveUpperBoundMs: performance.now() - started,
    nativeTotalTimeMs: Number(native.match(/TotalTime:\s*(\d+)/)?.[1] ?? NaN),
    note: 'Upper bound includes adb start, CDP attach and settings dismissal; not exact first frame.',
  }
  report.startup.push(startup)
  return startup
}

async function memory(label) {
  const capturedAt = new Date().toISOString()
  const lines = (await shell('ps', '-A', '-o', 'PID,ETIME,ARGS')).split(/\r?\n/)
  const processes = lines
    .map((line) => line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/))
    .filter(Boolean)
    .filter(
      (match) =>
        match[3] === packageId ||
        /webview.*sandboxed_process|sandboxed_process.*webview/.test(match[3])
    )
  const measurements = []
  for (const [, pid, elapsed, command] of processes) {
    try {
      const info = await shell('dumpsys', 'meminfo', '--local', pid)
      const pssKiB = Number(
        info.match(/TOTAL PSS:\s*(\d+)/)?.[1] ?? info.match(/^\s*TOTAL\s+(\d+)/m)?.[1] ?? NaN
      )
      measurements.push({
        capturedAt: new Date().toISOString(),
        pid: Number(pid),
        elapsed,
        command,
        pssKiB: Number.isFinite(pssKiB) ? pssKiB : null,
      })
    } catch (error) {
      measurements.push({ pid: Number(pid), error: error.message })
    }
  }
  const value = {
    label,
    sampler: 'dumpsys meminfo --local',
    capturedAt,
    processes: measurements,
    heap: await cdp.evaluate('perfC0.heap()'),
    heapCdp: await cdp.call('Runtime.getHeapUsage').catch(() => null),
    rendererScope:
      'All WebView sandbox renderers on this dedicated AVD; includes any unrelated renderer if present.',
  }
  report.memory.push(value)
  await save()
  return value
}

let scenarioInfo
const controlId = 'c0-v1-list-0000'
const tailOf = (id) => scenarioInfo.find((s) => s.id === id).tailId
async function select(id, windowMs = 3000) {
  const result = await cdp.evaluate(
    `perfC0.switchTo(${JSON.stringify(id)},${JSON.stringify(tailOf(id))},{windowMs:${windowMs}})`
  )
  await cdp.evaluate(`perfC0.settle(${JSON.stringify(id)})`)
  return result
}
async function control() {
  if (!(await cdp.evaluate(`!!document.querySelector('[data-session-view="${controlId}"]')`))) {
    await select(controlId, 0)
  }
}

async function trace() {
  await control()
  const file = 'render-trace.json'
  const complete = cdp.once('Tracing.tracingComplete')
  await cdp.call('Tracing.start', {
    categories:
      'toplevel,devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-v8.cpu_profiler',
    transferMode: 'ReturnAsStream',
  })
  try {
    for (const id of ['c0-v1-mixed', 'c0-v1-images', 'c0-v1-mixed']) {
      log(`trace ${id}`)
      await select(id)
    }
  } finally {
    await cdp.call('Tracing.end')
  }
  const { stream, dataLossOccurred } = await complete
  const chunks = []
  while (true) {
    const result = await cdp.call('IO.read', { handle: stream, size: 1024 * 1024 })
    chunks.push(Buffer.from(result.data, result.base64Encoded ? 'base64' : 'utf8'))
    if (result.eof) {
      break
    }
  }
  await cdp.call('IO.close', { handle: stream })
  const bytes = Buffer.concat(chunks)
  await writeFile(path.join(output, file), bytes)
  report.trace = {
    file,
    bytes: bytes.length,
    sha256: hash(bytes),
    dataLossOccurred: dataLossOccurred ?? null,
    note: 'Separate diagnostic run; traced samples excluded from untraced statistics.',
  }
}

try {
  report.build.commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  const sourcePaths = [
    'scripts/perf/fixtures.mjs',
    'scripts/perf/browser.mjs',
    'scripts/perf/run-android.mjs',
    'src/components/messages/MessageList.tsx',
    'src/components/markdown/CodeBlock.tsx',
    'src/components/markdown/MathFormula.tsx',
    'src/components/markdown/MermaidDiagram.tsx',
  ]
  report.build.sourceHashes = Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (file) => [file, hash(await readFile(path.join(root, file)))])
    )
  )
  report.build.workingDiffSha256 = hash(
    (
      await exec('git', ['diff', '--', 'src', 'rspack.config.ts', 'android/app/build.gradle'], {
        cwd: root,
      })
    ).stdout
  )
  report.build.apkSha256 = hash(
    await readFile(
      path.resolve(root, String(options.apk ?? 'android/app/build/outputs/apk/debug/app-debug.apk'))
    )
  )
  const installedPath = (await shell('pm', 'path', packageId))
    .split(/\r?\n/)
    .find((line) => line.endsWith('/base.apk'))
    ?.slice(8)
  if (!installedPath) {
    throw new Error('Installed C0 APK path is unavailable')
  }
  report.build.installedApkSha256 = (await shell('sha256sum', installedPath)).split(/\s+/)[0]
  if (report.build.installedApkSha256 !== report.build.apkSha256) {
    throw new Error(
      'Installed C0 APK differs from the selected local APK; install the matching C0 build or use --apk=path'
    )
  }
  report.environment.android = await shell('getprop', 'ro.build.version.release')
  report.environment.api = await shell('getprop', 'ro.build.version.sdk')
  report.environment.fingerprint = await shell('getprop', 'ro.build.fingerprint')
  report.environment.abi = await shell('getprop', 'ro.product.cpu.abi')
  report.environment.display = await shell('wm', 'size')
  report.environment.density = await shell('wm', 'density')
  report.environment.webview = await shell('dumpsys', 'webviewupdate')
  report.environment.emulator = serial.startsWith('emulator-')
  await launch()
  report.environment.browser = await cdp.call('Browser.getVersion')
  report.build.webMode = await cdp.evaluate(
    `document.querySelector('meta[name="application-build-mode"]')?.content`
  )
  if (report.build.webMode !== 'production') {
    throw new Error('C0 requires an explicit production Web build')
  }
  report.environment.viewport = await cdp.evaluate(
    '({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,userAgent:navigator.userAgent})'
  )
  report.measurementVersion = await cdp.evaluate('perfC0.MEASUREMENT_VERSION ?? 1')
  const installed = await cdp.evaluate(`(async()=>{
    const fixtureModule=await import(${JSON.stringify(fixtureUrl)});
    const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('chat-demo',11);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
    const marker=await perfC0.readManifest();
    if(marker){
      const manifest=marker;
      if(manifest.fixtureSourceSha256!==${JSON.stringify(fixtureHash)})throw new Error('C0 fixture source changed; use a fresh isolated package database');
      for(const [store,expected] of [['sessions',manifest.sessions.length],['sessionSummaries',manifest.sessions.length],['files',manifest.files.length],['sessionsStaging',0],['filesStaging',0]]){
        const count=await new Promise((resolve,reject)=>{const req=db.transaction(store).objectStore(store).count();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
        if(count!==expected)throw new Error('C0 existing fixture has changed: '+store);
      }
      for(const scenario of manifest.scenarios.filter(s=>!s.id.includes('-list-'))){
        const session=await new Promise((resolve,reject)=>{const req=db.transaction('sessions').objectStore('sessions').get(scenario.id);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
        if(!session?.messages.some(m=>m.id===scenario.tailId))throw new Error('C0 message IDs changed, for example after backup import; recreate the isolated fixture');
      }
      db.close();return {reused:true,manifest};
    }
    const fixture=await fixtureModule.materializeAssets(fixtureModule.buildFixture());
    const manifest=await fixtureModule.installFixture(db,fixture);
    manifest.fixtureSourceSha256=${JSON.stringify(fixtureHash)};
    for(const file of fixture.files){const bytes=await file.blob.arrayBuffer();file.sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('')}
    manifest.files=manifest.files.map((file)=>({...file,sha256:fixture.files.find(f=>f.id===file.id).sha256}));
    manifest.scenarios=fixture.sessions.map(session=>{const map=new Map(session.messages.map(m=>[m.id,m]));let id=session.rootMessageId;let last;while(id){last=map.get(id);id=last.selectedChildId}return{id:session.id,tailId:last.id}});
    await perfC0.writeManifest(manifest);db.close();return {reused:false,manifest};
  })()`)
  if (installed.reused && !options['reuse-fixture']) {
    throw new Error('Existing C0 fixture; use --reuse-fixture only for this isolated test package')
  }
  report.manifest = installed.manifest
  if (report.manifest.version !== 'c0-v1') {
    throw new Error('Unexpected C0 fixture version')
  }
  scenarioInfo = report.manifest.scenarios
  log(
    `fixture ${scenarioInfo.length} sessions; ${(report.manifest.originalBytes / 1048576).toFixed(1)} MiB originals`
  )
  await launch()
  const names = String(options.scenarios ?? 'text,mixed,heavy,images,branches').split(',')
  if (names.some((name) => !['text', 'mixed', 'heavy', 'images', 'branches'].includes(name))) {
    throw new Error('Unknown C0 scenario')
  }
  const scenarios = names.map((name) => 'c0-v1-' + name)
  if (!options['skip-matrix']) {
    report.stages.matrix = 'running'
    for (const kind of ['cold', 'warm']) {
      const count = kind === 'cold' ? coldCount : warmCount
      if (count === 0) {
        continue
      }
      for (const id of scenarios) {
        if (kind === 'warm' && count > 0) {
          await control()
          await select(id, 0)
        }
        for (let n = 1; n <= count; n++) {
          await control()
          if (kind === 'cold') {
            await launch()
            await control()
          }
          const sample = await select(id)
          report.samples.push({ kind, index: n, capturedAt: new Date().toISOString(), ...sample })
          log(
            `${kind} ${id} ${n}/${count}: tail=${Math.round(sample.tailPaintProxyMs)}ms maxTask=${Math.round(sample.longtasks?.maxMs ?? 0)}ms`
          )
          await save()
        }
        report.scroll.push({ kind, sessionId: id, ...(await cdp.evaluate('perfC0.scrollPass()')) })
        await save()
      }
    }
    report.stages.matrix = 'complete'
  }
  if (options.trace) {
    report.stages.trace = 'running'
    await trace()
    report.stages.trace = 'complete'
    await save()
    if (options.memory) {
      await launch()
    }
  }
  if (options.memory) {
    report.stages.memory = 'running'
    await control()
    // Use the same visible scene and warmed libraries at all four checkpoints.
    await select('c0-v1-mixed', 0)
    await select('c0-v1-images', 0)
    report.memoryProtocol = {
      prewarmRoundTrips: 1,
      measuredRoundTrips: 20,
      idleMs: 10000,
      checkpointSessionId: 'c0-v1-images',
      restartAfterTrace: !!options.trace,
    }
    await sleep(10_000)
    await memory('round-0')
    for (let n = 1; n <= 20; n++) {
      await select('c0-v1-mixed', 0)
      await select('c0-v1-images', 0)
      log(`memory round trip ${n}/20 complete`)
      if ([5, 10, 20].includes(n)) {
        await sleep(10_000)
        await memory(`round-${n}`)
        log(`memory round ${n}/20`)
      }
    }
    report.stages.memory = 'complete'
  }
  report.status = 'complete'
} catch (error) {
  report.status = 'failed'
  report.error = error.stack
  log(`FAILED: ${error.message}`)
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await save()
  cdp?.close()
  await adb('forward', '--remove', `tcp:${port}`).catch(() => {})
  log(`${report.status}: ${path.relative(root, output)}/results.json`)
}
