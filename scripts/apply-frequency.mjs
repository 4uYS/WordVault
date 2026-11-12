#!/usr/bin/env node
/**
 * 用词频表给索引补充学习顺序（index.json 的 r 字段）。
 *
 * 用法：node scripts/apply-frequency.mjs [词频文件]
 * 默认读取 scripts/data/en_50k.txt（OpenSubtitles 语料，来源见 README）。
 *
 * 规则：
 *   r = 词频序号（越小越常用）
 *   r = 50000 + 书中顺序（词频表未收录，保持非字母序）
 *   r = 80000 + 书中顺序（基础虚词/语气词，放到最后）
 *
 * 只改 public/data/index.json，词条内容本身不动。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_PATH = path.join(ROOT, 'public', 'data', 'index.json')
const DICT_PATH = path.join(ROOT, 'public', 'data', 'dictionary.json')
const FREQ_PATH = process.argv[2] || path.join(ROOT, 'scripts', 'data', 'en_50k.txt')

const MISMATCH_BASE = 50000
const STOPWORD_BASE = 80000

// 基础虚词 + 语气词 + 缩写残片：不适合占学习队列前排
const SKIP_WORDS = new Set(
  (
    'a an the and or but if then than so as of at by for with about against between into through ' +
    'during before after above below to from up down in out on off over under again further once ' +
    'here there when where why how all any both each few more most other some such no nor not only ' +
    'own same too very can could may might must shall should will would do does did done have has ' +
    'had having be is are was were been being am i me my we our you your he him his she her it its ' +
    'they them their this that these those who whom which what whose ' +
    'oh ah eh hey yeah yep nope okay ok hi hello bye huh um uh hmm wow oops gosh ha haha gonna wanna ' +
    'gotta kinda sorta ain don didn doesn isn aren wasn weren haven hasn hadn won wouldn couldn ' +
    'shouldn mustn needn shan mightn ll ve re d m o y'
  ).split(/\s+/),
)

const normalize = (word) => String(word || '').trim().toLowerCase().replace(/’/g, "'")

function loadFrequency(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  const map = new Map()
  let index = 0
  for (const line of text.split(/\r?\n/)) {
    const word = normalize(line.split(' ')[0])
    if (!word) continue
    index += 1
    if (!map.has(word)) map.set(word, index)
  }
  return map
}

function main() {
  const frequency = loadFrequency(FREQ_PATH)
  const dictionary = JSON.parse(fs.readFileSync(DICT_PATH, 'utf8'))
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'))
  const words = dictionary.words || []
  const rankMap = new Map(words.map((entry) => [normalize(entry.w), Number(entry.rank) || 0]))

  let covered = 0
  let skipped = 0
  let fallback = 0

  const next = (index.words || []).map((item) => {
    const key = normalize(item.w)
    const bookRank = rankMap.get(key) || 0
    let r
    if (SKIP_WORDS.has(key)) {
      r = STOPWORD_BASE + bookRank
      skipped += 1
    } else if (frequency.has(key)) {
      r = frequency.get(key)
      covered += 1
    } else {
      r = MISMATCH_BASE + bookRank
      fallback += 1
    }
    return { ...item, r }
  })

  fs.writeFileSync(INDEX_PATH, JSON.stringify({ ...index, words: next }), 'utf8')

  console.log(`词频表：${frequency.size} 词`)
  console.log(`索引词条：${next.length}`)
  console.log(`  命中词频：${covered}`)
  console.log(`  未收录（按书中顺序兜底）：${fallback}`)
  console.log(`  基础词后置：${skipped}`)
  console.log(`索引大小：${(fs.statSync(INDEX_PATH).size / 1048576).toFixed(2)} MB`)
}

main()
