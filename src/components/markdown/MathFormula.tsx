import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ensureKatex, type Katex } from '../../services/markdown/katex.js'
import { useRichGate } from '../messages/richGate.js'

/** renderToString 外层包裹的标签，组件自己渲染外层，这里切掉 */
const KATEX_WRAPPER = {
  inline: ['<span class="katex">', '</span>'],
  display: ['<span class="katex-display"><span class="katex">', '</span></span>'],
} as const

type MathHtmlResult = {
  html: string
  renderMode: 'katex' | 'fallback'
  pending?: boolean
}

const noop = () => {}

/** KaTeX 渲染公式；出错时保留上次成功的结果（流式中公式未写完），没有则展示原文 */
const useMathHtml = (input: string, isInline: boolean, enabled = true): MathHtmlResult => {
  const previousResultRef = useRef<MathHtmlResult | null>(null)
  const katexRef = useRef(ensureKatex())
  const [katex, setKatex] = useState<Katex | null>(
    katexRef.current instanceof Promise ? null : katexRef.current
  )

  useEffect(() => {
    if (katexRef.current instanceof Promise) {
      katexRef.current.then(setKatex, noop)
    }
  }, [])

  return useMemo((): MathHtmlResult => {
    if (!enabled) {
      // 屏外（未进入预取范围）不执行排版，保留可读 TeX 原文
      return { html: input, renderMode: 'fallback', pending: true }
    }
    if (!katex) {
      return { html: input, renderMode: 'fallback', pending: true }
    }
    try {
      const [prefix, suffix] = KATEX_WRAPPER[isInline ? 'inline' : 'display']
      const html = katex
        .renderToString(input, { throwOnError: true, strict: false, displayMode: !isInline })
        .slice(prefix.length, -suffix.length)
      const result = { html, renderMode: 'katex' } as const
      previousResultRef.current = result
      return result
    } catch {
      return previousResultRef.current ?? { html: input, renderMode: 'fallback' }
    }
  }, [input, isInline, katex, enabled])
}

/** 展示公式；已结束回答中屏外保留 TeX 原文，进入视口预取范围后再排版 */
export const MathBlock = memo(function MathBlock({
  value,
  loading = false,
}: {
  value: string
  loading?: boolean
}) {
  const gate = useRichGate(!loading)
  const { html, renderMode, pending } = useMathHtml(value, false, gate.active)
  if (renderMode === 'fallback') {
    return (
      <p
        ref={gate.setElement}
        className="ds-markdown-paragraph"
        data-rich-kind="math"
        data-rich-ready={pending ? 'false' : 'error'}
        onFocus={gate.activate}
      >
        {html}
      </p>
    )
  }
  return (
    <span className="katex-display ds-markdown-math" data-rich-kind="math" data-rich-ready="true">
      <span className="katex" dangerouslySetInnerHTML={{ __html: html }}></span>
    </span>
  )
})

export const InlineMath = memo(function InlineMath({ value }: { value: string }) {
  const { html, renderMode } = useMathHtml(value, true)
  if (renderMode === 'fallback') {
    return html
  }
  return <span className="katex" dangerouslySetInnerHTML={{ __html: html }}></span>
})
