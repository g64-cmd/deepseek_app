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
  process.env.C2_BROWSER ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].find(existsSync)
let output, profile, server, browser, cdp
const cssResponses = []
const observations = []
const artifacts = process.env.C2_ARTIFACTS ? path.resolve(root, process.env.C2_ARTIFACTS) : null
const screenshot = async (name) => {
  if (!artifacts) return
  assert.ok(
    artifacts.startsWith(path.join(root, 'tmp') + path.sep),
    'C2_ARTIFACTS must be under workspace tmp/'
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
const scaleText = () =>
  run(`(()=>{
  const items=[...document.querySelectorAll('[role=dialog], [role=dialog] *')].map(node=>{
    const s=getComputedStyle(node);return{node,size:parseFloat(s.fontSize)*2,line:parseFloat(s.lineHeight)*2}
  });for(const {node,size,line} of items){node.style.fontSize=size+'px';if(Number.isFinite(line))node.style.lineHeight=line+'px'}
})()`)
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
  assert.ok(chrome, 'Set C2_BROWSER to a Chrome/Edge/Chromium executable')
  await mkdir(path.join(root, 'tmp'), { recursive: true })
  output = await mkdtemp(path.join(root, 'tmp/c2-browser-build-'))
  profile = await mkdtemp(path.join(root, 'tmp/c2-browser-profile-'))
  const compiler = rspack({
    context: root,
    mode: 'production',
    entry: './tests/helpers/entries/accessibility.tsx',
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
  console.log('C2 browser:', JSON.stringify(await cdp.call('Browser.getVersion')))
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
  await wait('window.c2 && document.querySelector("[data-app-ready=true]")')
  await run('c2.seed()')
  await loadedStyles()
})

beforeEach(async () => {
  // 每例重建应用/夹具，失败的 busy 弹窗、Portal、字体和观察器不能污染下一例。
  await cdp.call('Page.bringToFront')
  await cdp.call('Emulation.setTouchEmulationEnabled', { enabled: false })
  await cdp.call('Emulation.setEmulatedMedia', { features: [] })
  await viewport()
  const loaded = cdp.once('Page.loadEventFired')
  await cdp.call('Page.reload', { ignoreCache: true })
  await loaded
  await wait('window.c2 && document.querySelector("[data-app-ready=true]")')
  await run('c2.seed()')
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
    assert.match(path.basename(directory), /^c2-browser-(build|profile)-/)
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('modal initial focus, Tab wrap, background isolation and focus restoration', async () => {
  await activate('#fixture-open')
  await check('document.activeElement.textContent', 'Outer')
  await check('document.querySelector("main").closest("[inert]") !== null')
  await key('Tab', 8)
  await check('document.activeElement.id', 'fixture-footer')
  await key('Tab')
  await check('document.activeElement.getAttribute("aria-label")', '关闭')
  await run('document.querySelector("textarea").focus()')
  await check('document.activeElement.closest("[role=dialog]") !== null')
  await key('Escape')
  await check('document.activeElement.id', 'fixture-open')
  await check('document.querySelectorAll("[inert]").length', 0)
})

for (const type of ['image/png', '']) {
  test(`non-vision model rejects a valid PNG before drafting or uploading (MIME ${type || 'empty'})`, async () => {
    await run('c2.mockUploads()')
    await run(`c2.selectImage(${JSON.stringify(type)})`)
    await wait('c2.imageState().requests > 0 || c2.imageState().toast')
    observations.push({
      check: 'image-add-guard',
      mime: type,
      ...(await cdp.evaluate('c2.imageState()')),
    })
    await check('c2.imageState()', {
      attachments: 0,
      requests: 0,
      toast: 'modelNoVisionImageRejected',
    })
  })
}

test('a vision model accepts an empty-MIME PNG and opens the draft in the keyboard-accessible viewer', async () => {
  await run('c2.mockUploads("deepseek-flash")')
  await run('c2.selectImage("")')
  const preview = 'main button[aria-label="draft-image.png"]'
  await wait(`document.querySelector(${JSON.stringify(preview)})`)
  await check('c2.imageState().attachments', 1)
  await check('c2.imageState().requests', 1)
  await activate(preview)
  await wait('document.querySelector("[role=dialog] img")')
  await wait('document.querySelector("[role=dialog] img").naturalWidth === 240')
  await check('document.querySelector("[role=dialog] img").getAttribute("alt")', 'draft-image.png')
  await check('document.activeElement.closest("[role=dialog]") !== null')
  await screenshot('draft-image-viewer')
  await key('Escape')
  await check('document.querySelector("[role=dialog]")', null)
  await check(`document.activeElement === document.querySelector(${JSON.stringify(preview)})`)
  observations.push({
    check: 'empty-mime-accepted-and-draft-viewer-restores-focus',
    ...(await cdp.evaluate('c2.imageState()')),
  })
})

for (const full of [false, true]) {
  test(`${full ? 'full v4 backup' : 'legacy v3 history'} import confirmation initially focuses Cancel and restores the upload trigger`, async () => {
    const historyIds = await cdp.evaluate('c2.historyIds()')
    await run('c2.openSettings("data")')
    const trigger = 'input[accept^=".zip"]'
    await wait(`document.querySelector(${JSON.stringify(trigger)})`)
    await run(`document.querySelector(${JSON.stringify(trigger)}).previousElementSibling.focus()`)
    await run(`c2.selectBackup(${full})`)
    await wait('document.querySelectorAll("[role=dialog]").length === 2')
    await check('document.activeElement.textContent', '取消')
    await check('document.activeElement.hasAttribute("data-initial-focus")')
    await screenshot(full ? 'import-v4-confirmation' : 'import-v3-confirmation')
    await key('Tab')
    await check('document.activeElement.textContent', '确认导入')
    await key('Tab', 8)
    await check('document.activeElement.textContent', '取消')
    await key(full ? 'Escape' : 'Enter')
    await check('document.querySelectorAll("[role=dialog]").length', 1)
    await check(
      `document.activeElement === document.querySelector(${JSON.stringify(trigger)}).previousElementSibling`
    )
    await check('document.querySelector("[data-app-ready=true]") !== null')
    await check('c2.historyIds()', historyIds)
    await key('Escape')
    observations.push({ check: 'real-import-cancel-focus', format: full ? 4 : 3 })
  })
}

test('Portal menu supports arrows, typeahead, activation, Tab and top-only Back/Escape', async () => {
  await activate('#fixture-open')
  await focus('#fixture-menu')
  await key('ArrowDown')
  await check('document.activeElement.textContent', 'Alpha')
  await check('document.querySelector("[role=menu]").closest("[inert]")', null)
  await key('End')
  await check('document.activeElement.textContent', 'Gamma')
  await key('Home')
  await key('b')
  await check('document.activeElement.textContent', 'Beta')
  await key('Enter')
  await check('window.__selected', 'Beta')
  await check('document.activeElement.id', 'fixture-menu')
  await key('ArrowUp')
  await check('document.activeElement.textContent', 'Gamma')
  await run('c2.closeTopModal()')
  await check('document.querySelectorAll("[role=dialog]").length', 1)
  await check('document.activeElement.id', 'fixture-menu')
  await key('ArrowDown')
  await key('Tab')
  await check('document.activeElement.tagName', 'SELECT')
  await key('ArrowDown')
  await check('document.activeElement.value', 'two')
  await focus('#fixture-menu')
  await key('ArrowDown')
  await click('#fixture-field')
  await check('document.activeElement.id', 'fixture-field')
  await check('document.querySelectorAll("[role=menu]").length', 0)
  await key('Escape')
})

test('nested busy dialog consumes close requests and returns focus to parent trigger', async () => {
  await activate('#fixture-open')
  await activate('#fixture-nested')
  await check('document.activeElement.textContent', 'Inner')
  await check('[...document.querySelectorAll("[role=dialog]")][0].closest("[inert]") !== null')
  await activate('#fixture-busy')
  await key('Escape')
  await run('c2.closeTopModal()')
  await check('document.querySelectorAll("[role=dialog]").length', 2)
  await activate('#fixture-busy')
  await key('Escape')
  await check('document.activeElement.id', 'fixture-nested')
  await key('Escape')
})

test('citation nested in an external link opens its own target once with keyboard', async () => {
  await activate('#fixture-open')
  const opened = []
  await cdp.call('Page.enable')
  cdp.listeners.set('Page.windowOpen', new Set([(event) => opened.push(event.url)]))
  await focus('[role=link]')
  await key('Enter')
  // 平台适配器按需 import；等真实 windowOpen 事件，不能假定 40ms 内已加载完成。
  for (let i = 0; i < 100 && !opened.length; i++) await sleep(20)
  assert.deepEqual(opened, ['https://source.invalid/'])
  const targets = await cdp.call('Target.getTargets')
  for (const target of targets.targetInfos.filter((target) =>
    target.url.startsWith('https://source.invalid')
  )) {
    await cdp.call('Target.closeTarget', { targetId: target.targetId })
  }
  await cdp.call('Page.bringToFront')
  await key('Escape')
})

test('session title/menu, rename and settings tabs work from the keyboard', async () => {
  await activate('[data-session-item="c2-second"]')
  await check(
    'document.querySelector("[data-session-item=c2-second]").getAttribute("aria-current")',
    'page'
  )
  await activate('[data-session-row="c2-second"] [aria-haspopup=menu]')
  await key('Enter')
  await check('document.activeElement.tagName', 'INPUT')
  await key('Escape')
  await check(
    'document.activeElement.closest("[data-session-item]").getAttribute("data-session-item")',
    'c2-second'
  )
  await run('c2.openSettings("general")')
  await focus('[role=tab][aria-selected=true]')
  await key('End')
  await check('document.activeElement.textContent', '数据管理')
  await check(
    'document.querySelector("[role=tabpanel]").getAttribute("aria-labelledby") === document.activeElement.id'
  )
  await key('Escape')
})

test('generation status changes once per transition without announcing tokens', async () => {
  await run(
    'c2.seed(); window.__announcements=[]; new MutationObserver(() => __announcements.push(document.querySelector("[data-reply-status]")?.textContent.trim())).observe(document.querySelector("[data-reply-status]"), {childList:true,characterData:true,subtree:true})'
  )
  await run('c2.transition("pending")')
  await run('c2.transition("streaming", "first token")')
  await run('c2.transition("streaming", "second token")')
  await run('c2.transition("done")')
  await check('window.__announcements', ['助手正在生成回答', '助手回答已完成'])
  await run('c2.transition("pending");')
  await run('c2.transition("stopped")')
  await check('document.querySelector("[data-reply-status]").textContent.trim()', '已停止生成')
  await run('c2.transition("pending")')
  await run('c2.transition("error")')
  await check('document.querySelector("[data-reply-status]").textContent.includes("回答失败")')
})

test('session deletion restores focus after its invoking item disappears', async () => {
  await run('c2.seed()')
  await activate('[data-session-row="c2-second"] [aria-haspopup=menu]')
  await key('End')
  await key('Enter')
  await wait('document.querySelector("[role=dialog]")')
  await run(
    '[...document.querySelectorAll("[role=dialog] button")].find(b=>b.textContent.trim()==="删除").focus()'
  )
  await key('Enter')
  await wait(
    '!document.querySelector("[data-session-item=c2-second]") && !document.querySelector("[role=dialog]")'
  )
  await check('document.activeElement.tagName', 'TEXTAREA')
})

test('thinking collapse and image zoom/pan/reset are keyboard operable', async () => {
  await run('c2.seed()')
  await activate('[aria-controls][aria-expanded=true]')
  await check('document.activeElement.getAttribute("aria-expanded")', 'false')
  await activate('#fixture-open')
  await key('Escape')
  await focus('textarea')
  await run('c2.image()')
  await wait('document.querySelector("[role=dialog] img")?.complete')
  await activate('[role=dialog] button:nth-of-type(1)[aria-label]')
  // Reopen; close control is the first button in the dialog.
  await run('c2.image()')
  await wait('document.querySelector("[role=dialog] img")?.complete')
  await run(
    '[...document.querySelectorAll("[role=dialog] button")].find(x=>x.textContent==="放大图片").focus()'
  )
  await key('Enter')
  await check('document.querySelector("[role=dialog] img").style.transform', 'scale(2.5)')
  await run(
    '[...document.querySelectorAll("[role=dialog] button")].find(x=>x.textContent==="向右移动图片").focus()'
  )
  await key('Enter')
  await run(
    '[...document.querySelectorAll("[role=dialog] button")].find(x=>x.textContent==="缩小至原始大小").focus()'
  )
  await key('Enter')
  await check('document.querySelector("[role=dialog] img").style.transform', '')
  await key('Escape')
  await check('document.activeElement.tagName', 'TEXTAREA')
})

test('mobile drawer isolates background, accepts Portal menu and restores its trigger', async () => {
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 720,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await wait('document.querySelector("[data-open-sidebar]")')
  await activate('[aria-label="打开边栏"]')
  await check('document.querySelector("main").closest("[inert]") !== null')
  await activate('[data-session-row="c2-session"] [aria-haspopup=menu]')
  await run('c2.closeTopModal()')
  await check('document.querySelectorAll("[role=dialog]").length', 1)
  await key('Escape')
  await check('document.activeElement.getAttribute("aria-label")', '打开边栏')
})

test('320px reflow and reduced motion preserve visible settings and controls', async () => {
  await viewport(320, 720, true)
  await cdp.call('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  await run('c2.openSettings("general")')
  await check('document.querySelectorAll("[role=dialog] select").length > 0')
  await check('document.documentElement.scrollWidth <= innerWidth')
  await check(
    '[...document.querySelectorAll("[role=dialog] select")].every(x => x.getBoundingClientRect().right <= innerWidth)'
  )
  await check(
    '[...document.querySelectorAll("[role=dialog] *")].every(x => getComputedStyle(x).animationName === "none")'
  )
  await run('c2.setThemePreference("dark")')
  await check('document.body.classList.contains("dark")')
  await key('Escape')
})

test('mobile sources panel isolates background and restores the invoking control', async () => {
  await viewport(320, 720, true)
  await wait('document.querySelector("[data-open-sidebar]")')
  await focus('textarea')
  await run('c2.sources()')
  await check('document.activeElement.textContent', '搜索结果')
  await check('document.querySelector("main").closest("[inert]") !== null')
  await key('Escape')
  await check('document.activeElement.tagName', 'TEXTAREA')
})

test('200% text keeps settings descriptions and controls within the scrolling panel', async () => {
  await viewport(320, 720, true)
  await run('c2.openSettings("general")')
  await scaleText()
  await check('document.documentElement.scrollWidth <= innerWidth')
  await check(
    `(()=>{const panel=document.querySelector('[role=tabpanel]');return [...panel.querySelectorAll('select')].every(select=>{const r=select.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})})()`
  )
  await check(
    `(()=>{const panel=document.querySelector('[role=tabpanel]');const descriptions=[...panel.querySelectorAll('[data-setting-description]')];return descriptions.length>=3 && descriptions.every(node=>node.getBoundingClientRect().width>=panel.clientWidth*0.7)})()`
  )
  observations.push({
    name: 'setting descriptions',
    count: await cdp.evaluate('document.querySelectorAll("[data-setting-description]").length'),
  })
  await key('Escape')
})

test('mobile backdrop accepts actual pointer clicks while the page stays inert', async () => {
  await viewport(412, 840, true)
  await wait('document.querySelector("[data-open-sidebar]")')
  await activate('[data-open-sidebar]')
  await check('document.querySelector("main").closest("[inert]") !== null')
  await screenshot('drawer-open')
  const point = await cdp.evaluate(
    `(()=>{const r=document.querySelector('[data-mobile-drawer-panel]').getBoundingClientRect();return{x:r.right+(innerWidth-r.right)/2,y:120}})()`
  )
  await click('[role=dialog]', point)
  await check('document.querySelectorAll("[role=dialog]").length', 0)
  await check('document.querySelector("main").closest("[inert]")', null)
  await check('document.activeElement.hasAttribute("data-open-sidebar")')
  observations.push({ name: 'backdrop click', point, closed: true })
})

test('long image filenames keep image, close and save visible at 200% in landscape', async () => {
  await viewport(864, 360, true)
  const name = 'W'.repeat(240) + '.png'
  await run(`c2.image(${JSON.stringify(name)})`)
  await wait('document.querySelector("[role=dialog] img")?.naturalWidth > 0')
  await screenshot('image-100')
  await scaleText()
  const geometry = await cdp.evaluate(`(()=>{
    const root=document.querySelector('[role=dialog]'),image=root.querySelector('img');
    const save=[...root.querySelectorAll('button')].find(node=>node.textContent.includes('保存'));
    const close=root.querySelector('button[aria-label="关闭"]');
    const name=root.querySelector('span[tabindex="0"]');
    const rect=node=>{const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}};
    return {image:rect(image),save:rect(save),close:rect(close),name:rect(name),fullName:name.textContent,label:root.getAttribute('aria-label'),scrollable:name.scrollHeight>name.clientHeight};
  })()`)
  assert.ok(geometry.image.height >= 80, 'image retains a usable stage')
  for (const rect of [geometry.save, geometry.close])
    assert.ok(rect.y >= 0 && rect.bottom <= 360, 'essential operation remains in viewport')
  assert.equal(geometry.fullName, name)
  assert.equal(geometry.label, name)
  assert.equal(geometry.scrollable, true, 'full filename remains scrollable')
  observations.push({ name: 'long image at 200%', geometry })
  await screenshot('image-200')
  await click('[aria-label="关闭"]')
})

test('selecting existing done/error/stopped branches never announces generation completion', async () => {
  await run('c2.historyBranches()')
  await check('document.querySelector("[data-reply-status]").textContent.trim()', '')
  for (const status of ['error', 'stopped', 'done']) {
    await run(`c2.selectHistory(${JSON.stringify(status)})`)
    await check('document.querySelector("[data-reply-status]").textContent.trim()', '')
  }
})

test('fast failures still announce errors for existing and newly created sessions', async () => {
  for (const newSession of [false, true]) {
    await run(`c2.fastFailure(${newSession})`)
    await wait('document.querySelector("[data-reply-status]").textContent.includes("回答失败")')
  }
})

test('coarse pointer modal footer buttons retain a 44px minimum hit height', async () => {
  await cdp.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await check('matchMedia("(pointer:coarse)").matches')
  await activate('#fixture-open')
  const geometry = await cdp.evaluate(
    `(()=>{const node=document.querySelector('#fixture-footer');return {height:node.getBoundingClientRect().height,minHeight:parseFloat(getComputedStyle(node).minHeight)}})()`
  )
  assert.ok(geometry.height >= 44 && geometry.minHeight >= 44)
})
