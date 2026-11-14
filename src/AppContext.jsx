import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { AI_PROVIDERS, BOOKS, BOOK_MAP, FONT_OPTIONS, GOALS, LEVELS, DEFAULT_DAILY_REVIEW } from './lib/constants'
import { dateKey, todayKey, computeStreak, activeDays } from './lib/date'
import { schedule } from './lib/sm2'
import { loadIndex, loadFullDictionary, getIndexWords, lookupBasic, setCustomWords } from './lib/dict'
import { applyCustomFont, setAppFont } from './lib/fonts'

const STORAGE_KEY = 'wordvault.state.v1'
const APP_FONT_FALLBACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif'

const defaultSettings = () => ({
  theme: 'system',
  font: 'system',
  customFontName: '',
  bookId: 'cet4',
  accent: 'us',
  autoSpeak: false,
  aiProviderId: 'llm7',
  aiProviders: AI_PROVIDERS.map((item) => ({ ...item })),
})

const defaultState = () => ({
  version: 1,
  profile: null,
  settings: defaultSettings(),
  wordStates: {},
  activity: {},
  searches: [],
  // AI 对话与针对单词生成的例句/解析，持久化后可跨会话恢复
  ai: { chat: [], entries: {} },
  // 本机自定义词条覆盖层：AI 补录 / 修正的词条，键为小写词形
  customWords: {},
})

function normalizeSettings(parsed) {
  const merged = { ...defaultSettings(), ...(parsed || {}) }
  if (!Array.isArray(merged.aiProviders) || !merged.aiProviders.length) {
    merged.aiProviders = defaultSettings().aiProviders
    if (parsed && (parsed.aiBase || parsed.aiModel || parsed.aiKey)) {
      merged.aiProviders[0] = {
        ...merged.aiProviders[0],
        base: parsed.aiBase || merged.aiProviders[0].base,
        model: parsed.aiModel || merged.aiProviders[0].model,
        key: parsed.aiKey || '',
      }
    }
  }
  if (!merged.aiProviders.some((item) => item.id === merged.aiProviderId)) {
    merged.aiProviderId = merged.aiProviders[0].id
  }
  return merged
}

function normalizeAi(parsed) {
  const chat = Array.isArray(parsed?.chat) ? parsed.chat.filter((m) => m && m.role && m.content) : []
  const entries = parsed?.entries && typeof parsed.entries === 'object' ? parsed.entries : {}
  return { chat: chat.slice(-40), entries }
}

const SAFE_BOOK_IDS = new Set(BOOKS.map((b) => b.id))

export function normalizeWordKey(word) {
  return String(word || '').trim().toLowerCase().replace(/’/g, "'")
}

/** 只保留 dictionary.json 词条结构里的安全字段，挡住 AI 塞进来的任意键 */
export function sanitizeEntry(word, raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const w = normalizeWordKey(word)
  const tr = Array.isArray(src.tr)
    ? src.tr.filter((t) => t && typeof t.c === 'string' && t.c.trim()).slice(0, 12).map((t) => ({
      p: String(t.p || '').slice(0, 24),
      c: String(t.c || '').slice(0, 300),
      e: String(t.e || '').slice(0, 300),
    }))
    : []
  const ex = Array.isArray(src.ex)
    ? src.ex.filter((e) => e && typeof e.en === 'string' && e.en.trim()).slice(0, 5).map((e) => ({
      en: String(e.en).slice(0, 300),
      cn: String(e.cn || '').slice(0, 300),
    }))
    : []
  const books = Array.isArray(src.books)
    ? [...new Set(src.books.filter((b) => SAFE_BOOK_IDS.has(b)))].slice(0, 4)
    : []
  return {
    w,
    uk: typeof src.uk === 'string' ? src.uk.slice(0, 80) : '',
    us: typeof src.us === 'string' ? src.us.slice(0, 80) : '',
    tr,
    ex,
    ph: [], syn: [], syno: [], ant: [], fam: [], exam: [],
    root: '',
    books: books.length ? books : ['cet4'],
    rank: 0,
    star: 0,
    custom: true,
    updatedAt: Date.now(),
  }
}

function normalizeCustomWords(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out = {}
  for (const [key, value] of Object.entries(parsed)) {
    const w = normalizeWordKey(key)
    if (!/^[a-z][a-z' -]*$/.test(w) || w.length > 64 || !value || typeof value !== 'object') continue
    out[w] = sanitizeEntry(w, value)
  }
  return out
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultState()
    const parsed = JSON.parse(raw)
    return {
      ...defaultState(),
      ...parsed,
      profile: parsed.profile ? { dailyReview: DEFAULT_DAILY_REVIEW, ...parsed.profile } : null,
      settings: normalizeSettings(parsed.settings),
      wordStates: parsed.wordStates || {},
      activity: parsed.activity || {},
      searches: parsed.searches || [],
      ai: normalizeAi(parsed.ai),
      customWords: normalizeCustomWords(parsed.customWords),
    }
  } catch {
    return defaultState()
  }
}

export function emptyRecord(word, now = Date.now()) {
  return {
    word,
    status: 'learning',
    favorite: false,
    addedAt: now,
    lastReviewedAt: null,
    wrongCount: 0,
    correctCount: 0,
    wrongFlag: false,
    ease: 2.5,
    interval: 0,
    reps: 0,
    due: 0,
    lastQuality: null,
  }
}

function withRecord(state, word, updater) {
  const record = state.wordStates[word] || emptyRecord(word)
  return { ...state.wordStates, [word]: updater(record) }
}

function reducer(state, action) {
  switch (action.type) {
    case 'COMPLETE_ONBOARDING': {
      return {
        ...state,
        profile: action.profile,
        settings: { ...defaultSettings(), bookId: action.bookId, ...(action.settings || {}) },
      }
    }
    case 'UPDATE_PROFILE':
      return { ...state, profile: { ...state.profile, ...action.patch } }
    case 'UPDATE_SETTINGS':
      return { ...state, settings: { ...state.settings, ...action.patch } }

    case 'ANSWER_WORD': {
      const { word, quality, mode } = action
      const existed = Boolean(state.wordStates[word])
      const now = Date.now()
      const next = state.wordStates[word] || emptyRecord(word, now)
      const sm = schedule(next, quality, now)
      const record = {
        ...next,
        ...sm,
        lastReviewedAt: now,
        wrongCount: next.wrongCount + (quality < 3 ? 1 : 0),
        correctCount: next.correctCount + (quality >= 3 ? 1 : 0),
        wrongFlag: quality < 3 ? true : quality >= 4 && sm.reps >= 3 ? false : next.wrongFlag,
        status: quality < 3 ? 'unknown' : sm.reps >= 3 && sm.ease >= 2.3 ? 'known' : next.status === 'known' ? 'known' : 'familiar',
        lastMode: mode || null,
      }
      const today = todayKey()
      const day = state.activity[today] || { newWords: 0, reviewWords: 0, total: 0, correct: 0, minutes: 0 }
      const updatedDay = {
        ...day,
        newWords: day.newWords + (!existed && action.isNew ? 1 : 0),
        reviewWords: day.reviewWords + (existed ? 1 : !action.isNew ? 1 : 0),
        total: day.total + 1,
        correct: day.correct + (quality >= 3 ? 1 : 0),
      }
      return {
        ...state,
        wordStates: { ...state.wordStates, [word]: record },
        activity: { ...state.activity, [today]: updatedDay },
      }
    }

    case 'SET_STATUS': {
      const { word, status } = action
      const now = Date.now()
      const record = state.wordStates[word] || emptyRecord(word, now)
      let patch = { status, manualAt: now }
      if (status === 'known') {
        patch = {
          ...patch,
          wrongFlag: false,
          reps: Math.max(3, record.reps),
          interval: Math.max(30, record.interval),
          ease: Math.max(2.5, record.ease),
          due: now + 30 * 86400000,
        }
      } else if (status === 'unknown') {
        patch = { ...patch, reps: 0, interval: 0, due: now, wrongFlag: true }
      } else {
        patch = { ...patch, due: now }
      }
      return { ...state, wordStates: { ...state.wordStates, [word]: { ...record, ...patch } } }
    }

    case 'TOGGLE_FAVORITE': {
      const now = Date.now()
      const record = state.wordStates[action.word] || emptyRecord(action.word, now)
      const favorite = !record.favorite
      return {
        ...state,
        wordStates: {
          ...state.wordStates,
          [action.word]: {
            ...record,
            favorite,
            due: favorite ? now : record.due,
            addedAt: record.addedAt || now,
          },
        },
      }
    }

    case 'ADD_SEARCH': {
      const term = action.term.trim()
      if (!term) return state
      const searches = [{ term, at: Date.now() }, ...state.searches.filter((s) => s.term !== term)].slice(0, 15)
      return { ...state, searches }
    }
    case 'CLEAR_SEARCH':
      return { ...state, searches: [] }

    case 'ADD_TIME': {
      const today = todayKey()
      const day = state.activity[today] || { newWords: 0, reviewWords: 0, total: 0, correct: 0, minutes: 0 }
      return {
        ...state,
        activity: {
          ...state.activity,
          [today]: { ...day, minutes: Math.round(((day.minutes || 0) + action.minutes) * 10) / 10 },
        },
      }
    }

    case 'AI_SET_CHAT': {
      const ai = state.ai || { chat: [], entries: {} }
      const chat = (action.messages || [])
        .filter((m) => m && m.role && typeof m.content === 'string')
        .slice(-40)
      return { ...state, ai: { ...ai, chat } }
    }

    case 'AI_CLEAR_CHAT': {
      const ai = state.ai || { chat: [], entries: {} }
      return { ...state, ai: { ...ai, chat: [] } }
    }

    case 'AI_SAVE_ENTRY': {
      const { word, mode, text } = action
      if (!word || !mode || !text) return state
      const ai = state.ai || { chat: [], entries: {} }
      const prev = ai.entries?.[word] || {}
      return {
        ...state,
        ai: {
          ...ai,
          entries: { ...ai.entries, [word]: { ...prev, [mode]: { text, at: Date.now() } } },
        },
      }
    }

    case 'AI_CLEAR_ENTRY': {
      const ai = state.ai
      const record = ai?.entries?.[action.word]
      if (!record || !record[action.mode]) return state
      const next = { ...record }
      delete next[action.mode]
      const entries = { ...ai.entries }
      if (Object.keys(next).length) entries[action.word] = next
      else delete entries[action.word]
      return { ...state, ai: { ...ai, entries } }
    }

    case 'CUSTOM_WORD_UPSERT': {
      const w = normalizeWordKey(action.word)
      if (!/^[a-z][a-z' -]*$/.test(w) || w.length > 64) return state
      const entry = sanitizeEntry(w, action.entry)
      if (!entry.tr.length) return state
      return { ...state, customWords: { ...(state.customWords || {}), [w]: entry } }
    }

    case 'CUSTOM_WORD_PATCH': {
      const w = normalizeWordKey(action.word)
      if (!/^[a-z][a-z' -]*$/.test(w) || w.length > 64) return state
      const prev = state.customWords?.[w] || action.base || {}
      const patch = action.patch && typeof action.patch === 'object' ? action.patch : {}
      const allowed = Object.fromEntries(
        Object.entries(patch).filter(([k]) => ['uk', 'us', 'tr', 'ex', 'books'].includes(k)),
      )
      const entry = sanitizeEntry(w, { ...prev, ...allowed, w })
      if (!entry.tr.length) return state
      return { ...state, customWords: { ...(state.customWords || {}), [w]: entry } }
    }

    case 'CUSTOM_WORD_REMOVE': {
      const w = normalizeWordKey(action.word)
      if (!state.customWords?.[w]) return state
      const next = { ...state.customWords }
      delete next[w]
      return { ...state, customWords: next }
    }

    case 'IMPORT_STATE': {
      return {
        ...defaultState(),
        ...action.data,
        settings: normalizeSettings(action.data.settings),
        wordStates: action.data.wordStates || {},
        activity: action.data.activity || {},
        searches: action.data.searches || [],
        ai: normalizeAi(action.data.ai),
        customWords: normalizeCustomWords(action.data.customWords),
      }
    }

    case 'RESET_ALL':
      return defaultState()

    case 'RESET_PROGRESS':
      return { ...state, wordStates: {}, activity: {}, searches: [] }

    default:
      return state
  }
}

const AppContext = createContext(null)

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadState)
  // 渲染前同步覆盖层：保证本次渲染里 searchWords / lookupFull 已能看到自建词条
  setCustomWords(state.customWords)
  const [dictStatus, setDictStatus] = useState({ indexReady: false, fullReady: false, loading: false, error: null })
  const dictStarted = useRef(false)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // Storage can be full or unavailable in private mode; the session still works.
    }
  }, [state])

  const ensureFullDict = useCallback(async () => {
    setDictStatus((s) => (s.fullReady ? s : { ...s, loading: true, error: null }))
    try {
      await loadFullDictionary()
      setDictStatus((s) => ({ ...s, fullReady: true, loading: false, error: null }))
    } catch (err) {
      setDictStatus((s) => ({ ...s, loading: false, error: err.message || '词库加载失败' }))
    }
  }, [])

  useEffect(() => {
    loadIndex()
      .then(() => setDictStatus((s) => ({ ...s, indexReady: true })))
      .catch((err) => setDictStatus((s) => ({ ...s, error: err.message || '词库索引加载失败' })))
  }, [])

  useEffect(() => {
    if (!state.profile) return
    const timer = window.setTimeout(() => {
      if (!dictStarted.current) {
        dictStarted.current = true
        ensureFullDict()
      }
    }, 1600)
    return () => window.clearTimeout(timer)
  }, [state.profile, ensureFullDict])

  // Theme: follow the system when requested, otherwise use the explicit choice.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const theme = state.settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : state.settings.theme
      document.documentElement.dataset.theme = theme
      document.documentElement.style.colorScheme = theme
    }
    apply()
    media.addEventListener?.('change', apply)
    return () => media.removeEventListener?.('change', apply)
  }, [state.settings.theme])

  // Font: system / serif / mono are local stacks; custom is hydrated from IndexedDB.
  useEffect(() => {
    let cancelled = false
    const font = state.settings.font
    if (font === 'custom') {
      applyCustomFont().then((record) => {
        if (cancelled) return
        if (record) setAppFont(`"WordVaultCustom", ${APP_FONT_FALLBACK}`)
        else setAppFont(APP_FONT_FALLBACK)
      })
    } else {
      const option = FONT_OPTIONS.find((f) => f.id === font)
      setAppFont(option?.stack || APP_FONT_FALLBACK)
    }
    return () => {
      cancelled = true
    }
  }, [state.settings.font, state.settings.customFontName])

  const today = todayKey()
  const todayActivity = state.activity[today] || { newWords: 0, reviewWords: 0, total: 0, correct: 0, minutes: 0 }
  const dueCount = useMemo(() => {
    const now = Date.now()
    return Object.values(state.wordStates).filter((r) => r.due && r.due <= now).length
  }, [state.wordStates])

  const masteredCount = useMemo(
    () => Object.values(state.wordStates).filter((r) => r.status === 'known').length,
    [state.wordStates],
  )
  const wrongCount = useMemo(
    () => Object.values(state.wordStates).filter((r) => r.wrongFlag).length,
    [state.wordStates],
  )
  const streak = useMemo(() => computeStreak(state.activity), [state.activity])
  const studyDays = useMemo(() => activeDays(state.activity), [state.activity])
  const currentBook = BOOK_MAP[state.settings.bookId] || BOOK_MAP.cet4
  const dailyNew = state.profile?.dailyNew || 20
  const newRemaining = Math.max(0, dailyNew - todayActivity.newWords)
  const dailyReview = state.profile?.dailyReview ?? DEFAULT_DAILY_REVIEW
  const reviewRemaining = dailyReview > 0 ? Math.max(0, dailyReview - (todayActivity.reviewWords || 0)) : null
  const goal = GOALS.find((g) => g.id === state.profile?.goal)
  const level = LEVELS.find((l) => l.id === state.profile?.level)

  const stats = {
    todayActivity,
    dueCount,
    masteredCount,
    wrongCount,
    streak,
    studyDays,
    newRemaining,
    goal,
    level,
    dailyNew,
    dailyReview,
    reviewRemaining,
    currentBook,
  }

  const dict = {
    ...dictStatus,
    indexWords: getIndexWords(),
    lookupBasic,
    ensureFullDict,
  }

  const value = useMemo(
    () => ({
      state,
      dispatch,
      stats,
      dict,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, dictStatus],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside AppProvider')
  return ctx
}

export function getTodayStats(state) {
  const key = dateKey()
  return state.activity[key] || { newWords: 0, reviewWords: 0, total: 0, correct: 0, minutes: 0 }
}
