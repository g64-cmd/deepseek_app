import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { rspack } from '@rspack/core'
import { root } from './helpers/compile.mjs'
import { Cdp } from '../scripts/perf/cdp.mjs'

// Opt-in real browser suite. No packages/downloads, profile reuse, API keys or paid requests.
const chrome =
  process.env.C3_BROWSER ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].find(existsSync)
let output, profile, server, browser, cdp
let delayChunks = 0
const cssResponses = []
const observations = []
const artifacts = process.env.C3_ARTIFACTS ? path.resolve(root, process.env.C3_ARTIFACTS) : null
const screenshot = async (name) => {
  if (!artifacts) return
  assert.ok(
    artifacts.startsWith(path.join(root, 'tmp') + path.sep),
    'C3_ARTIFACTS must be under workspace tmp/'
  )
  await mkdir(artifacts, { recursive: true })
  const shot = await cdp.call('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(artifacts, name + '.png'), Buffer.from(shot.data, 'base64'))
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = async (expression, expected = true) =>
  assert.deepEqual(await cdp.evaluate(expression), expected)
const wait = async (expression) => {
  for (let i = 0; i < 100; i++) {
    if (await cdp.evaluate(`Boolean(${expression})`)) return
    await sleep(50)
  }
  throw new Error(`Timed out: ${expression}`)
}
const run = async (expression) => {
  await cdp.evaluate(expression)
  await sleep(30)
}
const key = async (key, modifiers = 0) => {
  const codes = {
    Enter: 13,
    Escape: 27,
    Tab: 9,
    ArrowDown: 40,
    ArrowUp: 38,
    ArrowLeft: 37,
    ArrowRight: 39,
    Home: 36,
    End: 35,
    ' ': 32,
  }
  const windowsVirtualKeyCode = codes[key] ?? key.toUpperCase().charCodeAt(0)
  await cdp.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code: key === ' ' ? 'Space' : key,
    modifiers,
    windowsVirtualKeyCode,
    text: key === 'Enter' ? '\r' : key.length === 1 ? key : undefined,
  })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers, windowsVirtualKeyCode })
  await sleep(40)
}
const focus = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).focus()`)
const activate = async (selector) => {
  await focus(selector)
  await key('Enter')
}
const viewport = async (width = 1200, height = 900, mobile = false) => {
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  })
  await cdp.evaluate(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'
  )
}
const click = async (selector, point) => {
  const target = await cdp.evaluate(`(()=>{
    const node=document.querySelector(${JSON.stringify(selector)});
    if(!node) throw Error('Missing pointer target');
    const r=node.getBoundingClientRect();const p=${JSON.stringify(point ?? null)}??{x:r.x+r.width/2,y:r.y+r.height/2};
    const hit=document.elementFromPoint(p.x,p.y);
    return {...p,reachable:node===hit||node.contains(hit),hit:hit?.outerHTML.slice(0,200)};
  })()`)
  assert.ok(target.reachable, `Pointer target ${selector} covered by ${target.hit}`)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.call('Input.dispatchMouseEvent', {
      type,
      x: target.x,
      y: target.y,
      button: 'left',
      clickCount: 1,
    })
  }
  await sleep(60)
}
const loadedStyles = async () => {
  await wait('document.querySelector("link[rel=stylesheet]")?.sheet?.cssRules.length > 0')
  assert.ok(
    cssResponses.some(({ pathname, status }) => pathname === '/app.css' && status === 200),
    'app.css must have an HTTP 200 response'
  )
  assert.ok(
    cssResponses.every(({ status }) => status === 200),
    'no failed stylesheet requests'
  )
  await check('getComputedStyle(document.body).overflow', 'hidden')
  await check('getComputedStyle(document.querySelector("main")).display', 'flex')
}

before(async () => {
  assert.ok(chrome, 'Set C3_BROWSER to a Chrome/Edge/Chromium executable')
  await mkdir(path.join(root, 'tmp'), { recursive: true })
  output = await mkdtemp(path.join(root, 'tmp/c3-browser-build-'))
  profile = await mkdtemp(path.join(root, 'tmp/c3-browser-profile-'))
  const compiler = rspack({
    context: root,
    mode: 'production',
    entry: './tests/helpers/entries/history-search-browser.tsx',
    output: { path: output, filename: 'app.js', cssFilename: 'app.css' },
    devtool: false,
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
      extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
    },
    module: {
      parser: { 'css/module': { namedExports: false } },
      rules: [
        {
          test: /\.(j|t)sx?$/,
          exclude: /node_modules/,
          loader: 'builtin:swc-loader',
          options: {
            jsc: {
              parser: { syntax: 'typescript', tsx: true },
              transform: { react: { runtime: 'automatic' } },
              target: 'es2022',
            },
          },
        },
        { test: /\.module\.css$/, type: 'css/module', use: ['builtin:lightningcss-loader'] },
        {
          test: /\.css$/,
          exclude: /\.module\.css$/,
          type: 'css',
          use: ['builtin:lightningcss-loader'],
        },
        { test: /\.(woff2?|ttf)$/, type: 'asset/resource' },
      ],
    },
    plugins: [
      new rspack.DefinePlugin({ __API_ORIGIN__: JSON.stringify('https://fixture.invalid') }),
    ],
    performance: { hints: false },
  })
  await new Promise((resolve, reject) =>
    compiler.run((error, stats) =>
      compiler.close(() =>
        error || stats.hasErrors()
          ? reject(error ?? new Error(stats.toString({ all: false, errors: true })))
          : resolve()
      )
    )
  )
  await writeFile(
    path.join(output, 'index.html'),
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="app.css"><body><div id="root"></div><script src="app.js"></script></body></html>'
  )
  server = http
    .createServer(async (request, response) => {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      const file = path.resolve(output, '.' + (pathname === '/' ? '/index.html' : pathname))
      if (!file.startsWith(output + path.sep)) {
        response.writeHead(403).end()
        return
      }
      try {
        response.setHeader(
          'Content-Type',
          file.endsWith('.css')
            ? 'text/css'
            : file.endsWith('.js')
              ? 'text/javascript'
              : file.endsWith('.html')
                ? 'text/html'
                : 'application/octet-stream'
        )
        if (file.endsWith('.js') && path.basename(file) !== 'app.js' && delayChunks)
          await sleep(delayChunks)
        const bytes = await readFile(file)
        if (file.endsWith('.css')) cssResponses.push({ pathname, status: 200 })
        response.end(bytes)
      } catch {
        if (file.endsWith('.css')) cssResponses.push({ pathname, status: 404 })
        response.writeHead(404).end()
      }
    })
    .listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  browser = spawn(
    chrome,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' }
  )
  let port
  for (let i = 0; i < 200; i++) {
    try {
      port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
      break
    } catch {
      await sleep(50)
    }
  }
  assert.ok(port, 'Browser did not expose CDP')
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  cdp = await Cdp.connect(pages.find((page) => page.type === 'page').webSocketDebuggerUrl)
  console.log('C3 browser:', JSON.stringify(await cdp.call('Browser.getVersion')))
  await cdp.call('Network.enable')
  await cdp.call('Page.enable')
  await cdp.call('Network.setBlockedURLs', { urls: ['https://*', 'http://fixture.invalid/*'] })
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await cdp.call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` })
  await wait('window.c3 && document.querySelector("[data-app-ready=true]")')
  await cdp.evaluate('c3.seed()')
  await sleep(60)
  await loadedStyles()
})

beforeEach(async () => {
  delayChunks = 0
  // 每例重建应用/夹具，失败的 busy 弹窗、Portal、字体和观察器不能污染下一例。
  await cdp.call('Page.bringToFront')
  await cdp.call('Emulation.setTouchEmulationEnabled', { enabled: false })
  await cdp.call('Emulation.setEmulatedMedia', { features: [] })
  await viewport()
  const loaded = cdp.once('Page.loadEventFired')
  await cdp.call('Page.reload', { ignoreCache: true })
  await loaded
  await wait('window.c3 && document.querySelector("[data-app-ready=true]")')
  await cdp.evaluate('c3.seed()')
  await sleep(60)
  await loadedStyles()
})

after(async () => {
  if (artifacts && artifacts.startsWith(path.join(root, 'tmp') + path.sep)) {
    await mkdir(artifacts, { recursive: true })
    await writeFile(
      path.join(artifacts, 'observations.json'),
      JSON.stringify({ cssResponses, observations }, null, 2) + '\n'
    )
  }
  if (cdp) {
    await cdp.call('Browser.close').catch(() => {})
    cdp.close()
  }
  if (browser && browser.exitCode === null) {
    await Promise.race([new Promise((resolve) => browser.once('exit', resolve)), sleep(2000)])
    if (browser.exitCode === null) browser.kill()
  }
  server?.closeAllConnections()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  for (const directory of [output, profile].filter(Boolean)) {
    assert.equal(path.dirname(directory), path.join(root, 'tmp'))
    assert.match(path.basename(directory), /^c3-browser-(build|profile)-/)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

const search = async (query, mode = 'body') => {
  if (!(await cdp.evaluate('!!document.querySelector("[data-history-search]")')))
    await click('[data-open-history-search]')
  await run(`c3.query(${JSON.stringify(query)}, ${JSON.stringify(mode)})`)
}
const done = async () =>
  wait('document.querySelector("[data-history-search]")?.dataset.historyPhase === "done"')

test('title search uses only summaries, supports Chinese/English, empty, clear and close with focus restored', async () => {
  await click('[data-open-history-search]')
  await check('document.activeElement.type', 'search')
  await cdp.call('Input.insertText', { text: '中文' })
  await wait('document.querySelectorAll("[data-history-title]").length===1')
  await check('document.querySelector("[data-history-title]").dataset.historyTitle', 'deep')
  await check('c3.reads', 0)
  await search('history', 'title')
  await check('document.querySelector("[data-history-title]").dataset.historyTitle', 'other')
  await search('no-match', 'title')
  await check('document.querySelectorAll("[data-history-title]").length', 0)
  await search('', 'title')
  await check('document.querySelectorAll("[data-history-title]").length', 2)
  await check('c3.reads', 0)
  await key('Escape')
  await check('!!document.querySelector("[data-history-search]")', false)
  await check('document.querySelectorAll("[data-session-item]").length', 2)
  await check('document.activeElement.hasAttribute("data-open-history-search")')
})

test('deep branch hit selects ancestors, enhances only target, waits for rich content, scrolls and focuses message', async () => {
  await search('needle')
  await done()
  await check('document.querySelectorAll("[data-history-hit]").length', 2)
  await check(
    'document.querySelector("[data-history-hit=target-answer]").textContent.includes("其他分支")'
  )
  await click('[data-history-hit=target-answer]')
  await wait('document.activeElement.dataset.messageId === "target-answer"')
  await check('c3.state().activeId', 'deep')
  await check(
    'document.querySelector("[data-history-hit=target-answer]").textContent.includes("其他分支")',
    false
  )
  await check(
    'document.querySelector("[data-message-id=target-answer]").querySelectorAll("[data-rich-ready=false]").length',
    0
  )
  const geometry = await cdp.evaluate(`(()=>{
    const node=document.querySelector('[data-message-id=target-answer]');const scroll=document.querySelector('[data-message-scroll]');
    return {top:node.getBoundingClientRect().top-scroll.getBoundingClientRect().top,scrollTop:scroll.scrollTop,offscreenGated:document.querySelectorAll('[data-rich-gated=true]').length,focused:document.activeElement.dataset.messageId};
  })()`)
  assert.ok(geometry.scrollTop > 1000)
  assert.ok(Math.abs(geometry.top - 16) < 4)
  assert.ok(geometry.offscreenGated > 0)
  await check('c3.state().messageTarget', null)
  observations.push({ type: 'deep-anchor', ...geometry })
  await screenshot('deep-anchor')
  await sleep(500)
  await check('document.activeElement.dataset.messageId', 'target-answer')
  await check(
    'Math.abs(document.querySelector("[data-message-id=target-answer]").getBoundingClientRect().top-document.querySelector("[data-message-scroll]").getBoundingClientRect().top-16)<4'
  )
  // Preserve result/query for return navigation; user can close back to the grouped list.
  await key('Escape')
  await check('!!document.querySelector("[data-history-search]")', false)
  await run('document.querySelector("[data-message-scroll]").scrollTop -= 600')
  const readingPosition = await cdp.evaluate(
    'document.querySelector("[data-message-scroll]").scrollTop'
  )
  await run(
    '(()=>{const node=document.querySelector("[data-message-id=target-answer]");const focus=node.focus;window.__focusReplay=0;window.__watchedTarget=node;node.focus=function(options){window.__focusReplay++;return focus.call(this,options)}})()'
  )
  await viewport(412, 840, true)
  await check(
    'window.__watchedTarget === document.querySelector("[data-message-id=target-answer]")'
  )
  await check('window.__focusReplay', 0)
  await check('c3.state().messageTarget', null)
  observations.push({
    type: 'consumed-location-layout',
    readingPosition,
    after: await cdp.evaluate('document.querySelector("[data-message-scroll]").scrollTop'),
    focusReplays: 0,
  })
})

test('mobile Back closes search before drawer; selecting title closes drawer, and reopening retains query', async () => {
  await viewport(412, 840, true)
  await run('c3.openMobileSider()')
  await search('中文', 'title')
  await run('c3.closeTopModal()')
  await check('!!document.querySelector("[data-history-search]")', false)
  await check('!!document.querySelector("[data-mobile-drawer-panel]")')
  await search('中文', 'title')
  await click('[data-history-title=deep]')
  await wait('!document.querySelector("[data-mobile-drawer-panel]")')
  await run('c3.openMobileSider()')
  await check('document.querySelector("input[type=search]").value', '中文')
  await run('c3.closeTopModal()')
  await check('!!document.querySelector("[data-mobile-drawer-panel]")')
  await run('c3.closeTopModal()')
  await check('!!document.querySelector("[data-mobile-drawer-panel]")', false)
  await check('document.activeElement.hasAttribute("data-open-sidebar")')
})

test('mobile body hit closes drawer and focuses target after inert is released', async () => {
  await viewport(412, 840, true)
  await run('c3.openMobileSider()')
  await search('needle')
  await done()
  await click('[data-history-hit=target-user]')
  await wait('document.activeElement.dataset.messageId === "target-user"')
  await check('!!document.querySelector("[data-mobile-drawer-panel]")', false)
  await check('document.querySelectorAll("[inert]").length', 0)
  await screenshot('mobile-anchor')
})

test('rapid query changes and cancellation cannot republish old results, locale change preserves focus and query', async () => {
  await search('needle')
  await done()
  await focus('input[type=search]')
  await run('c3.query("needle");c3.query("unique");c3.query("absent")')
  await done()
  await check('document.querySelectorAll("[data-history-hit]").length', 0)
  await check('document.activeElement.type', 'search')
  await run('c3.setLocale("en-US")')
  await check('document.querySelector("input[type=search]").value', 'absent')
  await check('document.activeElement.type', 'search')
  await search('needle')
  await run(
    'Array.from(document.querySelectorAll("[data-history-search] button")).find(b=>b.textContent==="Cancel").click()'
  )
  await sleep(250)
  await check(
    'document.querySelector("[data-history-search] [role=status]").textContent',
    'Search cancelled. You can retry.'
  )
})

test('history replacement clears results, deletion removes matches and saved updates are rescanned', async () => {
  await search('unique')
  await done()
  await check('document.querySelectorAll("[data-history-hit]").length', 1)
  await cdp.evaluate('c3.removeSession("other")')
  await done()
  await check('document.querySelectorAll("[data-history-hit]").length', 0)
  await cdp.evaluate('c3.seed()')
  await search('updatedNeedle')
  await done()
  await cdp.evaluate('c3.update("updatedNeedle")')
  await wait('document.querySelectorAll("[data-history-hit]").length===1')
  await cdp.evaluate('c3.replace()')
  await done()
  await check('document.querySelectorAll("[data-history-hit]").length', 0)
})

test('streaming text does not enter search until completion; branch open is blocked until stop', async () => {
  await search('needle')
  await done()
  await run('c3.stream(true)')
  await done()
  await click('[data-history-hit=target-user]')
  await check('c3.state().activeId', null)
  await check(
    'document.querySelector("[data-history-search] [role=status]").textContent.includes("请先停止生成")'
  )
  await search('freshTokenResult')
  await done()
  await check('document.querySelectorAll("[data-history-hit]").length', 0)
  await run('c3.stream(false)')
  await wait('document.querySelectorAll("[data-history-hit]").length===1')
  await click('[data-history-hit=target-answer]')
  await wait('document.activeElement.dataset.messageId === "target-answer"')
})

test('1000-session C0 text scale measures first/completion latency and bounds result/cache size', async () => {
  await cdp.evaluate('c3.seed(true)')
  const scale = await cdp.evaluate('c3.scale()')
  assert.equal(scale.sessions, 1000)
  assert.equal(scale.messages, 2000)
  assert.equal(scale.reads, 1000)
  assert.equal(scale.resultTotal, 2000)
  assert.equal(scale.shown, 200)
  assert.equal(scale.cacheSize, 0)
  assert.ok(Math.max(...scale.titles) < 100, '1000 title filter <100ms')
  // Fixed desktop engineering budget for this fixture; Android is recorded separately.
  assert.ok(scale.firstMs < 1000, 'first batch <1s')
  assert.ok(scale.elapsedMs < 5000, 'full scan <5s')
  observations.push({ type: 'scale', ...scale })
  console.log('C3 scale:', JSON.stringify(scale))
})

test('read failure is explicit and retry recovers without an empty-success result', async () => {
  await run('c3.failReads(true)')
  await search('needle')
  await wait('document.querySelector("[data-history-search]")?.dataset.historyPhase === "error"')
  await check(
    'document.querySelector("[data-history-search] [role=status]").textContent',
    '读取历史失败，请重试。'
  )
  await run(
    'c3.failReads(false); [...document.querySelectorAll("[data-history-search] button")].find(n=>n.textContent==="重试").click()'
  )
  await done()
  await check('document.querySelectorAll("[data-history-hit]").length', 2)
})

test('320px search at 200% text and coarse pointer keeps controls inside a scrollable drawer', async () => {
  await viewport(320, 700, true)
  await cdp.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await run('c3.openMobileSider()')
  await search('needle')
  await done()
  await run(
    `(()=>{const nodes=[...document.querySelectorAll('[data-history-search], [data-history-search] *')].map(node=>({node,size:parseFloat(getComputedStyle(node).fontSize)*2}));for(const {node,size} of nodes)node.style.fontSize=size+'px'})()`
  )
  const geometry = await cdp.evaluate(
    `(()=>{const root=document.querySelector('[data-history-search]');return {width:root.clientWidth,scrollWidth:root.scrollWidth,controls:[...root.querySelectorAll('input,select,button')].map(n=>({name:n.getAttribute('aria-label')||n.textContent.slice(0,20),x:n.getBoundingClientRect().x,right:n.getBoundingClientRect().right,height:n.getBoundingClientRect().height}))}})()`
  )
  assert.ok(geometry.scrollWidth <= geometry.width + 1, JSON.stringify(geometry))
  assert.ok(
    geometry.controls.every(
      (control) => control.x >= 0 && control.right <= 272 && control.height >= 44
    ),
    JSON.stringify(geometry)
  )
  observations.push({ type: 'mobile-200', ...geometry })
  await run('c3.setLocale("en-US")')
  await check(
    '(()=>{const root=document.querySelector("[data-history-search]");return root.scrollWidth<=root.clientWidth+1 && root.scrollHeight>root.clientHeight && [...root.querySelectorAll("input,select,button")].every(n=>n.getBoundingClientRect().right<=272)})()'
  )
  await run(
    'document.querySelector("[data-history-hit=target-user]").scrollIntoView({block:"center"})'
  )
  await screenshot('mobile-search-200')
  await click('[data-history-hit=target-user]')
  await wait('document.activeElement.dataset.messageId === "target-user"')
})

for (const operation of ['query', 'scope', 'cancel', 'close']) {
  test(`pending location yields to ${operation} without late scrolling or focus theft`, async () => {
    await search('needle')
    await done()
    delayChunks = 1000
    await click('[data-history-hit=target-answer]')
    await wait(
      'document.querySelector("[data-message-id=target-answer]")?.querySelector("[data-rich-ready=false]")'
    )
    const before = await cdp.evaluate('document.querySelector("[data-message-scroll]").scrollTop')
    if (operation === 'query') {
      await focus('input[type=search]')
      await cdp.call('Input.insertText', { text: 'continued' })
    } else if (operation === 'scope') {
      await focus('[data-history-search] select')
      await key('Home')
    } else if (operation === 'cancel') {
      await focus('[data-history-search] > button')
      await key('Enter')
    } else {
      await click('[data-history-search] [aria-label="关闭历史检索"]')
    }
    await wait('c3.state().messageTarget === null')
    await wait(
      '!document.querySelector("[data-message-id=target-answer]").querySelector("[data-rich-ready=false]")'
    )
    await sleep(150)
    await check('document.activeElement.dataset.messageId === "target-answer"', false)
    if (operation === 'query') await check('document.activeElement.type', 'search')
    if (operation === 'scope') await check('document.activeElement.tagName', 'SELECT')
    if (operation === 'close')
      await check('document.activeElement.hasAttribute("data-open-history-search")')
    const after = await cdp.evaluate('document.querySelector("[data-message-scroll]").scrollTop')
    assert.equal(after, before, 'cancelled location must not move the reading position')
    observations.push({ type: 'cancel-pending-location', operation, before, after })
  })
}

test('mobile reopening search cancels pending location while ordinary drawer dismissal still allows location', async () => {
  await viewport(412, 840, true)
  await run('c3.openMobileSider()')
  await search('needle')
  await done()
  delayChunks = 1000
  await click('[data-history-hit=target-answer]')
  await wait(
    '!document.querySelector("[data-mobile-drawer-panel]") && c3.state().messageTarget !== null'
  )
  await run('c3.openMobileSider()')
  await wait('document.querySelector("[data-history-search]") && c3.state().messageTarget === null')
  await check('document.activeElement.type', 'search')
  await wait(
    '!document.querySelector("[data-message-id=target-answer]").querySelector("[data-rich-ready=false]")'
  )
  await run('c3.closeTopModal()')
  await check('!!document.querySelector("[data-history-search]")', false)
  await check('!!document.querySelector("[data-mobile-drawer-panel]")')
  await run('c3.closeTopModal()')
  await sleep(150)
  await check('document.activeElement.hasAttribute("data-open-sidebar")')
  await check('c3.state().messageTarget', null)
})

for (const status of ['pending', 'streaming']) {
  test(`persisted ${status} text is searchable cold and recovery refreshes once without token rescans`, async () => {
    await cdp.evaluate(`c3.interrupted(${JSON.stringify(status)})`)
    await search('interruptedSavedToken')
    await done()
    await check('document.querySelectorAll("[data-history-hit]").length', 1)
    await check('Object.keys(c3.state().sessionCache).length', 0)
    const revision = await cdp.evaluate('c3.state().historySearchRevision')
    if (status === 'pending') {
      await click('[data-history-hit=target-answer]')
      await wait('document.activeElement.dataset.messageId === "target-answer"')
    } else {
      await run('c3.selectSession("deep")')
    }
    await done()
    await check(
      'c3.state().sessionCache.deep.messages.find(m=>m.id==="target-answer").status',
      'stopped'
    )
    await check('c3.state().historySearchRevision', revision + 1)
    await check('document.querySelectorAll("[data-history-hit]").length', 1)
    await run('c3.selectSession("deep")')
    await check('c3.state().historySearchRevision', revision + 1)
    await run('c3.stream(true)')
    await search('freshTokenResult')
    await done()
    const reads = await cdp.evaluate('c3.reads')
    await run(
      'window.__tokenPhases=[];window.__tokenObserver=new MutationObserver(()=>__tokenPhases.push(document.querySelector("[data-history-search]").dataset.historyPhase));__tokenObserver.observe(document.querySelector("[data-history-search]"),{attributes:true,attributeFilter:["data-history-phase"]})'
    )
    await run(
      'c3.token("freshTokenResult 1");c3.token("freshTokenResult 2");c3.token("freshTokenResult 3")'
    )
    await sleep(300)
    await check('c3.reads', reads)
    await check('window.__tokenPhases', [])
    await run('window.__tokenObserver.disconnect()')
    await check('document.querySelectorAll("[data-history-hit]").length', 0)
    await run('c3.stream(false)')
    await done()
    await check('document.querySelectorAll("[data-history-hit]").length', 1)
  })
}

for (const [operation, completeScan] of [
  ['query', false],
  ['scope', false],
  ['cancel', false],
  ['close', false],
  ['cancel', true],
]) {
  test(`${operation} during partial result database open${completeScan ? ' after scan completes' : ''} prevents late navigation`, async () => {
    await cdp.evaluate('c3.seed(true)')
    // 保留真实 IndexedDB 请求与结果，只挂起 success 的交付；扫描先以 40ms/条输出首批。
    await cdp.evaluate(`(()=>{
      const original=IDBObjectStore.prototype.get;
      window.__readDelay=40;window.__holdGetId=null;window.__heldReads=[];
      IDBObjectStore.prototype.get=function(...args){
        const request=original.apply(this,args);
        if(this.name==='sessions'){
          const delay=window.__readDelay,hold=args[0]===window.__holdGetId;
          request.addEventListener('success',event=>{
            if(!event.isTrusted)return;
            if(hold||delay){event.stopImmediatePropagation();const deliver=()=>request.dispatchEvent(new Event('success'));if(hold)window.__heldReads.push(deliver);else setTimeout(deliver,delay)}
          },{capture:true});
        }
        return request;
      };
    })()`)
    await search('getMessageUsage')
    await wait(
      'document.querySelector("[data-history-hit]") && document.querySelector("[data-history-search]").dataset.historyPhase === "searching"'
    )
    await cdp.evaluate('window.__holdGetId="c0-v1-list-0000"')
    await click('[data-history-hit]')
    await wait('window.__heldReads.length > 0')
    await check('c3.state().activeId', null)
    await check('c3.state().messageTarget', null)
    await check('document.querySelector("[data-history-hit]").disabled')
    if (completeScan) {
      await cdp.evaluate('window.__readDelay=0')
      await done()
    }
    if (operation === 'query') {
      await focus('input[type=search]')
      await cdp.call('Input.insertText', { text: 'changed' })
      await sleep(30)
    } else if (operation === 'scope') {
      await focus('[data-history-search] select')
      await key('Home')
    } else if (operation === 'close') {
      await click('[data-history-search] [aria-label="关闭历史检索"]')
    } else {
      await check('document.querySelector("[data-history-search] > button")?.textContent', '取消')
      await focus('[data-history-search] > button')
      await key('Enter')
      await check(
        'document.querySelector("[data-history-search]").dataset.historyPhase',
        'cancelled'
      )
    }
    const beforeRelease = await cdp.evaluate(
      '({active:c3.state().activeId,focused:document.activeElement.tagName,type:document.activeElement.type??null,message:document.activeElement.dataset.messageId??null,scroll:document.querySelector("[data-message-scroll]")?.scrollTop??null})'
    )
    const released = await cdp.evaluate(
      '(()=>{window.__holdGetId=null;window.__readDelay=0;const reads=window.__heldReads.splice(0);for(const deliver of reads)deliver();return reads.length})()'
    )
    assert.ok(
      released > 0,
      'the cancelled navigation must actually finish its pending database read'
    )
    await sleep(300)
    const afterRelease = await cdp.evaluate(
      '({active:c3.state().activeId,focused:document.activeElement.tagName,type:document.activeElement.type??null,message:document.activeElement.dataset.messageId??null,scroll:document.querySelector("[data-message-scroll]")?.scrollTop??null})'
    )
    assert.deepEqual(
      afterRelease,
      beforeRelease,
      'late read must not change conversation, focus or scroll after cancellation'
    )
    assert.equal(afterRelease.active, null)
    if (operation === 'cancel')
      await check('document.querySelector("[data-history-hit]").disabled', false)
    await check('c3.state().messageTarget', null)
    if (operation === 'cancel')
      await check(
        'document.querySelector("[data-history-search]").dataset.historyPhase',
        'cancelled'
      )
    observations.push({
      type: 'cancel-database-open',
      operation,
      completeScan,
      released,
      beforeRelease,
      afterRelease,
    })
  })
}
