#!/usr/bin/env node
/**
 * 把有道词书（kajweb/dict）合并进现有离线词库。
 *
 * 用法：node scripts/enrich-dict.mjs [词书 JSON 目录]
 * 默认目录为 /tmp/books，词书文件为 <BOOK>.json（JSONL，一行一个单词）。
 *
 * 原有的 9102 个词条会完整保留，只新增缺失的单词并把 bookId 并入已有词条。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_DIR = path.join(ROOT, 'public', 'data')
const SOURCE_DIR = process.argv[2] || '/tmp/books'

const NEW_BOOKS = [
  { id: 'tem8', name: '专八词汇', short: 'TEM-8', file: 'Level8luan_2.json' },
  { id: 'gre', name: 'GRE 词汇', short: 'GRE', file: 'GRE_2.json' },
  { id: 'sat', name: 'SAT 词汇', short: 'SAT', file: 'SAT_2.json' },
  { id: 'gmat', name: 'GMAT 词汇', short: 'GMAT', file: 'GMAT_2.json' },
  { id: 'tem4', name: '专四词汇', short: 'TEM-4', file: 'Level4luan_2.json' },
]

const MAX_EXAMPLES = 2
const MAX_PHRASES = 3
const MAX_SYNONYM_GROUPS = 3
const MAX_FAMILY_GROUPS = 3

const normalize = (word) => String(word || '').trim().toLowerCase().replace(/’/g, "'")

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function parseSource(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const entries = []
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim()
    if (!text) continue
    try {
      entries.push(JSON.parse(text))
    } catch {
      // 个别行损坏时跳过，不影响整本词书
    }
  }
  return entries
}

function buildEntry(record, bookId) {
  const word = cleanText(record.headWord)
  if (!word) return null
  const content = record?.content?.word?.content
  if (!content) return null

  const tr = (content.trans || [])
    .map((item) => ({
      p: cleanText(item.pos),
      c: cleanText(item.tranCn),
      e: cleanText(item.tranOther),
    }))
    .filter((item) => item.c)

  const ex = (content.sentence?.sentences || [])
    .map((item) => ({ en: cleanText(item.sContent), cn: cleanText(item.sCn) }))
    .filter((item) => item.en)
    .slice(0, MAX_EXAMPLES)

  const ph = (content.phrase?.phrases || [])
    .map((item) => ({ en: cleanText(item.pContent), cn: cleanText(item.pCn) }))
    .filter((item) => item.en)
    .slice(0, MAX_PHRASES)

  const syno = (content.syno?.synos || [])
    .map((item) => ({
      p: cleanText(item.pos),
      t: cleanText(item.tran),
      w: (item.hwds || []).map((h) => cleanText(h.w)).filter(Boolean),
    }))
    .filter((item) => item.w.length)
    .slice(0, MAX_SYNONYM_GROUPS)

  const syn = [...new Set(syno.flatMap((item) => item.w))].slice(0, 8)

  const fam = (content.relWord?.rels || [])
    .map((item) => ({
      p: cleanText(item.pos),
      words: (item.words || [])
        .map((h) => ({ w: cleanText(h.hwd), t: cleanText(h.tran) }))
        .filter((h) => h.w),
    }))
    .filter((item) => item.words.length)
    .slice(0, MAX_FAMILY_GROUPS)

  const ant = [...new Set((content.antos?.anto || []).map((item) => cleanText(item.hwd)).filter(Boolean))]

  return {
    w: word,
    uk: cleanText(content.ukphone || content.phone),
    us: cleanText(content.usphone || content.phone),
    tr,
    ex,
    ph,
    syn,
    syno,
    ant,
    fam,
    root: cleanText(content.remMethod?.val),
    exam: [],
    books: [bookId],
    rank: Number(record.wordRank) || 0,
    star: Number(content.star) || 0,
  }
}

function mergeEntry(target, source) {
  if (!target.uk && source.uk) target.uk = source.uk
  if (!target.us && source.us) target.us = source.us
  if (!target.tr?.length && source.tr?.length) target.tr = source.tr
  if (!target.ex?.length && source.ex?.length) target.ex = source.ex
  if (!target.ph?.length && source.ph?.length) target.ph = source.ph
  if (!target.syn?.length && source.syn?.length) target.syn = source.syn
  if (!target.syno?.length && source.syno?.length) target.syno = source.syno
  if (!target.fam?.length && source.fam?.length) target.fam = source.fam
  if (!target.ant?.length && source.ant?.length) target.ant = source.ant
  if (!target.root && source.root) target.root = source.root
  if (!target.rank && source.rank) target.rank = source.rank
  if (!target.star && source.star) target.star = source.star
}

function main() {
  const dictionaryPath = path.join(PUBLIC_DIR, 'dictionary.json')
  const indexFile = fs.readFileSync(dictionaryPath, 'utf8')
  const data = JSON.parse(indexFile)
  const existingWords = data.words || []
  const map = new Map(existingWords.map((entry) => [normalize(entry.w), entry]))

  let added = 0
  for (const book of NEW_BOOKS) {
    const file = path.join(SOURCE_DIR, book.file)
    if (!fs.existsSync(file)) {
      console.warn(`跳过 ${book.id}：未找到 ${file}`)
      continue
    }
    const records = parseSource(file)
    let bookAdded = 0
    for (const record of records) {
      const entry = buildEntry(record, book.id)
      if (!entry) continue
      const key = normalize(entry.w)
      const found = map.get(key)
      if (found) {
        if (!found.books.includes(book.id)) found.books.push(book.id)
        mergeEntry(found, entry)
        continue
      }
      map.set(key, entry)
      added += 1
      bookAdded += 1
    }
    console.log(`${book.id}：源 ${records.length} 条，新增 ${bookAdded} 条`)
  }

  const words = [...map.values()].sort((a, b) => (a.w.toLowerCase() < b.w.toLowerCase() ? -1 : a.w.toLowerCase() > b.w.toLowerCase() ? 1 : 0))

  const allBooks = [...(data.books || []), ...NEW_BOOKS.map(({ id, name, short }) => ({ id, name, short }))]
  const seenBook = new Set()
  const books = []
  for (const book of allBooks) {
    if (seenBook.has(book.id)) continue
    seenBook.add(book.id)
    const count = words.reduce((total, entry) => total + (entry.books?.includes(book.id) ? 1 : 0), 0)
    books.push({ id: book.id, name: book.name, short: book.short, count })
  }

  const output = {
    source: 'kajweb/dict (Youdao word books), trimmed for offline study use',
    generatedAt: new Date().toISOString().slice(0, 10),
    books,
    words,
  }

  const index = {
    words: words.map((entry) => ({
      w: entry.w,
      uk: entry.uk,
      us: entry.us,
      p: entry.tr?.[0]?.p || '',
      c: entry.tr?.[0]?.c || '',
      b: entry.books,
    })),
  }

  fs.writeFileSync(dictionaryPath, JSON.stringify(output), 'utf8')
  fs.writeFileSync(path.join(PUBLIC_DIR, 'index.json'), JSON.stringify(index), 'utf8')

  console.log(`合并完成：原有 ${existingWords.length} 词，新增 ${added} 词，共 ${words.length} 词`)
  console.log(books.map((book) => `${book.short} ${book.count}`).join(' · '))
}

main()
