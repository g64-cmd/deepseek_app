// Filesystem/Share 边界替身：以字节模拟目录与文件，生产缓存身份和清理逻辑保持真实。
const runtime = {
  files: new Map(),
  directories: new Set(),
  shared: [],
  failAppend: false,
  failDelete: new Set(),
  failRmdir: new Set(),
  failAllRmdir: false,
  pauseRead: null,
  shareError: null,
}
exports.runtime = runtime
exports.Directory = { Cache: 'CACHE' }
const missing = () =>
  Object.assign(new Error('Fixture missing file'), { code: 'OS-PLUG-FILE-0008' })
exports.Filesystem = {
  async mkdir({ path }) {
    const segments = path.split('/')
    while (segments.length) {
      runtime.directories.add(segments.join('/'))
      segments.pop()
    }
  },
  async writeFile({ path, data }) {
    runtime.files.set(path, Buffer.from(data, 'base64'))
    return { uri: `file:///cache/${path}` }
  },
  async appendFile({ path, data }) {
    if (runtime.failAppend) throw new Error('Fixture append failure')
    runtime.files.set(path, Buffer.concat([runtime.files.get(path), Buffer.from(data, 'base64')]))
  },
  async readdir({ path }) {
    const gate = runtime.pauseRead
    if (gate?.path === path) {
      gate.entered()
      await gate.wait
    }
    const prefix = path ? `${path}/` : ''
    const entries = new Map()
    for (const [paths, type] of [
      [runtime.directories, 'directory'],
      [runtime.files.keys(), 'file'],
    ]) {
      for (const entry of paths) {
        if (!entry.startsWith(prefix)) continue
        const relative = entry.slice(prefix.length)
        if (relative && !relative.includes('/')) entries.set(relative, { name: relative, type })
      }
    }
    return { files: [...entries.values()] }
  },
  async deleteFile({ path }) {
    if (runtime.failDelete.has(path)) throw new Error('Fixture delete failure')
    if (!runtime.files.delete(path)) throw missing()
  },
  async rmdir({ path, recursive }) {
    if (runtime.failAllRmdir || runtime.failRmdir.has(path))
      throw new Error('Fixture rmdir failure')
    if (!runtime.directories.has(path)) throw missing()
    if (!recursive) throw new Error('Fixture expected recursive directory removal')
    for (const file of runtime.files.keys()) {
      if (file.startsWith(`${path}/`)) runtime.files.delete(file)
    }
    for (const directory of runtime.directories) {
      if (directory === path || directory.startsWith(`${path}/`))
        runtime.directories.delete(directory)
    }
  },
}
exports.Share = {
  async share(options) {
    if (runtime.shareError) throw runtime.shareError
    runtime.shared.push(options)
    return {}
  },
}
