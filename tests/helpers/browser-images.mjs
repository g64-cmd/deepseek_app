// Only the browser image decoder/canvas boundary is simulated. Production resize/upload code runs unchanged.
export const installImageFixture = (document) => {
  const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image')
  const create = URL.createObjectURL
  const revoke = URL.revokeObjectURL
  const urls = new Map()
  const fixture = { decoded: [], drawn: [], canvases: [], decodeGate: null, failEncoding: false }
  URL.createObjectURL = (blob) => {
    const url = create(blob)
    urls.set(url, blob)
    return url
  }
  URL.revokeObjectURL = (url) => {
    urls.delete(url)
    revoke(url)
  }
  globalThis.Image = class {
    async decode() {
      const blob = urls.get(this.src)
      fixture.decoded.push(blob)
      if (fixture.decodeGate) await fixture.decodeGate
      const value = JSON.parse(await blob.text())
      if (value.invalid) throw new Error('Fixture cannot decode image')
      this.naturalWidth = value.width
      this.naturalHeight = value.height
    }
  }
  const oldCreateElement = document.createElement
  document.createElement = (name) => {
    if (name !== 'canvas') throw new Error(`Unexpected fixture element: ${name}`)
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: (...args) => fixture.drawn.push(args) }),
      toBlob(callback, type) {
        callback(
          fixture.failEncoding
            ? null
            : new Blob([JSON.stringify({ width: canvas.width, height: canvas.height })], { type })
        )
      },
    }
    fixture.canvases.push(canvas)
    return canvas
  }
  fixture.restore = () => {
    if (originalImage) Object.defineProperty(globalThis, 'Image', originalImage)
    else delete globalThis.Image
    URL.createObjectURL = create
    URL.revokeObjectURL = revoke
    if (oldCreateElement) document.createElement = oldCreateElement
    else delete document.createElement
    for (const url of urls.keys()) revoke(url)
  }
  return fixture
}

export const imageFile = (width, height, name = 'fixture.png', type = 'image/png') =>
  new File([JSON.stringify({ width, height })], name, { type, lastModified: 123 })
