// prismjs 替身：记录高亮调用，语法对象始终存在
const { fixture } = require('./rich-gate.cjs')

const languages = new Proxy(
  {},
  {
    get: (target, name) => (typeof name === 'string' ? (target[name] ??= { name }) : undefined),
  }
)

// 直接重赋 module.exports：default 导入（import Prism from 'prismjs'）拿到本对象
module.exports = {
  languages,
  highlight(code, grammar, name) {
    fixture.highlightCalls.push(name)
    return `<highlighted:${name}>${code}`
  },
}
