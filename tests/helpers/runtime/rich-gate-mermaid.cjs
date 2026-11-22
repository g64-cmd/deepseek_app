// mermaid 包替身：默认导出，render 可被 fixture.renderGate 挂起以控制调度顺序
const { fixture } = require('./rich-gate.cjs')

// 直接重赋 module.exports：动态 import().then(m => m.default) 拿到本对象
module.exports = {
  initialize(options) {
    fixture.initCalls.push(options.theme)
  },
  async render(id, code) {
    fixture.renderCalls.push({ id, code })
    if (fixture.renderGate) await fixture.renderGate
    if (fixture.failRenderFor.has(code)) throw new Error('Fixture mermaid failure')
    return { svg: `<svg data-id="${id}">${code}</svg>` }
  },
}
