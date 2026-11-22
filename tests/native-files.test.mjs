import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { compile, root } from './helpers/compile.mjs'

let api
const storage = new Map()
let storageUnavailable = false
const REGISTRY = 'chat-demo:export-cache'
const globals = new Map(
  ['localStorage', 'FileReader'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ])
)

before(async () => {
  globalThis.localStorage = {
    getItem(key) {
      if (storageUnavailable) throw new Error('Fixture unavailable storage')
      return storage.get(key) ?? null
    },
    setItem(key, value) {
      if (storageUnavailable) throw new Error('Fixture unavailable storage')
      storage.set(key, String(value))
    },
  }
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(
        (bytes) => {
          this.result = `data:;base64,${Buffer.from(bytes).toString('base64')}`
          this.onload()
        },
        (error) => {
          this.error = error
          this.onerror()
        }
      )
    }
  }
  const runtime = path.join(root, 'tests/helpers/runtime/native-files.cjs')
  api = await compile(
    './tests/helpers/entries/native-files.ts',
    'native-cache',
    new Map([
      ['@capacitor/filesystem', runtime],
      ['@capacitor/share', runtime],
    ])
  )
})

beforeEach(() => {
  storage.clear()
  storageUnavailable = false
  api.runtime.files.clear()
  api.runtime.directories.clear()
  api.runtime.shared.length = 0
  api.runtime.failAppend = false
  api.runtime.failDelete.clear()
  api.runtime.failRmdir.clear()
  api.runtime.failAllRmdir = false
  api.runtime.pauseRead = null
  api.runtime.shareError = null
})

after(() => {
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

const sharePath = (index = 0) => api.runtime.shared[index].url.slice('file:///cache/'.length)
const registry = () => JSON.parse(storage.get(REGISTRY) ?? '[]')
const oldDirectory = (id, name = 'image.png') => {
  const directory = `whalechat-share/${id}`
  api.runtime.directories.add('whalechat-share')
  api.runtime.directories.add(directory)
  api.runtime.files.set(`${directory}/${name}`, Buffer.from('old contents'))
  return directory
}

test('same-name shares retain independent bytes and preserve the displayed filename', async () => {
  await api.nativePlatform.saveOrShareFile('image.png', new Blob(['first image']))
  await api.nativePlatform.saveOrShareFile('image.png', new Blob(['second image']))
  assert.notEqual(sharePath(0), sharePath(1))
  assert.equal(api.runtime.files.get(sharePath(0)).toString(), 'first image')
  assert.equal(api.runtime.files.get(sharePath(1)).toString(), 'second image')
  assert.match(sharePath(), /^whalechat-share\/[a-zA-Z0-9-]+\/image\.png$/)
  assert.equal(api.runtime.shared[0].title, 'image.png')
})

test('concurrent shares keep every independent cache object in the registry', async () => {
  await Promise.all(
    ['A', 'B', 'C'].map((body) => api.nativePlatform.saveOrShareFile('same.zip', new Blob([body])))
  )
  assert.equal(new Set(api.runtime.shared.map((item) => item.url)).size, 3)
  assert.equal(registry().length, 3)
  assert.deepEqual(
    new Set([...api.runtime.files.values()].map((bytes) => bytes.toString())),
    new Set(['A', 'B', 'C'])
  )
})

test('an attachment filename cannot escape its unique cache directory', async () => {
  await api.nativePlatform.saveOrShareFile('../../outside\\image.png', new Blob(['safe']))
  assert.match(sharePath(), /^whalechat-share\/[a-zA-Z0-9-]+\/image\.png$/)
  assert.equal(api.runtime.files.has('outside/image.png'), false)
})

test('failed chunked writes immediately remove partial bytes and their registry entry', async () => {
  api.runtime.failAppend = true
  await assert.rejects(
    api.nativePlatform.saveOrShareFile(
      'large-image.png',
      new Blob([new Uint8Array(9 * 1024 * 1024)])
    ),
    /Fixture append failure/
  )
  assert.equal(api.runtime.files.size, 0)
  assert.deepEqual(registry(), [])
  assert.equal(api.runtime.shared.length, 0)
})

test('a partial write whose immediate removal fails remains registered until a later cleanup succeeds', async () => {
  api.runtime.failAppend = true
  api.runtime.failAllRmdir = true
  await assert.rejects(
    api.nativePlatform.saveOrShareFile('large.png', new Blob([new Uint8Array(9 * 1024 * 1024)])),
    /Fixture append failure/
  )
  assert.equal(api.runtime.files.size, 1)
  assert.equal([...api.runtime.files.values()][0].length, 4 * 1024 * 1024)
  assert.equal(registry().length, 1)
  await api.cleanupExportCache()
  assert.equal(registry().length, 1)
  api.runtime.failAllRmdir = false
  await api.cleanupExportCache()
  assert.equal(api.runtime.files.size, 0)
  assert.deepEqual(registry(), [])
})

test('successful chunked writing preserves every original byte in sequence', async () => {
  const bytes = new Uint8Array(9 * 1024 * 1024 + 17)
  bytes.fill(11, 0, 4 * 1024 * 1024)
  bytes.fill(22, 4 * 1024 * 1024, 8 * 1024 * 1024)
  bytes.fill(33, 8 * 1024 * 1024)
  await api.nativePlatform.saveOrShareFile('large.png', new Blob([bytes]))
  assert.deepEqual(api.runtime.files.get(sharePath()), Buffer.from(bytes))
})

test('failed deletion of old registered files remains retryable', async () => {
  api.runtime.files.set('viewer-test.png', Buffer.from('old'))
  storage.set(REGISTRY, JSON.stringify(['viewer-test.png']))
  api.runtime.failDelete.add('viewer-test.png')
  await api.cleanupExportCache()
  assert.equal(api.runtime.files.has('viewer-test.png'), true)
  assert.deepEqual(registry(), ['viewer-test.png'])
  api.runtime.failDelete.clear()
  await api.cleanupExportCache()
  assert.equal(api.runtime.files.has('viewer-test.png'), false)
  assert.deepEqual(registry(), [])
})

test('cleanup covers legacy registry and backup prefixes while keeping unrelated cache files', async () => {
  for (const name of [
    'viewer-test.png',
    'whalechat-backup-old.zip',
    'deepseek_data-old.zip',
    'other-file.txt',
  ]) {
    api.runtime.files.set(name, Buffer.from(name))
  }
  storage.set(REGISTRY, JSON.stringify(['viewer-test.png', 'already-gone.png', '../outside']))
  await api.cleanupExportCache()
  assert.deepEqual([...api.runtime.files.keys()], ['other-file.txt'])
  assert.deepEqual(registry(), [])
})

test('the private directory fallback cleans old shares with damaged or unavailable registry storage', async () => {
  for (const unavailable of [false, true]) {
    oldDirectory(unavailable ? 'storage-unavailable' : 'damaged-registry')
    storage.set(REGISTRY, '{ broken')
    storageUnavailable = unavailable
    await api.cleanupExportCache()
    assert.equal(api.runtime.files.size, 0)
  }
})

test('failed deletion of an unregistered private directory is registered for retry', async () => {
  const directory = oldDirectory('retry-directory')
  api.runtime.failRmdir.add(directory)
  await api.cleanupExportCache()
  assert.deepEqual(registry(), [directory])
  api.runtime.failRmdir.clear()
  await api.cleanupExportCache()
  assert.equal(api.runtime.files.size, 0)
  assert.deepEqual(registry(), [])
})

test('startup cleanup cannot delete a share created while its directory scan is pending', async () => {
  const directory = oldDirectory('previous-process')
  storage.set(REGISTRY, JSON.stringify([directory]))
  let release
  let entered
  const reached = new Promise((resolve) => {
    entered = resolve
  })
  api.runtime.pauseRead = {
    path: '',
    entered,
    wait: new Promise((resolve) => {
      release = resolve
    }),
  }
  const cleanup = api.cleanupExportCache()
  await reached
  await api.nativePlatform.saveOrShareFile('current.png', new Blob(['current bytes']))
  const currentDirectory = registry().find((entry) => entry !== directory)
  release()
  await cleanup
  assert.equal(api.runtime.files.get(sharePath()).toString(), 'current bytes')
  assert.deepEqual(registry(), [currentDirectory])
  assert.equal(api.runtime.directories.has(directory), false)
})

test('cancelling the share sheet keeps the file available for recipients', async () => {
  api.runtime.shareError = new Error('Share canceled')
  assert.deepEqual(await api.nativePlatform.saveOrShareFile('image.png', new Blob(['contents'])), {
    ok: false,
    cancelled: true,
  })
  assert.equal(api.runtime.files.size, 1)
  await api.cleanupExportCache()
  assert.equal(api.runtime.files.size, 1)
})
