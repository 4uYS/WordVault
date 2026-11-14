import { useEffect, useRef } from 'react'

const base = import.meta.env.BASE_URL

let indexPromise = null
let dictPromise = null

// 随应用分发的原始词库（只读基线）
let baseIndexWords = []
let baseDictWords = []
// 合并自定义词条后的运行时视图
let indexWords = []
let indexMap = new Map()
let dictMap = new Map()
let dictMeta = null
// 本机自定义词条覆盖层：{ [小写词]: 标准词条对象 }
let customWords = {}

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

/** 把标准词条派生成 index.json 的轻量索引条目 */
function derivedIndexEntry(word, entry) {
  const tr = Array.isArray(entry?.tr) ? entry.tr.find((t) => t && t.c) || {} : {}
  return {
    w: word,
    uk: typeof entry.uk === 'string' ? entry.uk : '',
    us: typeof entry.us === 'string' ? entry.us : '',
    p: typeof tr.p === 'string' ? tr.p : '',
    c: typeof tr.c === 'string' ? tr.c : '',
    b: Array.isArray(entry.books) ? entry.books : [],
    r: 0,
    custom: true,
  }
}

function rebuildIndex() {
  const map = new Map(baseIndexWords.map((w) => [normalize(w.w), w]))
  for (const [word, entry] of Object.entries(customWords)) {
    if (entry && typeof entry === 'object') {
      map.set(normalize(word), derivedIndexEntry(word, entry))
    }
  }
  indexMap = map
  indexWords = Array.from(map.values())
}

function rebuildDict() {
  const map = new Map(baseDictWords.map((w) => [normalize(w.w), w]))
  for (const [word, entry] of Object.entries(customWords)) {
    if (entry && typeof entry === 'object') map.set(normalize(word), { ...entry, w: word })
  }
  dictMap = map
}

/**
 * 由 AppProvider 在每次渲染前同步本机自定义词条。
 * 传入对象引用未变化时不重算，避免无谓开销。
 */
export function setCustomWords(next) {
  const value = next && typeof next === 'object' && !Array.isArray(next) ? next : {}
  if (value === customWords) return
  customWords = value
  rebuildIndex()
  rebuildDict()
}

export function getCustomWords() {
  return customWords
}

export function isCustomWord(word) {
  return Object.prototype.hasOwnProperty.call(customWords, normalize(word))
}

export function dictionaryStats() {
  return {
    total: indexWords.length,
    builtin: baseIndexWords.length,
    custom: Object.keys(customWords).length,
    fullLoaded: baseDictWords.length > 0,
  }
}

export function loadIndex() {
  if (!indexPromise) {
    const embedded = readEmbeddedJson('wordvault-index')
    const pending = embedded ? Promise.resolve(embedded) : fetchJson('data/index.json')
    indexPromise = pending
      .then((data) => {
        baseIndexWords = data.words || []
        rebuildIndex()
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
    const pending = embedded ? Promise.resolve(embedded) : fetchJson('data/dictionary.json')
    dictPromise = pending
      .then((data) => {
        baseDictWords = data.words || []
        dictMeta = data
        rebuildDict()
        return { words: Array.from(dictMap.values()), map: dictMap, meta: data }
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

export function getDictMeta() {
  return dictMeta
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
