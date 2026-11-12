import DOMPurify from 'dompurify'
import katex from 'katex'
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: true })

/**
 * 把 AI 输出渲染为安全的 HTML：
 * - Markdown（marked + DOMPurify）
 * - LaTeX：$$...$$、\[...\]、$...$、\(...\)，交给 KaTeX 渲染
 */
export function renderRich(text) {
  if (!text) return ''
  const maths = []
  const stash = (expr, display) => {
    maths.push({ expr, display })
    return `@@KATEX${maths.length - 1}@@`
  }

  const source = String(text)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => stash(expr, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => stash(expr, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => stash(expr, false))
    .replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_, prefix, expr) => `${prefix}${stash(expr, false)}`)

  let html = DOMPurify.sanitize(marked.parse(source))
  html = html.replace(/@@KATEX(\d+)@@/g, (_, index) => {
    const item = maths[Number(index)]
    if (!item) return ''
    try {
      return katex.renderToString(item.expr.trim(), {
        displayMode: item.display,
        throwOnError: false,
        strict: false,
        output: 'html',
      })
    } catch {
      return ''
    }
  })
  return html
}
