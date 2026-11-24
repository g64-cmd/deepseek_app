// Lightweight DOM boundary for existing Node tests; browser regressions use real DOM/React.
class TestHTMLElement {
  children = []
  inert = false
  isConnected = true
  tabIndex = -1
  constructor() {}
  querySelectorAll() {
    return []
  }
  querySelector() {
    return null
  }
  contains(node) {
    return node === this
  }
  closest() {
    return null
  }
  focus() {
    globalThis.document.activeElement = this
  }
}
const attachRef = (type, props) => {
  if (typeof type === 'string' && props?.ref && typeof props.ref === 'object') {
    props.ref.current ??= new TestHTMLElement()
  }
  return { type, props: props ?? {} }
}
module.exports = { TestHTMLElement, attachRef }
