/** C3 offline UI/IndexedDB scale and branch navigation, exclusively in the disposable C0 package.
 * Replaces only known synthetic C0 data. Never use the daily application package. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cdp } from './cdp.mjs'
import { buildFixture } from './fixtures.mjs'
const exec = promisify(execFile)
const pkg = 'com.g64_cmd.whalechat.c0'
const root = fileURLToPath(new URL('../../', import.meta.url))
process.chdir(root)
const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, '').split('=')
    return [key, value.join('=')]
  })
)
const directory = path.resolve(root, options.output ?? 'tmp/c3-android')
if (!directory.startsWith(path.join(root, 'tmp') + path.sep)) {
  throw Error('Output must be under workspace tmp/')
}
const properties = await readFile('android/local.properties', 'utf8').catch(() => '')
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
const serial = options.serial ?? 'emulator-5554'
const coldCount = Number(options.cold ?? 5),
  warmCount = Number(options.warm ?? 10)
if (![coldCount, warmCount].every((n) => Number.isInteger(n) && n >= 0 && n <= 100)) {
  throw Error('Invalid sample count')
}
const adb = async (...args) =>
  (
    await exec(adbPath, ['-s', serial, ...args], { timeout: 45000, maxBuffer: 5 * 1024 * 1024 })
  ).stdout.trim()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha = (data) => createHash('sha256').update(data).digest('hex')
const report = { samples: [], checks: [], started: new Date().toISOString() }
let cdp
await mkdir(directory, { recursive: true })
const apk = options.apk ?? 'android/app/build/outputs/apk/debug/app-debug.apk'
const fixture = buildFixture()
const sessions = fixture.sessions.filter((s) => s.id.startsWith('c0-v1-list-'))
const branch = fixture.sessions.find((s) => s.id === 'c0-v1-branches')
const hit = branch.messages.at(-1)
hit.blocks = [
  {
    type: 'text',
    text: 'C3deepneedle\n\n```ts\nconst deepTarget = 1\n```\n\n$$\nx^2 + y^2 = 1\n$$\n\n```mermaid\nflowchart LR\nA --> B\n```',
  },
]
report.fixture = {
  sessions: sessions.length,
  messages: sessions.reduce((n, s) => n + s.messages.length, 0),
  jsonSha256: sha(JSON.stringify(sessions)),
  fixtureSourceSha256: sha(await readFile('scripts/perf/fixtures.mjs')),
  branchSha256: sha(JSON.stringify(branch)),
  hitId: hit.id,
  textUnits: sessions.reduce(
    (n, s) =>
      n +
      s.messages.reduce(
        (m, message) =>
          m +
          (message.role === 'user'
            ? message.content
            : message.blocks
                .filter((b) => b.type === 'text' && !b.isTemplate)
                .map((b) => b.text)
                .join('\n\n')
          ).length,
        0
      ),
    0
  ),
  textBytes: sessions.reduce(
    (n, s) =>
      n +
      s.messages.reduce(
        (m, message) =>
          m +
          Buffer.byteLength(
            message.role === 'user'
              ? message.content
              : message.blocks
                  .filter((b) => b.type === 'text' && !b.isTemplate)
                  .map((b) => b.text)
                  .join('\n\n')
          ),
        0
      ),
    0
  ),
}
async function wait(expression) {
  for (let i = 0; i < 150; i++) {
    if (await cdp.evaluate(`Boolean(${expression})`)) {
      return
    }
    await sleep(100)
  }
  throw Error(`timeout ${expression}`)
}
async function run(expression) {
  await cdp.evaluate(expression)
  await sleep(150)
}
async function launch() {
  cdp?.close()
  await adb('shell', 'am', 'force-stop', pkg)
  await adb('shell', 'am', 'start', '-W', '-n', `${pkg}/com.g64_cmd.whalechat.MainActivity`)
  for (let i = 0; i < 80; i++) {
    try {
      const pid = await adb('shell', 'pidof', pkg)
      if (!/^\d+$/.test(pid)) {
        throw Error('no pid')
      }
      await adb('forward', 'tcp:9224', `localabstract:webview_devtools_remote_${pid}`)
      const pages = await (await fetch('http://127.0.0.1:9224/json')).json()
      cdp = await Cdp.connect(pages.find((p) => p.type === 'page').webSocketDebuggerUrl)
      await cdp.call('Network.enable')
      await cdp.call('Network.setBlockedURLs', {
        urls: ['*api.deepseek.com*', 'https://fixture.invalid/*'],
      })
      await wait('document.querySelector("[data-app-ready=true]")')
      if (await cdp.evaluate('!!document.querySelector("[role=dialog]")')) {
        await run('document.querySelector("[role=tab]")?.click()')
        await run(
          `(()=>{const select=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='zh-CN'));if(select){select.value='zh-CN';select.dispatchEvent(new Event('change',{bubbles:true}))}return true})()`
        )
        await run('document.querySelector("[role=dialog] button[aria-label=关闭]").click()')
        await wait('!document.querySelector("[role=dialog]")')
      }
      await wait('document.documentElement.lang === "zh-CN"')
      return
    } catch {
      await sleep(300)
    }
  }
  throw Error('no CDP')
}
async function openSearch() {
  await run('document.querySelector("[data-open-sidebar]").click()')
  await run('document.querySelector("[data-open-history-search]").click()')
  await wait('document.querySelector("[data-history-search]")')
  assert.equal(
    await cdp.evaluate('document.querySelector("input[type=search]").closest("[inert]") === null'),
    true
  )
}
const setInput = `(value)=>{const node=document.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}))}`
async function sample(kind, n) {
  if (kind === 'cold') {
    await launch()
  }
  if (!(await cdp.evaluate('!!document.querySelector("[data-history-search]")'))) {
    await openSearch()
  }
  // Title latency measures controlled input through filtered DOM and two paint opportunities.
  await run(
    `(()=>{const scope=document.querySelector('[data-history-search] select');scope.value='title';scope.dispatchEvent(new Event('change',{bubbles:true}));(${setInput})('')})()`
  )
  const titleMs = await cdp.evaluate(
    `new Promise((resolve,reject)=>{const start=performance.now();const timer=setTimeout(()=>{observer.disconnect();reject(Error('title timeout'))},5000);const observer=new MutationObserver(()=>{if(document.querySelectorAll('[data-history-title]').length===1){observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve(performance.now()-start)}))}});observer.observe(document.querySelector('[data-history-search]'),{subtree:true,childList:true,attributes:true});(${setInput})('999')})`
  )
  const body = await cdp.evaluate(`new Promise((resolve,reject)=>{
    const start=performance.now();let firstMs=null;const tasks=[];const longtasks=new PerformanceObserver(list=>tasks.push(...list.getEntries().map(e=>e.duration)));longtasks.observe({entryTypes:['longtask']});
    const timer=setTimeout(()=>{observer.disconnect();longtasks.disconnect();reject(Error('body timeout'))},15000);
    const observer=new MutationObserver(()=>{const root=document.querySelector('[data-history-search]');const count=root.querySelectorAll('[data-history-hit]').length;
      if(count&&firstMs===null)firstMs=performance.now()-start;
      if(root.dataset.historyPhase==='done'){observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);longtasks.disconnect();resolve({firstMs,completeMs:performance.now()-start,shown:count,status:root.querySelector('[role=status]').textContent,maxLongtask:Math.max(0,...tasks),width:innerWidth,height:innerHeight})}))}
    });observer.observe(document.querySelector('[data-history-search]'),{subtree:true,childList:true,attributes:true,characterData:true});
    const scope=document.querySelector('[data-history-search] select');scope.value='body';scope.dispatchEvent(new Event('change',{bubbles:true}));(${setInput})('getMessageUsage');
  })`)
  assert.equal(body.shown, 200)
  assert.equal(body.status, '找到 2000 条消息')
  report.samples.push({ kind, n, titleMs, ...body })
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2))
  process.stdout.write(JSON.stringify({ kind, n, titleMs, ...body }) + '\n')
}
try {
  await adb('wait-for-device')
  for (let i = 0; i < 100; i++) {
    if ((await adb('shell', 'getprop', 'sys.boot_completed')) === '1') {
      break
    }
    await sleep(500)
  }
  // 只校验预先安装的独立测试包；误选常规 APK 时不能先覆盖日常应用再发现包名不符。
  report.apkSha256 = sha(await readFile(apk))
  report.packageId = pkg
  const installed = (await adb('shell', 'pm', 'path', pkg))
    .split('\n')
    .find((line) => line.startsWith('package:'))
    ?.slice(8)
  assert.ok(installed, 'C0 package must be installed')
  assert.equal(
    (await adb('shell', 'sha256sum', installed)).split(/\s+/)[0],
    report.apkSha256,
    'Installed C0 APK must match selected APK'
  )
  report.environment = {
    model: await adb('shell', 'getprop', 'ro.product.model'),
    android: await adb('shell', 'getprop', 'ro.build.version.release'),
    webview: await adb('shell', 'dumpsys', 'webviewupdate'),
    font: await adb('shell', 'settings', 'get', 'system', 'font_scale'),
  }
  await launch()
  // Explicitly restricted test package. Reject unknown test data rather than overwriting user records.
  assert.equal(pkg, 'com.g64_cmd.whalechat.c0')
  await cdp.evaluate(`(async()=>{const db=await new Promise((r,j)=>{const q=indexedDB.open('chat-demo');q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});const keys=await new Promise((r,j)=>{const q=db.transaction('sessions').objectStore('sessions').getAllKeys();q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});if(!keys.every(id=>/^(c0-|c2-|perf-)/.test(id)))throw Error('unknown C0 data');
    const tx=db.transaction(['sessions','sessionSummaries','files','sessionsStaging','filesStaging'],'readwrite');for(const name of ['sessions','sessionSummaries','files','sessionsStaging','filesStaging'])tx.objectStore(name).clear();
    for(const s of ${JSON.stringify(sessions)}){tx.objectStore('sessions').put(s);tx.objectStore('sessionSummaries').put({id:s.id,title:s.title,createdAt:s.createdAt,updatedAt:s.updatedAt,fileIds:[]})}await new Promise((r,j)=>{tx.oncomplete=r;tx.onerror=()=>j(tx.error)});db.close();localStorage.setItem('chat-demo:locale','zh-CN');localStorage.setItem('chat-demo:theme-preference','light');return true})()`)
  for (let i = 0; i < coldCount; i++) {
    await sample('cold', i + 1)
  }
  for (let i = 0; i < warmCount; i++) {
    await sample('warm', i + 1)
  }
  // Add a separate known off-path branch for navigation; not included in the 1000-session samples.
  await cdp.evaluate(
    `(async()=>{const db=await new Promise(r=>{const q=indexedDB.open('chat-demo');q.onsuccess=()=>r(q.result)});const tx=db.transaction(['sessions','sessionSummaries'],'readwrite');const s=${JSON.stringify(branch)};tx.objectStore('sessions').put(s);tx.objectStore('sessionSummaries').put({id:s.id,title:s.title,createdAt:s.createdAt,updatedAt:s.updatedAt,fileIds:[]});await new Promise((r,j)=>{tx.oncomplete=r;tx.onerror=()=>j(tx.error)});db.close();return true})()`
  )
  await launch()
  await openSearch()
  await run(
    `(()=>{const scope=document.querySelector('[data-history-search] select');scope.value='body';scope.dispatchEvent(new Event('change',{bubbles:true}));(${setInput})('C3deepneedle')})()`
  )
  await wait('document.querySelector("[data-history-search]")?.dataset.historyPhase === "done"')
  assert.equal(await cdp.evaluate('document.querySelectorAll("[data-history-hit]").length'), 1)
  assert.equal(
    await cdp.evaluate(
      'document.querySelector("[data-history-hit]").textContent.includes("其他分支")'
    ),
    true
  )
  await run('document.querySelector("[data-history-hit]").click()')
  await wait(`document.activeElement.dataset.messageId === ${JSON.stringify(hit.id)}`)
  assert.equal(await cdp.evaluate('!!document.querySelector("[data-mobile-drawer-panel]")'), false)
  report.navigation = await cdp.evaluate(
    `(()=>{const node=document.activeElement;const scroll=document.querySelector('[data-message-scroll]');return {id:node.dataset.messageId,top:node.getBoundingClientRect().top-scroll.getBoundingClientRect().top,pending:node.querySelectorAll('[data-rich-ready=false]').length,visibleIds:[...document.querySelectorAll('[data-message-id]')].map(n=>n.dataset.messageId),viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}}})()`
  )
  assert.equal(report.navigation.pending, 0)
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' })
  await writeFile(`${directory}/branch-anchor.png`, Buffer.from(shot.data, 'base64'))
  report.checks.push(
    'deep off-path branch selected; rich target ready; drawer closed; DOM focus moved to hit'
  )
  await run('document.querySelector("[data-open-sidebar]").click()')
  await wait('document.querySelector("[data-history-search]")')
  let backCount = 0
  while (
    (await cdp.evaluate('!!document.querySelector("[data-history-search]")')) &&
    backCount < 3
  ) {
    await adb('shell', 'input', 'keyevent', '4')
    await sleep(400)
    backCount++
  }
  report.backCountThroughSearch = backCount
  assert.equal(await cdp.evaluate('!!document.querySelector("[data-history-search]")'), false)
  assert.equal(await cdp.evaluate('!!document.querySelector("[data-mobile-drawer-panel]")'), true)
  await adb('shell', 'input', 'keyevent', '4')
  await sleep(400)
  assert.equal(await cdp.evaluate('!!document.querySelector("[data-mobile-drawer-panel]")'), false)
  assert.equal(await cdp.evaluate('document.activeElement.hasAttribute("data-open-sidebar")'), true)
  report.checks.push('real Android Back closes search first, then drawer and restores opener')
  report.status = 'complete'
} catch (error) {
  report.status = 'failed'
  report.error = error.stack
  throw error
} finally {
  cdp?.close()
  await adb('forward', '--remove', 'tcp:9224').catch(() => {})
  await adb('shell', 'am', 'force-stop', pkg).catch(() => {})
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2))
}
