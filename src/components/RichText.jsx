import { useEffect, useMemo, useRef } from 'react'
import { renderRich } from '../lib/richtext'

/**
 * 流式输出：逐字追加，每个字符带模糊淡入，形成“墨水晕开”的感觉。
 * 使用真实 DOM 追加，避免 React 重渲染导致动画反复重启。
 */
export function StreamingText({ text }) {
  const containerRef = useRef(null)
  const renderedRef = useRef(0)

  useEffect(() => {
    renderedRef.current = 0
    if (containerRef.current) containerRef.current.textContent = ''
  }, [])

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    if (text.length < renderedRef.current) {
      node.textContent = ''
      renderedRef.current = 0
    }
    const next = text.slice(renderedRef.current)
    if (!next) return
    const fragment = document.createDocumentFragment()
    Array.from(next).forEach((char, index) => {
      if (char === '\n') {
        fragment.appendChild(document.createElement('br'))
        return
      }
      const span = document.createElement('span')
      span.className = 'ink-char'
      span.style.animationDelay = `${Math.min(index * 12, 240)}ms`
      span.textContent = char
      fragment.appendChild(span)
    })
    node.appendChild(fragment)
    renderedRef.current = text.length
  }, [text])

  return <div className="ai-rich is-streaming" ref={containerRef} aria-live="polite" />
}

/** 生成完成后渲染 Markdown + LaTeX */
export function RichMarkdown({ text }) {
  const html = useMemo(() => renderRich(text), [text])
  return <div className="ai-rich" dangerouslySetInnerHTML={{ __html: html }} />
}
