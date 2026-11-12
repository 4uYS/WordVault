import { useEffect, useRef } from 'react'

const base = import.meta.env.BASE_URL

let indexPromise = null
let dictPromise = null
let indexWords = []
let indexMap = new Map()
let dictMap = new Map()

function normalize(word) {
  return String(word || '').trim().toLowerCase().replace(/’/g, "'")
}

// 单 HTML 构建会把词库内联到页面中的 JSON script 标签里。
function readEmbeddedJson(id) {
  if (typeof document === 'undefined') return null
  const node = document.getElementById(id)
  if (!node) return null
  try {
    return JSON.parse(node.textContent)
  } catch {
    return null
  }
}

async function fetchJson(path) {
  const res = await fetch(`${base}${path}`, { cache: 'force-cache' })
  if (!res.ok) throw new Error(`本地词库读取失败 (${res.status})`)
  return res.json()
}

export function loadIndex() {
  if (!indexPromise) {
    const embedded = readEmbeddedJson('wordvault-index')
    if (embedded) {
      indexWords = embedded.words || []
      indexMap = new Map(indexWords.map((w) => [normalize(w.w), w]))
      indexPromise = Promise.resolve({ words: indexWords, map: indexMap })
      return indexPromise
    }
    indexPromise = fetchJson('data/index.json')
      .then((data) => {
        indexWords = data.words || []
        indexMap = new Map(indexWords.map((w) => [normalize(w.w), w]))
        return { words: indexWords, map: indexMap }
      })
      .catch((err) => {
        indexPromise = null
        throw err
      })
  }
  return indexPromise
}

export function loadFullDictionary() {
  if (!dictPromise) {
    const embedded = readEmbeddedJson('wordvault-dictionary')
    if (embedded) {
      const words = embedded.words || []
      dictMap = new Map(words.map((w) => [normalize(w.w), w]))
      dictPromise = Promise.resolve({ words, map: dictMap, meta: embedded })
      return dictPromise
    }
    dictPromise = fetchJson('data/dictionary.json')
      .then((data) => {
        const words = data.words || []
        dictMap = new Map(words.map((w) => [normalize(w.w), w]))
        return { words, map: dictMap, meta: data }
      })
      .catch((err) => {
        dictPromise = null
        throw err
      })
  }
  return dictPromise
}

export function getIndexWords() {
  return indexWords
}

export function getIndexMap() {
  return indexMap
}

export function getDictMap() {
  return dictMap
}

export function lookupBasic(word) {
  return indexMap.get(normalize(word)) || null
}

export function lookupFull(word) {
  return dictMap.get(normalize(word)) || null
}

function subsequenceScore(word, query) {
  let i = 0
  let gaps = 0
  for (let j = 0; j < word.length && i < query.length; j++) {
    if (word[j] === query[i]) {
      if (j > i) gaps++
      i++
    }
  }
  if (i < query.length) return 0
  return Math.max(1, 220 - gaps * 8 - (word.length - query.length) * 2)
}

export function scoreWord(word, query) {
  const w = word.toLowerCase()
  const q = query.toLowerCase()
  if (w === q) return 1000
  if (w.startsWith(q)) return 850 - (w.length - q.length)
  const idx = w.indexOf(q)
  if (idx >= 0) return 700 - idx * 4 - (w.length - q.length)
  const sub = subsequenceScore(w, q)
  if (sub) return sub
  return 0
}

export function searchWords(query, limit = 40) {
  const q = String(query || '').trim()
  if (!q) return []
  const lower = q.toLowerCase()
  const isChinese = /[\u4e00-\u9fff]/.test(q)
  const scored = []
  for (const item of indexWords) {
    let score = scoreWord(item.w, q)
    if (isChinese) {
      const cn = item.c || ''
      if (cn.includes(q)) score = Math.max(score, cn.startsWith(q) ? 620 : 480)
    } else {
      const cn = item.c || ''
      if (cn.includes(q)) score = Math.max(score, 350)
    }
    if (score > 0) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score || a.item.w.length - b.item.w.length)
  return scored.slice(0, limit).map((x) => x.item)
}

export function suggestionsFor(bookId, count = 8) {
  const list = indexWords.filter((w) => w.b.includes(bookId))
  if (!list.length) return []
  const step = Math.max(1, Math.floor(list.length / count))
  return Array.from({ length: Math.min(count, list.length) }, (_, i) => list[(i * step) % list.length])
}

export function useDictionaryPrefetch(enabled) {
  const started = useRef(false)
  useEffect(() => {
    if (!enabled || started.current) return
    started.current = true
    const timer = window.setTimeout(() => {
      loadFullDictionary().catch(() => {})
    }, 1800)
    return () => window.clearTimeout(timer)
  }, [enabled])
}
