import { useEffect, useRef, useState } from 'react'
import { useApp } from '../AppContext'
import { useUI } from '../UIContext'
import { BOOK_MAP } from '../lib/constants'
import { speak } from '../lib/speech'
import { Icon } from '../components/Icons'

const MAX_SELECTION = 80

/** 去掉常见词尾，尽量把复数/时态/比较级还原成词典里的原形 */
function stemVariants(word) {
  const w = String(word || '').toLowerCase()
  const out = []
  const push = (value) => {
    if (!value || value.length < 2 || value === w || out.includes(value)) return
    out.push(value)
    // running -> runn -> run
    if (value.length > 2 && value[value.length - 1] === value[value.length - 2]) {
      const single = value.slice(0, -1)
      if (single.length >= 2 && !out.includes(single)) out.push(single)
    }
  }

  if (w.endsWith('ies')) push(`${w.slice(0, -3)}y`)
  if (w.endsWith('ves')) push(`${w.slice(0, -3)}f`)
  if (w.endsWith('es')) push(w.slice(0, -2))
  if (w.endsWith('s')) push(w.slice(0, -1))
  if (w.endsWith('ied')) push(`${w.slice(0, -3)}y`)
  if (w.endsWith('ed')) {
    push(w.slice(0, -2))
    push(w.slice(0, -1))
  }
  if (w.endsWith('ing')) {
    push(w.slice(0, -3))
    push(`${w.slice(0, -3)}e`)
  }
  if (w.endsWith('est')) push(w.slice(0, -3))
  if (w.endsWith('er')) push(w.slice(0, -2))
  if (w.endsWith('ly')) push(w.slice(0, -2))
  return out
}

/** 从选区里整理出候选单词，长词优先，并附带词形还原结果 */
function candidateWords(text) {
  const clean = String(text || '')
    .trim()
    .replace(/[.,;:!?"“”()[\]]/g, '')
  const tokens = /^[A-Za-z][A-Za-z'-]*$/.test(clean)
    ? [clean]
    : clean.match(/[A-Za-z][A-Za-z'-]{1,}/g) || []

  const list = []
  for (const token of tokens.sort((a, b) => b.length - a.length)) {
    for (const value of [token, ...stemVariants(token)]) {
      if (value && !list.includes(value)) list.push(value)
    }
  }
  return list
}

export default function SelectionPopup() {
  const { dict } = useApp()
  const { openWord } = useUI()
  const [popup, setPopup] = useState(null)
  const popupRef = useRef(null)
  const timerRef = useRef(null)

  useEffect(() => {
    if (!dict.indexReady) return undefined

    const trySelect = () => {
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        const selection = window.getSelection()
        if (!selection || selection.isCollapsed) return
        const text = selection.toString().trim()
        if (!text || text.length > MAX_SELECTION) {
          setPopup(null)
          return
        }
        const anchor = selection.anchorNode?.parentElement
        if (anchor?.closest('input, textarea, [contenteditable="true"], .word-detail, .selection-popup')) return

        const words = candidateWords(text)
        if (!words.length) {
          setPopup(null)
          return
        }

        // 先找收录词，优先使用原词，其次使用还原后的词形
        let found = null
        for (const word of words) {
          const basic = dict.lookupBasic(word)
          if (basic) {
            found = basic
            break
          }
        }

        const range = selection.getRangeAt(0)
        const rect = range.getBoundingClientRect()
        if (!rect || (!rect.width && !rect.height)) return

        const width = 312
        let left = rect.left + rect.width / 2
        left = Math.max(width / 2 + 10, Math.min(window.innerWidth - width / 2 - 10, left))
        let top = rect.bottom + 10
        if (top + 200 > window.innerHeight) top = Math.max(10, rect.top - 200)

        setPopup({
          basic: found,
          word: found?.w || words[0].toLowerCase(),
          left,
          top,
        })
      }, 120)
    }

    const clearOnEmpty = () => {
      window.setTimeout(() => {
        const selection = window.getSelection()
        if (!selection || selection.isCollapsed) setPopup(null)
      }, 80)
    }

    const outside = (event) => {
      if (popupRef.current && !popupRef.current.contains(event.target)) setPopup(null)
    }

    const scrollClose = () => setPopup(null)

    document.addEventListener('mouseup', trySelect)
    document.addEventListener('touchend', trySelect, { passive: true })
    document.addEventListener('keyup', trySelect)
    document.addEventListener('selectionchange', clearOnEmpty)
    document.addEventListener('mousedown', outside)
    document.addEventListener('touchstart', outside, { passive: true })
    window.addEventListener('scroll', scrollClose, true)
    window.addEventListener('resize', scrollClose)

    return () => {
      window.clearTimeout(timerRef.current)
      document.removeEventListener('mouseup', trySelect)
      document.removeEventListener('touchend', trySelect)
      document.removeEventListener('keyup', trySelect)
      document.removeEventListener('selectionchange', clearOnEmpty)
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('touchstart', outside)
      window.removeEventListener('scroll', scrollClose, true)
      window.removeEventListener('resize', scrollClose)
    }
  }, [dict, dict.indexReady])

  if (!popup) return null
  const { basic } = popup
  const book = basic?.b?.[0] ? BOOK_MAP[basic.b[0]] : null

  return (
    <div
      ref={popupRef}
      className="selection-popup"
      style={{ left: popup.left, top: popup.top }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="popup-head">
        <div>
          <strong>{basic?.w || popup.word}</strong>
          {basic?.uk && <span>/{basic.uk}/</span>}
        </div>
        {basic ? (
          <button type="button" className="icon-btn small" onClick={() => speak(basic.w)} aria-label="朗读单词">
            <Icon name="volumeSmall" size={18} />
          </button>
        ) : null}
      </div>
      <p className="popup-meaning">
        {basic ? (
          <>
            {basic.p && <i>{basic.p}</i>}
            {basic.c || '暂无释义'}
          </>
        ) : (
          '本地词库暂未收录这个单词，可以打开详情用 AI 解析。'
        )}
      </p>
      <div className="popup-foot">
        <span className="popup-source">
          <Icon name="lock" size={12} />
          {basic ? `本地词库${book ? ` · ${book.short}` : ''}` : '未收录'}
        </span>
        <button
          type="button"
          className="btn btn-text popup-open"
          onClick={() => {
            openWord(basic?.w || popup.word)
            setPopup(null)
          }}
        >
          {basic ? '查看详情' : 'AI 解析'}
          <Icon name="arrowRight" size={14} />
        </button>
      </div>
    </div>
  )
}
