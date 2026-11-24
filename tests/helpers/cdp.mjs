/** Small CDP transport using Node 24's built-in WebSocket. */
export class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const pending = this.pending.get(message.id)
        if (!pending) {
          return
        }
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.error) {
          pending.reject(new Error(JSON.stringify(message.error)))
        } else {
          pending.resolve(message.result)
        }
      } else {
        for (const listener of this.listeners.get(message.method) ?? []) {
          listener(message.params)
        }
      }
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('CDP socket closed'))
      }
      this.pending.clear()
    })
  }
  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new Cdp(socket)
  }
  call(method, params = {}, timeoutMs = 240_000) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  once(method) {
    return new Promise((resolve) => {
      const listener = (params) => {
        this.listeners.get(method).delete(listener)
        resolve(params)
      }
      if (!this.listeners.has(method)) {
        this.listeners.set(method, new Set())
      }
      this.listeners.get(method).add(listener)
    })
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      )
    }
    return result.result.value
  }
  close() {
    this.socket.close()
  }
}
