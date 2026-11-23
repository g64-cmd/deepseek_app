import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cdp } from './cdp.mjs'
import { branchShape } from './branch-shape.mjs'
import { buildFixture } from './fixtures.mjs'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))
const packageId = 'com.g64_cmd.whalechat.c0'
const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('='))
)
const serial = options.serial ?? 'emulator-5554'
const properties = await readFile(path.join(root, 'android/local.properties'), 'utf8').catch(
  () => ''
)
const sdk =
  process.env.ANDROID_SDK_ROOT ??
  process.env.ANDROID_HOME ??
  properties
    .match(/^sdk\.dir=(.+)$/m)?.[1]
    .trim()
    .replace(/\\:/g, ':')
    .replace(/\\\\/g, '\\')
const adbPath =
  options.adb ??
  (sdk ? path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : 'adb')
const output = path.resolve(root, options.output ?? 'tmp/c0/scale')
if (!output.startsWith(path.join(root, 'tmp/c0') + path.sep)) {
  throw new Error('Output must be inside tmp/c0/')
}
await mkdir(output, { recursive: true })
const adb = async (...args) =>
  (
    await exec(adbPath, ['-s', serial, ...args], { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 })
  ).stdout.trim()
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const port = 9223
const pid = await adb('shell', 'pidof', packageId)
if (!/^\d+$/.test(pid)) {
  throw new Error('Isolated C0 app is not running')
}
await adb('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`)
const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
  (target) => target.type === 'page' && target.url.startsWith('https://localhost')
)
const client = await Cdp.connect(target.webSocketDebuggerUrl)
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  packageId,
  serial,
  status: 'running',
  usage: [],
  export: null,
  import: null,
  validation: null,
  memory: [],
  build: {
    commit: (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
    apkSha256: hash(
      await readFile(
        path.resolve(root, options.apk ?? 'android/app/build/outputs/apk/debug/app-debug.apk')
      )
    ),
    driverSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  },
}
const save = () =>
  writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
const log = (value) => process.stdout.write(`${new Date().toISOString()} ${value}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function memory(phase) {
  const capturedAt = new Date().toISOString()
  const lines = (await adb('shell', 'ps', '-A', '-o', 'PID,ETIME,ARGS')).split(/\r?\n/)
  const processes = []
  for (const line of lines) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/)
    if (
      !match ||
      !(
        match[3] === packageId ||
        /webview.*sandboxed_process|sandboxed_process.*webview/.test(match[3])
      )
    ) {
      continue
    }
    const info = await adb('shell', 'dumpsys', 'meminfo', '--local', match[1])
    const pssKiB = Number(
      info.match(/TOTAL PSS:\s*(\d+)/)?.[1] ?? info.match(/^\s*TOTAL\s+(\d+)/m)?.[1] ?? NaN
    )
    processes.push({
      capturedAt: new Date().toISOString(),
      pid: Number(match[1]),
      elapsed: match[2],
      command: match[3],
      pssKiB: Number.isFinite(pssKiB) ? pssKiB : null,
    })
  }
  report.memory.push({ phase, capturedAt, processes, sampler: 'dumpsys meminfo --local' })
}

async function observed(phase, expression) {
  await memory(`${phase}-before`)
  let done = false
  const sampler = (async () => {
    while (!done) {
      await sleep(2000)
      if (!done) {
        await memory(phase)
      }
    }
  })()
  try {
    return await client.evaluate(expression)
  } finally {
    done = true
    await sampler
    await memory(`${phase}-after`)
    await save()
  }
}

try {
  const installedPath = (await adb('shell', 'pm', 'path', packageId))
    .split(/\r?\n/)
    .find((line) => line.endsWith('/base.apk'))
    ?.slice(8)
  if (!installedPath) {
    throw new Error('Installed C0 APK path is unavailable')
  }
  report.build.installedApkSha256 = (await adb('shell', 'sha256sum', installedPath)).split(/\s+/)[0]
  if (report.build.installedApkSha256 !== report.build.apkSha256) {
    throw new Error(
      'Installed C0 APK differs from the selected local APK; install the matching C0 build or use --apk=path'
    )
  }
  await client.call('Network.enable')
  await client.call('Network.setBlockedURLs', { urls: ['*api.deepseek.com*'] })
  const browserSource = await readFile(new URL('./browser.mjs', import.meta.url), 'utf8')
  await client.evaluate(`(async()=>{
    window.perfC0=await import(${JSON.stringify('data:text/javascript;base64,' + Buffer.from(browserSource).toString('base64'))});
    if(!await perfC0.readManifest())throw new Error('C0 fixture marker missing');
    await perfC0.dismissInitialSettings();
    window.c0Scale={};
    window.c0Scale.open=async()=>{
      const started=performance.now();let sidebarPaintProxyMs=null;
      if(!document.querySelector('[role="dialog"]')){
        document.querySelector('[data-open-sidebar]')?.click();
        const button=await perfC0.waitFor(()=>[...document.querySelectorAll('button')].find(b=>/^(设置|Settings)$/.test(b.textContent.trim())));
        await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
        sidebarPaintProxyMs=performance.now()-started;
        button.click();await perfC0.waitFor(()=>document.querySelectorAll('[role="tab"]').length===3);
      }
      return{sidebarPaintProxyMs,settingsOpenUpperBoundMs:performance.now()-started,sessionItems:document.querySelectorAll('[data-session-item]').length};
    };
    window.c0Scale.tab=async(index)=>{document.querySelectorAll('[role="tab"]')[index].click();await new Promise(requestAnimationFrame)};
    return true;
  })()`)
  report.environment = await client.call('Browser.getVersion')
  report.fixture = await client.evaluate('perfC0.readManifest()')
  report.navigation = await client.evaluate('c0Scale.open()')
  for (const kind of ['cold-cache', 'warm-cache']) {
    const result = await observed(
      `usage-${kind}`,
      `(async()=>{
      await c0Scale.tab(0);
      if(${JSON.stringify(kind)}==='cold-cache')localStorage.removeItem('chat-demo:usage-summary');
      const started=performance.now();await c0Scale.tab(1);
      await perfC0.waitFor(()=>localStorage.getItem('chat-demo:usage-summary')&&document.querySelector('[role="tabpanel"]')?.textContent.includes('Flash'));
      await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
      return{elapsedMs:performance.now()-started,summary:JSON.parse(localStorage.getItem('chat-demo:usage-summary')).summary};
    })()`
    )
    report.usage.push({ kind, ...result })
    log(`usage ${kind}: ${Math.round(result.elapsedMs)}ms, ${result.summary.replies} replies`)
    await save()
  }
  report.export = await observed(
    'export',
    `(async()=>{
    await c0Scale.tab(2);
    const cap=window.Capacitor;const native=cap.nativePromise;
    const state=c0Scale.export={started:performance.now(),calls:[],done:false};
    cap.nativePromise=async function(plugin,method,options){
      if(plugin==='Share'&&method==='share'){
        state.url=options.url;state.elapsedMs=performance.now()-state.started;state.done=true;return{};
      }
      const call={plugin,method,startMs:performance.now()-state.started};
      if(plugin==='Filesystem'&&['mkdir','writeFile','appendFile'].includes(method))state.calls.push(call);
      try{return await native.call(cap,plugin,method,options)}finally{call.endMs=performance.now()-state.started}
    };
    c0Scale.restoreBridge=()=>{cap.nativePromise=native};
    try{
      const button=[...document.querySelector('[role="tabpanel"]').querySelectorAll('button')].find(b=>/^(备份|Back up|Backup)$/.test(b.textContent.trim()));
      if(!button)throw new Error('C0 full backup button missing');button.click();
      await perfC0.waitFor(()=>state.done,180000);
      return{elapsedMs:state.elapsedMs,url:state.url,calls:state.calls,shareSuppressed:true};
    }finally{c0Scale.restoreBridge()}
  })()`
  )
  log(`backup export to native cache: ${Math.round(report.export.elapsedMs)}ms`)
  report.import = await observed(
    'import',
    `(async()=>{
    const started=performance.now();
    const response=await fetch(Capacitor.convertFileSrc(c0Scale.export.url));
    if(!response.ok)throw new Error('C0 cache ZIP read failed: '+response.status);
    const blob=await response.blob();
    const readMs=performance.now()-started;
    const file=new File([blob],'c0-backup.zip',{type:'application/zip'});
    const transfer=new DataTransfer();transfer.items.add(file);
    const input=document.querySelector('[role="tabpanel"] input[type="file"]');
    input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    await perfC0.waitFor(()=>document.querySelectorAll('[role="dialog"]').length===2);
    const top=[...document.querySelectorAll('[role="dialog"]')].at(-1);
    const button=[...top.querySelectorAll('button')].find(b=>/导入|Import/.test(b.textContent));
    if(!button)throw new Error('C0 import confirmation missing');
    const importStart=performance.now();button.click();
    await perfC0.waitFor(()=>/已导入 1,?007|Imported 1,?007/.test(document.querySelector('[role="tabpanel"]')?.textContent??''),180000);
    return{zipBytes:blob.size,cacheReadMs:readMs,restoreMs:performance.now()-importStart,totalMs:performance.now()-started,viaDOMFileInput:true};
  })()`
  )
  log(
    `backup restore: ${Math.round(report.import.restoreMs)}ms, ${report.import.zipBytes} ZIP bytes`
  )
  report.validation = await client.evaluate(`(async()=>{
    const shapeModule=await import(${JSON.stringify('data:text/javascript;base64,' + Buffer.from(await readFile(new URL('./branch-shape.mjs', import.meta.url), 'utf8')).toString('base64'))});
    const expectedShape=${JSON.stringify(branchShape(buildFixture().sessions.find((session) => session.id === 'c0-v1-branches')))};
    const manifest=await perfC0.readManifest();
    const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('chat-demo');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
    const read=(store,id)=>new Promise((resolve,reject)=>{const req=db.transaction(store).objectStore(store).get(id);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
    const count=(store)=>new Promise((resolve,reject)=>{const req=db.transaction(store).objectStore(store).count();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
    const files=[];
    for(const file of manifest.files){const original=await read('files',file.id);const bytes=await original.blob.arrayBuffer();const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');files.push({id:file.id,bytes:original.blob.size,sha256,matches:sha256===file.sha256})}
    const branch=await read('sessions','c0-v1-branches');
    const branchesMatch=JSON.stringify(shapeModule.branchShape(branch))===JSON.stringify(expectedShape);
    const result={sessionCount:await count('sessions'),summaryCount:await count('sessionSummaries'),fileCount:await count('files'),branchMessageCount:branch.messages.length,branchesMatch,files};
    result.passed=result.sessionCount===1007&&result.summaryCount===1007&&result.fileCount===6&&result.branchMessageCount===10&&branchesMatch&&files.every(f=>f.matches);
    db.close();return result;
  })()`)
  if (!report.validation.passed) {
    throw new Error('C0 restore validation failed; inspect validation fields in results.json')
  }
  report.status = 'complete'
} catch (error) {
  report.status = 'failed'
  report.error = error.stack
  process.exitCode = 1
  log(`FAILED: ${error.message}`)
} finally {
  await client.evaluate('c0Scale.restoreBridge?.()').catch(() => {})
  report.finishedAt = new Date().toISOString()
  await save()
  client.close()
  await adb('forward', '--remove', `tcp:${port}`).catch(() => {})
  log(`${report.status}: ${path.relative(root, output)}/results.json`)
}
