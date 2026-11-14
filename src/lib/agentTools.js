/**
 * AI Agent 能力层：把提示词里约定的 JSON 指令映射到项目真实的底层动作。
 * 提示词只负责「产出指令」，真正读写一律经这里校验后由宿主执行。
 */
import { BOOKS, BOOK_MAP, GOALS, LEVELS, AI_PROVIDERS, activeAiProvider } from './constants'
import {
  lookupFull, lookupBasic, searchWords, dictionaryStats, isCustomWord, getIndexWords,
} from './dict'
import { speakLong, stopSpeech } from './speech'
import {
  notifyNow, requestNotificationPermission, scheduleDailyReminder,
  cancelDailyReminder, isNativeApp, notificationStatus, nativePlatform,
} from './native'
import { downloadBackup } from './backup'
import { deleteCustomFont } from './fonts'
import {
  generate, buildQuizMessages, buildExampleMessages, buildExplainMessages, onlineSupported,
} from './llm'

export const RISK = { READ: 'L0', SOFT: 'L1', WRITE: 'L2', SENSITIVE: 'L3' }

const T = (risk, keys) => ({ risk, keys })
export const TOOL_REGISTRY = {
  // L0 只读
  'dict.lookup': T('L0', ['word']),
  'dict.search': T('L0', ['query', 'limit']),
  'dictionary.stats': T('L0', []),
  'stats.get': T('L0', []),
  'word.get': T('L0', ['word']),
  'word.list': T('L0', ['filter', 'limit']),
  'book.list': T('L0', []),
  'wrongbook.list': T('L0', ['limit']),
  'history.list': T('L0', ['limit']),
  'profile.get': T('L0', []),
  'settings.get': T('L0', []),
  'ai.provider.list': T('L0', []),
  'ai.entry.get': T('L0', ['word', 'mode']),
  'system.info': T('L0', []),
  'quiz.generate': T('L0', ['word', 'mode']),
  'example.generate': T('L0', ['word']),
  'explain.generate': T('L0', ['word']),
  // L1 轻交互
  'ui.navigate': T('L1', ['page']),
  'ui.openWord': T('L1', ['word']),
  'speech.speak': T('L1', ['text', 'accent', 'rate']),
  'speech.stop': T('L1', []),
  'theme.toggle': T('L1', []),
  'notification.test': T('L1', ['title', 'body']),
  'notification.request': T('L1', []),
  // L2 写
  'word.setStatus': T('L2', ['word', 'status']),
  'word.toggleFavorite': T('L2', ['word']),
  'word.answer': T('L2', ['word', 'quality', 'mode', 'isNew']),
  'word.batchStatus': T('L2', ['words', 'status']),
  'wrongbook.remove': T('L2', ['words']),
  'word.clearAiCache': T('L2', ['word', 'mode']),
  'search.clear': T('L2', []),
  'chat.clear': T('L2', []),
  'profile.update': T('L2', ['patch']),
  'settings.update': T('L2', ['patch']),
  'book.switch': T('L2', ['bookId']),
  'font.set': T('L2', ['font']),
  'font.remove': T('L2', []),
  'ai.provider.switch': T('L2', ['id']),
  'reminder.set': T('L2', ['hhmm', 'enabled', 'title', 'body']),
  'reminder.cancel': T('L2', []),
  'backup.export': T('L2', []),
  // L3 高敏
  'word.upsert': T('L3', ['word', 'entry']),
  'word.patch': T('L3', ['word', 'patch']),
  'word.removeCustom': T('L3', ['word']),
}

export function riskOf(action) {
  return TOOL_REGISTRY[action?.tool]?.risk || 'L2'
}

/* ---------------- 参数校验 ---------------- */

const BOOK_IDS = BOOKS.map((b) => b.id)
const STATUS = ['unknown', 'familiar', 'learning', 'known']
const THEMES = ['system', 'light', 'dark']
const FONTS = ['system', 'serif', 'mono', 'custom']
const ACCENTS = ['us', 'uk']
const ANSWER_MODES = ['flashcard', 'choice', 'listening', 'spelling', 'cloze', 'ai']
const QUIZ_MODES = ['choice', 'cloze']
const AI_MODES = ['example', 'explain']
const FILTERS = ['due', 'favorite', 'wrong', 'known', 'learning', 'all']
const PAGES = [
  'home', 'search', 'library', 'study', 'wrong', 'ai', 'profile',
  'practice/choice', 'practice/listening', 'practice/spelling', 'practice/cloze',
]
const PROFILE_KEYS = ['nickname', 'identities', 'goal', 'level', 'dailyNew', 'dailyReview', 'reminderTime', 'notify']
const SETTINGS_KEYS = ['bookId', 'theme', 'font', 'accent', 'autoSpeak', 'aiProviderId']
const ENTRY_PATCH_KEYS = ['uk', 'us', 'tr', 'ex', 'books']
const WORD_RE = /^[a-z][a-z' -]*$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export function normalizeWordKey(word) {
  return String(word || '').trim().toLowerCase().replace(/’/g, "'")
}

function checkWord(word) {
  const w = normalizeWordKey(word)
  if (!WORD_RE.test(w) || w.length > 64) return '单词格式不合法（仅小写字母、连字符、撇号、空格）'
  return ''
}

function patchError(patch, allowed) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return '缺少 patch 对象'
  for (const key of Object.keys(patch)) {
    if (!allowed.includes(key)) return `不允许修改字段 ${key}`
  }
  if (!Object.keys(patch).length) return 'patch 不能为空'
  return ''
}

function validateProfilePatch(patch) {
  const err = patchError(patch, PROFILE_KEYS)
  if (err) return err
  const p = patch
  if ('nickname' in p) {
    const n = String(p.nickname || '').trim()
    if (!n || n.length > 12 || /[<>\x00-\x1f]/.test(n)) return '昵称需为 1–12 字且不含标签或控制字符'
  }
  if ('goal' in p && !GOALS.some((g) => g.id === p.goal)) return 'goal 取值不合法'
  if ('level' in p && !LEVELS.some((l) => l.id === p.level)) return 'level 取值不合法'
  if ('identities' in p && (!Array.isArray(p.identities) || p.identities.some((x) => typeof x !== 'string'))) {
    return 'identities 必须是字符串数组'
  }
  if ('dailyNew' in p && (!Number.isInteger(p.dailyNew) || p.dailyNew < 1 || p.dailyNew > 200)) {
    return 'dailyNew 需为 1–200 的整数'
  }
  if ('dailyReview' in p && (!Number.isInteger(p.dailyReview) || p.dailyReview < 0 || p.dailyReview > 500)) {
    return 'dailyReview 需为 0–500 的整数'
  }
  if ('reminderTime' in p && !TIME_RE.test(String(p.reminderTime || ''))) return 'reminderTime 需为 HH:MM'
  if ('notify' in p && typeof p.notify !== 'boolean') return 'notify 需为布尔值'
  return ''
}

function validateSettingsPatch(patch) {
  const err = patchError(patch, SETTINGS_KEYS)
  if (err) return err
  const p = patch
  if ('bookId' in p && !BOOK_IDS.includes(p.bookId)) return 'bookId 取值不合法'
  if ('theme' in p && !THEMES.includes(p.theme)) return 'theme 取值不合法'
  if ('font' in p && !FONTS.includes(p.font)) return 'font 取值不合法'
  if ('accent' in p && !ACCENTS.includes(p.accent)) return 'accent 取值不合法'
  if ('autoSpeak' in p && typeof p.autoSpeak !== 'boolean') return 'autoSpeak 需为布尔值'
  if ('aiProviderId' in p && typeof p.aiProviderId !== 'string') return 'aiProviderId 需为字符串'
  return ''
}

const BOOK_NAME_TO_ID = new Map(
  BOOKS.flatMap((b) => [[b.name, b.id], [b.short.toLowerCase(), b.id], [b.id, b.id]]),
)

function str(value, max = 300) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/** 把模型五花八门的 tr 写法收敛成 dictionary.json 的 [{p,c,e}] */
export function normalizeTranslations(raw) {
  if (Array.isArray(raw)) {
    return raw.map((t) => {
      if (typeof t === 'string') return { p: '', c: t.trim().slice(0, 300), e: '' }
      if (!t || typeof t !== 'object') return null
      return {
        p: str(t.p ?? t.pos ?? t.part, 24),
        c: str(t.c ?? t.cn ?? t.meaning ?? t.def ?? t.definition, 300).trim(),
        e: str(t.e ?? t.en, 300),
      }
    }).filter((t) => t && t.c)
  }
  if (typeof raw === 'string' && raw.trim()) {
    return [{ p: '', c: raw.trim().slice(0, 300), e: '' }]
  }
  return []
}

/** 中文词书名、非法 id、缺失值统一收敛成合法词书 id 数组 */
export function normalizeBookIds(raw, fallback = 'cet4') {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  const mapped = list.map((b) => {
    const text = String(b || '').trim()
    const key = text.toLowerCase()
    if (BOOK_IDS.includes(key)) return key
    return BOOK_NAME_TO_ID.get(text) || BOOK_NAME_TO_ID.get(key) || ''
  }).filter(Boolean)
  const ids = mapped.length ? mapped : [BOOK_IDS.includes(fallback) ? fallback : 'cet4']
  return [...new Set(ids)].slice(0, 4)
}

/**
 * 补录词条归一化：模型常省略 w / 用 c,p 简写 / 把 books 写成中文名，
 * 这些不该导致整批指令被拦。宿主在这里补齐成标准结构，再由 reducer 二次清洗。
 */
export function normalizeUpsertEntry(word, raw, currentBookId = 'cet4') {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const w = normalizeWordKey(word)
  let tr = normalizeTranslations(src.tr)
  if (!tr.length) {
    const brief = src.c ?? src.cn ?? src.meaning ?? src.definition ?? src.gloss
    if (typeof brief === 'string' && brief.trim()) {
      tr = [{ p: str(src.p ?? src.pos, 24), c: brief.trim().slice(0, 300), e: '' }]
    }
  }
  const ex = Array.isArray(src.ex ?? src.examples)
    ? (src.ex ?? src.examples).filter((e) => e && typeof e === 'object').map((e) => ({
      en: str(e.en ?? e.e ?? e.text, 300),
      cn: str(e.cn ?? e.c ?? e.zh, 300),
    })).filter((e) => e.en)
    : []
  return {
    w,
    uk: str(src.uk ?? src.ukPhone, 80),
    us: str(src.us ?? src.usPhone, 80),
    tr,
    ex,
    ph: [], syn: [], syno: [], ant: [], fam: [], root: '', exam: [],
    books: normalizeBookIds(src.books ?? src.b ?? src.book, currentBookId),
    rank: 0,
    star: 0,
  }
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '缺少标准词条 entry'
  if (!Array.isArray(entry.tr) || !entry.tr.length) return '缺少释义（需要 tr 或 c）'
  if (entry.tr.some((t) => !t || typeof t.c !== 'string' || !t.c.trim())) return '每条释义的 c 不能为空'
  return ''
}

function validateArgs(tool, a) {
  if ('word' in a) {
    const err = checkWord(a.word)
    if (err) return err
  }
  if ('words' in a) {
    if (!Array.isArray(a.words) || !a.words.length || a.words.length > 20) return 'words 需为 1–20 个单词'
    for (const w of a.words) {
      const err = checkWord(w)
      if (err) return err
    }
  }
  if ('limit' in a && (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 40)) return 'limit 需为 1–40 的整数'
  if ('status' in a && !STATUS.includes(a.status)) return 'status 取值不合法'
  if ('quality' in a && (!Number.isInteger(a.quality) || a.quality < 0 || a.quality > 5)) return 'quality 需为 0–5 的整数'
  if ('filter' in a && !FILTERS.includes(a.filter)) return 'filter 取值不合法'
  if ('page' in a && !PAGES.includes(a.page)) return 'page 取值不合法'
  if ('bookId' in a && !BOOK_IDS.includes(a.bookId)) return 'bookId 取值不合法'
  if ('font' in a && !FONTS.includes(a.font)) return 'font 取值不合法'
  if ('hhmm' in a && !TIME_RE.test(String(a.hhmm || ''))) return 'hhmm 需为 24 小时制 HH:MM'
  if ('accent' in a && !ACCENTS.includes(a.accent)) return 'accent 取值不合法'
  if ('rate' in a && (typeof a.rate !== 'number' || a.rate < 0.5 || a.rate > 1.5)) return 'rate 需在 0.5–1.5'
  if ('mode' in a) {
    const allowed = tool === 'quiz.generate' ? QUIZ_MODES
      : tool === 'word.answer' ? ANSWER_MODES
        : AI_MODES
    if (!allowed.includes(a.mode)) return 'mode 取值不合法'
  }
  if (tool === 'speech.speak' && (!a.text || typeof a.text !== 'string' || a.text.length > 4000)) {
    return '朗读文本需为 1–4000 字符'
  }
  if (tool === 'notification.test') {
    if (!a.title || typeof a.title !== 'string') return '缺少通知标题'
    if ('body' in a && typeof a.body !== 'string') return '通知正文需为字符串'
  }
  if (tool === 'profile.update') return validateProfilePatch(a.patch)
  if (tool === 'settings.update') return validateSettingsPatch(a.patch)
  if (tool === 'word.patch') {
    const err = patchError(a.patch, ENTRY_PATCH_KEYS)
    if (err) return err
    if ('books' in a.patch && (!Array.isArray(a.patch.books) || a.patch.books.some((b) => !BOOK_IDS.includes(b)))) {
      return 'books 含非法词书 id'
    }
    if ('tr' in a.patch && (!Array.isArray(a.patch.tr) || !a.patch.tr.length)) return 'tr 至少需 1 条释义'
    return ''
  }
  if (tool === 'word.upsert') return validateEntry(a.entry)
  if (tool === 'ai.provider.switch' && (typeof a.id !== 'string' || !a.id)) return '缺少提供方 id'
  if ('query' in a && (!a.query || typeof a.query !== 'string' || a.query.length > 80)) return '搜索词需为 1–80 字符'
  return ''
}

/**
 * 整批校验。安全边界（工具白名单、参数键、枚举、批量上限）一律不放宽；
 * 但模型「措辞/字段写法」不达标时由宿主补齐，而不是整批拒绝导致确认卡片消失。
 */
export function validateActions(list, options = {}) {
  const fail = (error) => ({ ok: false, actions: [], error })
  if (!Array.isArray(list)) return fail('指令格式不正确')
  if (list.length > 5) return fail('一次最多 5 个操作')
  const currentBookId = options.currentBookId || 'cet4'
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') return fail('存在无效操作项')
    const def = TOOL_REGISTRY[item.tool]
    if (!def) return fail(`未知工具：${String(item.tool).slice(0, 40)}`)
    let args = item.args && typeof item.args === 'object' && !Array.isArray(item.args) ? item.args : {}
    for (const key of Object.keys(args)) {
      if (!def.keys.includes(key)) return fail(`${item.tool} 不接受参数 ${key}`)
    }

    // 补录词条：先归一化成标准结构，再校验。模型省略字段不再致命。
    if (item.tool === 'word.upsert') {
      args = { ...args, entry: normalizeUpsertEntry(args.word, args.entry, currentBookId) }
    }
    // 修正词条：books / tr 同样容忍简写
    if (item.tool === 'word.patch') {
      const patch = args.patch && typeof args.patch === 'object' ? { ...args.patch } : {}
      if ('books' in patch) patch.books = normalizeBookIds(patch.books, currentBookId)
      if ('tr' in patch) patch.tr = normalizeTranslations(patch.tr)
      args = { ...args, patch }
    }

    let confirm = typeof item.confirm === 'string' ? item.confirm.trim() : ''
    if (def.risk === 'L0' || def.risk === 'L1') {
      if (confirm) return fail(`${item.tool} 的 confirm 必须为空`)
    } else {
      if (confirm.length > 100) confirm = confirm.slice(0, 100)
      if (!confirm) {
        // 写操作必须让用户看见确认卡片；L3 由宿主生成兜底文案
        if (def.risk === 'L3') confirm = `将执行 ${item.tool}（此操作不可撤销，请确认）`
        else return fail(`${item.tool} 必须提供确认文案`)
      }
      // 免费小模型经常漏掉关键字。补齐文案而不是丢弃整批，安全语义仍然写在卡片上。
      if (def.risk === 'L3' && !/不可撤销|覆盖/.test(confirm)) {
        confirm = `${confirm.slice(0, 70)}（此操作不可撤销，请确认）`
      }
    }

    const err = validateArgs(item.tool, args)
    if (err) return fail(`${item.tool}：${err}`)
    const signature = `${item.tool}:${JSON.stringify(args)}`
    if (seen.has(signature)) return fail('检测到重复操作，已整批拦截')
    seen.add(signature)
    out.push({
      tool: item.tool,
      args,
      risk: def.risk,
      reason: String(item.reason || '').slice(0, 120),
      confirm,
    })
  }
  return { ok: true, actions: out, error: '' }
}

/* ---------------- 上下文注入（脱敏） ---------------- */

export function buildContextBlock(state, stats, dict) {
  const s = state.settings || {}
  const p = state.profile || {}
  const active = activeAiProvider(s)
  const lines = [
    'page: ai',
    `nickname: ${p.nickname || ''}`,
    `currentBookId: ${s.bookId || 'cet4'}`,
    `currentBookName: ${BOOK_MAP[s.bookId]?.name || '四级词汇'}`,
    `validBookIds: ${BOOK_IDS.join(', ')}`,
    `theme: ${s.theme || 'system'}`,
    `accent: ${s.accent || 'us'}`,
    `font: ${s.font || 'system'}`,
    `aiProviderId: ${active?.id || ''}`,
    `aiProviderName: ${active?.name || ''}`,
    `native: ${isNativeApp()}`,
    `notification: ${notificationStatus()}`,
    `dictReady: ${Boolean(dict?.indexReady)}`,
    `customWordCount: ${Object.keys(state.customWords || {}).length}`,
    `todayNew: ${stats?.todayActivity?.newWords ?? 0}`,
    `todayReview: ${stats?.todayActivity?.reviewWords ?? 0}`,
    `dueCount: ${stats?.dueCount ?? 0}`,
    `masteredCount: ${stats?.masteredCount ?? 0}`,
    `wrongCount: ${stats?.wrongCount ?? 0}`,
    `streak: ${stats?.streak ?? 0}`,
  ]
  return `[上下文]\n${lines.join('\n')}\n[/上下文]\n\n`
}

export function buildLookupContextBlock(word, state, dict) {
  const s = state.settings || {}
  const w = normalizeWordKey(word)
  const found = Boolean(lookupBasic(w))
  const lines = [
    `query: ${w}`,
    `normalized: ${w}`,
    `currentBookId: ${s.bookId || 'cet4'}`,
    `currentBookName: ${BOOK_MAP[s.bookId]?.name || '四级词汇'}`,
    `validBookIds: ${BOOK_IDS.join(', ')}`,
    `found: ${found}`,
    `userConfirmed: true`,
    `reason: ${found ? '本地词库已收录' : 'index 与 dictionary 均无匹配（含常见词形还原后仍无）'}`,
  ]
  return `[上下文]\n${lines.join('\n')}\n[/上下文]\n\n`
}

/* ---------------- 执行器 ---------------- */

function brief(value) {
  try {
    const text = JSON.stringify(value)
    return text.length > 700 ? `${text.slice(0, 700)}…` : text
  } catch {
    return String(value)
  }
}

async function ensureFull(ctx) {
  if (ctx.dict?.fullReady) return
  try {
    await ctx.dict?.ensureFullDict?.()
  } catch {
    // 词库未就绪时降级到索引条目
  }
}

function entryForAi(word) {
  const full = lookupFull(word)
  if (full) return full
  const basic = lookupBasic(word)
  if (!basic) return null
  return {
    w: basic.w,
    tr: basic.c ? [{ p: basic.p || '', c: basic.c, e: '' }] : [],
    ex: [],
  }
}

async function generateFor(tool, args, ctx) {
  await ensureFull(ctx)
  const entry = entryForAi(args.word)
  if (!entry) return '词库中无此词，无法生成'
  const messages = tool === 'quiz.generate' ? buildQuizMessages(entry, args.mode || 'choice')
    : tool === 'example.generate' ? buildExampleMessages(entry)
      : buildExplainMessages(entry)
  const output = await generate({
    messages,
    maxTokens: 400,
    temperature: 0.6,
    base: ctx.provider?.base,
    model: ctx.provider?.model,
    apiKey: ctx.provider?.key,
  })
  return output.slice(0, 700)
}

async function runOne(action, ctx) {
  const { tool, args } = action
  const { state, dispatch, stats, dict, ui } = ctx
  const d = (type, payload) => dispatch({ type, ...payload })

  switch (tool) {
    /* L0 */
    case 'dict.lookup': {
      await ensureFull(ctx)
      const e = lookupFull(args.word)
      if (!e) return brief({ found: false, word: args.word })
      return brief({
        found: true, word: e.w, uk: e.uk, us: e.us,
        tr: (e.tr || []).slice(0, 5), books: e.books || [], custom: Boolean(e.custom),
      })
    }
    case 'dict.search':
      return brief(searchWords(args.query, args.limit || 10).map((w) => ({ w: w.w, c: w.c, b: w.b })))
    case 'dictionary.stats':
      return brief({ ...dictionaryStats(), indexWords: getIndexWords().length })
    case 'stats.get':
      return brief({
        today: stats?.todayActivity || {},
        dueCount: stats?.dueCount ?? 0,
        masteredCount: stats?.masteredCount ?? 0,
        wrongCount: stats?.wrongCount ?? 0,
        streak: stats?.streak ?? 0,
        studyDays: stats?.studyDays ?? 0,
        currentBook: stats?.currentBook?.name || '',
      })
    case 'word.get':
      return brief({ word: args.word, record: state.wordStates?.[args.word] || null })
    case 'word.list': {
      const now = Date.now()
      const filter = args.filter || 'all'
      const rows = Object.entries(state.wordStates || {}).filter(([, r]) => {
        if (filter === 'due') return r.due && r.due <= now
        if (filter === 'favorite') return r.favorite
        if (filter === 'wrong') return r.wrongFlag
        if (filter === 'known') return r.status === 'known'
        if (filter === 'learning') return r.status === 'learning'
        return true
      })
      return brief(rows.slice(0, args.limit || 20).map(([word, r]) => ({
        word, status: r.status, favorite: Boolean(r.favorite), wrongCount: r.wrongCount,
      })))
    }
    case 'book.list':
      return brief({ currentBookId: state.settings?.bookId, books: BOOKS.map((b) => ({ id: b.id, name: b.name, short: b.short })) })
    case 'wrongbook.list':
      return brief(Object.entries(state.wordStates || {}).filter(([, r]) => r.wrongFlag)
        .slice(0, args.limit || 20).map(([word, r]) => ({ word, wrongCount: r.wrongCount, status: r.status })))
    case 'history.list':
      return brief((state.searches || []).slice(0, args.limit || 15).map((s) => s.term))
    case 'profile.get': {
      const p = state.profile || {}
      return brief({
        nickname: p.nickname, goal: p.goal, level: p.level, identities: p.identities,
        dailyNew: p.dailyNew, dailyReview: p.dailyReview, reminderTime: p.reminderTime, notify: p.notify,
      })
    }
    case 'settings.get': {
      const s = state.settings || {}
      return brief({
        bookId: s.bookId, theme: s.theme, font: s.font, accent: s.accent,
        autoSpeak: s.autoSpeak, aiProviderId: s.aiProviderId,
      })
    }
    case 'ai.provider.list':
      return brief((state.settings?.aiProviders?.length ? state.settings.aiProviders : AI_PROVIDERS)
        .map((p) => ({ id: p.id, name: p.name, model: p.model, hasKey: Boolean(p.key) })))
    case 'ai.entry.get': {
      const record = state.ai?.entries?.[args.word]
      return brief(record ? (args.mode ? { mode: args.mode, ...(record[args.mode] || {}) } : record) : null)
    }
    case 'system.info':
      return brief({
        native: isNativeApp(), platform: nativePlatform(), notification: notificationStatus(),
        dictIndexReady: Boolean(dict?.indexReady), dictFullReady: Boolean(dict?.fullReady),
        onlineAi: onlineSupported(),
      })
    case 'quiz.generate':
    case 'example.generate':
    case 'explain.generate':
      return await generateFor(tool, args, ctx)

    /* L1 */
    case 'ui.navigate':
      ui?.navigate?.(args.page)
      return `已跳转到 ${args.page}`
    case 'ui.openWord':
      ui?.openWord?.(args.word)
      return `已打开 ${args.word} 详情`
    case 'speech.speak': {
      const count = speakLong(args.text, args.accent || state.settings?.accent || 'us', args.rate ?? 0.88)
      return count > 1 ? `已开始朗读（自动分成 ${count} 段依次播放）` : '已开始朗读'
    }
    case 'speech.stop':
      stopSpeech()
      return '已停止朗读'
    case 'theme.toggle': {
      const current = state.settings?.theme || 'system'
      const effective = current === 'system'
        ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : current
      const next = effective === 'dark' ? 'light' : 'dark'
      d('UPDATE_SETTINGS', { patch: { theme: next } })
      return `已切换到${next === 'dark' ? '深色' : '浅色'}主题`
    }
    case 'notification.test': {
      const ok = notifyNow(args.title, args.body || '')
      if (!ok) ui?.showToast?.(`${args.title}：${args.body || ''}`)
      return ok ? '系统通知已发送' : '当前环境不支持系统通知，已改用应用内提示'
    }
    case 'notification.request':
      requestNotificationPermission()
      return '已请求通知权限'

    /* L2 */
    case 'word.setStatus':
      d('SET_STATUS', { word: args.word, status: args.status })
      return `已将 ${args.word} 标记为 ${args.status}`
    case 'word.toggleFavorite':
      d('TOGGLE_FAVORITE', { word: args.word })
      return `已切换 ${args.word} 的收藏状态`
    case 'word.answer':
      d('ANSWER_WORD', {
        word: args.word, quality: args.quality, mode: args.mode || 'ai', isNew: Boolean(args.isNew),
      })
      return `已记录 ${args.word} 的一次评分 ${args.quality}`
    case 'word.batchStatus':
      for (const word of args.words) d('SET_STATUS', { word, status: args.status })
      return `已将 ${args.words.length} 个词标记为 ${args.status}`
    case 'wrongbook.remove':
      for (const word of args.words) d('SET_STATUS', { word, status: 'known' })
      return `已将 ${args.words.length} 个词移出错词本`
    case 'word.clearAiCache': {
      const modes = args.mode ? [args.mode] : ['example', 'explain']
      for (const mode of modes) d('AI_CLEAR_ENTRY', { word: args.word, mode })
      return `已清除 ${args.word} 的 AI 缓存（${modes.join('、')}）`
    }
    case 'search.clear':
      d('CLEAR_SEARCH', {})
      return '已清空搜索历史'
    case 'chat.clear':
      d('AI_CLEAR_CHAT', {})
      return '已清空 AI 对话记录'
    case 'profile.update':
      d('UPDATE_PROFILE', { patch: args.patch })
      return `已更新个人资料：${Object.keys(args.patch).join('、')}`
    case 'settings.update':
      d('UPDATE_SETTINGS', { patch: args.patch })
      return `已更新设置：${Object.keys(args.patch).join('、')}`
    case 'book.switch':
      d('UPDATE_SETTINGS', { patch: { bookId: args.bookId } })
      return `已切换到${BOOK_MAP[args.bookId]?.name || args.bookId}`
    case 'font.set':
      d('UPDATE_SETTINGS', { patch: { font: args.font } })
      return `已切换字体为 ${args.font}`
    case 'font.remove':
      await deleteCustomFont()
      d('UPDATE_SETTINGS', { patch: { font: 'system', customFontName: '' } })
      return '已移除自定义字体并恢复系统字体'
    case 'ai.provider.switch':
      d('UPDATE_SETTINGS', { patch: { aiProviderId: args.id } })
      return `已切换 AI 提供方为 ${args.id}`
    case 'reminder.set': {
      const hhmm = args.hhmm
      d('UPDATE_PROFILE', { patch: { reminderTime: hhmm, notify: args.enabled !== false } })
      scheduleDailyReminder(hhmm, args.title || 'WordVault 每日学习提醒', args.body || '该复习今天的单词了。')
      return `已设置每日 ${hhmm} 提醒`
    }
    case 'reminder.cancel':
      cancelDailyReminder()
      d('UPDATE_PROFILE', { patch: { notify: false } })
      return '已取消每日提醒'
    case 'backup.export': {
      const mode = downloadBackup(state)
      return mode === 'native' ? '已调起系统分享面板导出备份' : '已生成备份文件并开始下载'
    }

    /* L3 */
    case 'word.upsert': {
      // 已收录的词：不覆盖原释义，只把新词书合并进覆盖层，
      // 这样「把它加入考研词书」这类请求也能真正生效。
      if (lookupBasic(args.word) && !isCustomWord(args.word)) {
        const current = lookupFull(args.word) || lookupBasic(args.word)
        const base = current?.tr ? current : {
          w: args.word,
          uk: current?.uk || '', us: current?.us || '',
          tr: current?.c ? [{ p: current.p || '', c: current.c, e: '' }] : [],
          ex: [], books: current?.b || [],
        }
        const merged = [...new Set([...(base.books || base.b || []), ...(args.entry.books || [])])]
        const books = normalizeBookIds(merged, state.settings?.bookId)
        d('CUSTOM_WORD_PATCH', { word: args.word, patch: { books }, base })
        return `「${args.word}」已在内置词库，已加入 ${books.map((b) => BOOK_MAP[b]?.name || b).join('、')}（原释义未改动）`
      }
      d('CUSTOM_WORD_UPSERT', { word: args.word, entry: args.entry })
      const names = (args.entry.books || []).map((b) => BOOK_MAP[b]?.name || b).join('、')
      return `已把 ${args.word} 加入${names || '当前词书'}，现在可离线查到`
    }
    case 'word.patch': {
      const current = lookupFull(args.word) || lookupBasic(args.word)
      if (!current) throw new Error('本地词库中找不到该词，请改用补录')
      const base = current.tr ? current : {
        w: args.word,
        uk: current.uk || '', us: current.us || '',
        tr: current.c ? [{ p: current.p || '', c: current.c, e: '' }] : [],
        ex: [], books: current.b || current.books || [],
      }
      d('CUSTOM_WORD_PATCH', { word: args.word, patch: args.patch, base })
      return `已覆盖 ${args.word} 的本地释义（${Object.keys(args.patch).join('、')}）`
    }
    case 'word.removeCustom': {
      if (!isCustomWord(args.word)) throw new Error('该词不是本机自建词条，内置词条不可删除')
      d('CUSTOM_WORD_REMOVE', { word: args.word })
      return `已删除自建词条 ${args.word}`
    }
    default:
      throw new Error('未实现的工具')
  }
}

/**
 * 模型常把长文拆成多个连续的 speech.speak。底层 speak() 每次都会 cancel，
 * 逐个执行会互相打断；这里先合并成一次长文朗读，由 speakLong 统一分片排队。
 */
function mergeSpeechRuns(actions) {
  const out = []
  for (const action of actions) {
    const prev = out[out.length - 1]
    if (action.tool === 'speech.speak' && prev?.tool === 'speech.speak' && prev.risk === 'L1') {
      prev.args = {
        ...prev.args,
        text: `${prev.args.text}\n${action.args.text}`,
      }
      continue
    }
    out.push({ ...action, args: { ...action.args } })
  }
  return out
}

/** 顺序执行，单项失败不影响其余动作；返回可回灌给 AI 的文本结果 */
export async function executeTools(actions, ctx) {
  const results = []
  const errors = []
  for (const action of mergeSpeechRuns(actions)) {
    try {
      results.push(`${action.tool}: ${await runOne(action, ctx)}`)
    } catch (error) {
      const message = error?.message || '执行失败'
      errors.push(`${action.tool}: ${message}`)
      results.push(`${action.tool}: 失败（${message}）`)
    }
  }
  return { results, errors }
}
