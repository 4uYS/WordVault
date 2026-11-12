import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../AppContext'
import { STATUS_META } from '../lib/constants'
import { getIndexWords, lookupFull } from '../lib/dict'
import { QUALITY, intervalPreview, nextReviewLabel } from '../lib/sm2'
import { speak } from '../lib/speech'
import { formatMinutes, todayKey } from '../lib/date'
import { Icon } from '../components/Icons'

function buildQueue(state, bookId) {
  const now = Date.now()
  const due = Object.values(state.wordStates)
    .filter((r) => r.due && r.due <= now)
    .sort((a, b) => a.due - b.due)
    .map((r) => ({ word: r.word, isNew: false }))
  const remaining = Math.max(0, (state.profile?.dailyNew || 20) - (state.activity[todayKey()]?.newWords || 0))
  const newWords = getIndexWords()
    .filter((w) => w.b.includes(bookId) && !state.wordStates[w.w])
    .slice(0, remaining)
    .map((w) => ({ word: w.w, isNew: true }))
  return [...due, ...newWords].filter((item) => lookupFull(item.word))
}

export default function Study({ navigate, openWord }) {
  const { state, dispatch, dict } = useApp()
  const [queue, setQueue] = useState(null)
  const [position, setPosition] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [feedback, setFeedback] = useState(null)
  const [finished, setFinished] = useState(false)
  const [results, setResults] = useState({ correct: 0, wrong: 0, newWords: 0, reviews: 0 })
  const startRef = useRef(null)
  const recordedRef = useRef(false)
  const currentRef = useRef(0)
  currentRef.current = position

  useEffect(() => {
    if (!dict.fullReady) {
      dict.ensureFullDict()
      return
    }
    if (queue !== null) return
    const initial = buildQueue(state, state.settings.bookId)
    if (!initial.length) {
      setFinished(true)
      setQueue([])
      return
    }
    setQueue(initial)
    startRef.current = Date.now()
  }, [dict.fullReady, dict.ensureFullDict, queue, state])

  const recordTime = () => {
    if (!startRef.current || recordedRef.current) return
    recordedRef.current = true
    const mins = (Date.now() - startRef.current) / 60000
    if (mins >= 0.05) dispatch({ type: 'ADD_TIME', minutes: Math.round(mins * 10) / 10 })
  }

  useEffect(() => () => {
    if (startRef.current && !recordedRef.current) {
      const mins = (Date.now() - startRef.current) / 60000
      if (mins >= 0.05) dispatch({ type: 'ADD_TIME', minutes: Math.round(mins * 10) / 10 })
      recordedRef.current = true
    }
  }, [dispatch])

  const item = queue?.[position]
  const entry = item ? lookupFull(item.word) : null
  const record = item ? state.wordStates[item.word] : null
  const percent = queue?.length ? Math.round((position / queue.length) * 100) : 0

  useEffect(() => {
    if (!item || !state.settings.autoSpeak || flipped) return
    const timer = window.setTimeout(() => speak(item.word, state.settings.accent), 260)
    return () => window.clearTimeout(timer)
  }, [position, item, state.settings.autoSpeak, state.settings.accent, flipped])

  const grade = (quality) => {
    if (!item || !flipped || feedback) return
    dispatch({ type: 'ANSWER_WORD', word: item.word, quality, isNew: item.isNew, mode: 'flashcard' })
    setResults((r) => ({
      correct: r.correct + (quality >= 3 ? 1 : 0),
      wrong: r.wrong + (quality < 3 ? 1 : 0),
      newWords: r.newWords + (item.isNew ? 1 : 0),
      reviews: r.reviews + (item.isNew ? 0 : 1),
    }))
    setFeedback({ ok: quality >= 3 })
    window.setTimeout(() => {
      setFeedback(null)
      setFlipped(false)
      if (position + 1 >= queue.length) {
        setFinished(true)
        recordTime()
      } else {
        setPosition((p) => p + 1)
      }
    }, 280)
  }

  useEffect(() => {
    const onKey = (e) => {
      if (!item || finished) return
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        setFlipped((f) => !f)
      }
      if (flipped && !feedback) {
        if (e.key === '1') grade(QUALITY.again)
        if (e.key === '2') grade(QUALITY.hard)
        if (e.key === '3') grade(QUALITY.good)
        if (e.key === '4') grade(QUALITY.easy)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [item, flipped, feedback, finished, position, queue])

  const exit = () => {
    recordTime()
    navigate('home')
  }

  const dateLine = useMemo(() => formatMinutes(state.activity[todayKey()]?.minutes || 0), [state.activity])

  if (!dict.fullReady) {
    return (
      <div className="focus-page study-page">
        <div className="focus-bar">
          <button className="icon-btn" onClick={exit} aria-label="返回"><Icon name="chevronLeft" size={22} /></button>
          <span className="focus-title">今日学习</span>
          <span className="focus-progress">本地词库</span>
        </div>
        <div className="study-loading">
          <span className="spinner large" />
          <h2>正在装载离线词库</h2>
          <p>首次进入需要读取约 8.7 MB 的本地词条，之后会一直缓存在设备上。</p>
          {dict.error && <p className="error-text">{dict.error}</p>}
        </div>
      </div>
    )
  }

  if (finished) {
    const total = results.correct + results.wrong
    const rate = total ? Math.round((results.correct / total) * 100) : 0
    return (
      <div className="focus-page study-page">
        <div className="focus-bar">
          <button className="icon-btn" onClick={exit} aria-label="返回"><Icon name="chevronLeft" size={22} /></button>
          <span className="focus-title">学习总结</span>
          <span className="focus-progress">已完成</span>
        </div>
        <div className="study-summary">
          <span className="summary-icon"><Icon name="check" size={40} /></span>
          <span className="eyebrow">本次学习完成</span>
          <h1>今天的宝箱又满了一点</h1>
          <p>复习记录已按 SM-2 算法写入本地，下一次复习时间已自动安排。</p>
          <div className="summary-stat-grid">
            <div><strong>{results.newWords}</strong><span>新学单词</span></div>
            <div><strong>{results.reviews}</strong><span>复习单词</span></div>
            <div><strong>{rate}%</strong><span>正确率</span></div>
            <div><strong>{dateLine}</strong><span>今日累计时长</span></div>
          </div>
          <div className="summary-actions">
            <button className="btn btn-primary" onClick={() => navigate('home')}>返回首页</button>
            <button className="btn btn-outlined" onClick={() => navigate('wrong')}>查看错词本</button>
            <button className="btn btn-text" onClick={() => navigate('practice/choice')}>专项练习</button>
          </div>
        </div>
      </div>
    )
  }

  if (!item) {
    return (
      <div className="focus-page study-page">
        <div className="focus-bar">
          <button className="icon-btn" onClick={exit} aria-label="返回"><Icon name="chevronLeft" size={22} /></button>
          <span className="focus-title">今日学习</span>
        </div>
        <div className="study-loading"><span className="spinner large" /><h2>正在准备学习卡片</h2><p>检查今日新词与到期复习。</p></div>
      </div>
    )
  }

  return (
    <div className="focus-page study-page">
      <div className="focus-bar">
        <button className="icon-btn" onClick={exit} aria-label="返回"><Icon name="chevronLeft" size={22} /></button>
        <div className="focus-progress-wrap">
          <div className="focus-progress-meta">
            <span>{item.isNew ? '新学单词' : '复习单词'}</span>
            <span>{position + 1} / {queue.length}</span>
          </div>
          <div className="progress-bar focus-progress-bar"><span style={{ width: `${percent}%` }} /></div>
        </div>
        <button className="focus-detail" onClick={() => openWord(item.word)}>详情</button>
      </div>

      <div className={`study-stage ${feedback ? (feedback.ok ? 'flash-ok' : 'flash-bad') : ''}`}>
        <div className={`flip-card ${flipped ? 'flipped' : ''}`}>
          <div className="flip-inner">
            <section className="card-face card-front">
              <div className="card-topline">
                <span className="eyebrow">{STATUS_META[record?.status]?.label || '本地词库'}</span>
                <span className="card-source">{entry.books?.map((b) => b.toUpperCase()).join(' · ')}</span>
              </div>
              <div className="word-block">
                <h1 className="study-word">{entry.w}</h1>
                <div className="study-phonetics">
                  <button onClick={() => speak(entry.w, 'uk')} disabled={!entry.uk}>
                    <span>英</span> /{entry.uk || '—'}/ <Icon name="volumeSmall" size={16} />
                  </button>
                  <button onClick={() => speak(entry.w, 'us')} disabled={!entry.us}>
                    <span>美</span> /{entry.us || '—'}/ <Icon name="volumeSmall" size={16} />
                  </button>
                </div>
              </div>
              <div className="card-front-hint">
                <p>先回想它的意思，再翻开卡片。</p>
                <button className="btn btn-primary btn-wide" onClick={() => setFlipped(true)}>
                  显示释义
                  <Icon name="refresh" size={17} />
                </button>
                <span className="key-hint">空格键翻面</span>
              </div>
            </section>

            <section className="card-face card-back">
              <div className="card-back-head">
                <div>
                  <span className="eyebrow">释义</span>
                  <h2>{entry.w}</h2>
                </div>
                <button className="icon-btn small" onClick={() => speak(entry.w, state.settings.accent)} aria-label="朗读">
                  <Icon name="volumeSmall" size={19} />
                </button>
              </div>
              <div className="card-back-scroll">
                <div className="trans-list compact">
                  {entry.tr.map((t, i) => (
                    <div className="trans-row" key={i}>
                      {t.p && <span className="pos-badge">{t.p}</span>}
                      <div>
                        <p>{t.c || '暂无中文释义'}</p>
                        {t.e && <span className="en-def">{t.e}</span>}
                      </div>
                    </div>
                  ))}
                </div>
                {entry.ex[0] && (
                  <div className="study-example">
                    <p>{entry.ex[0].en}</p>
                    <span>{entry.ex[0].cn}</span>
                  </div>
                )}
                {entry.root && (
                  <div className="study-mnemonic">
                    <span className="mini-label">助记 / 词根线索</span>
                    <p>{entry.root}</p>
                  </div>
                )}
                {entry.syn.length > 0 && (
                  <div className="study-syn">
                    <span className="mini-label">近义词</span>
                    <div className="word-chips">
                      {entry.syn.slice(0, 5).map((s) => <span key={s} className="word-chip static">{s}</span>)}
                    </div>
                  </div>
                )}
                <div className="study-review-meta">
                  <Icon name="clock" size={14} />
                  {nextReviewLabel(record)}
                </div>
              </div>
            </section>
          </div>
        </div>

        {feedback && (
          <div className={`answer-banner ${feedback.ok ? 'ok' : 'bad'}`}>
            <Icon name={feedback.ok ? 'check' : 'alert'} size={17} />
            {feedback.ok ? '已记录，继续下一个' : '已加入错词本，稍后会再出现'}
          </div>
        )}

        {flipped && (
          <div className="grade-bar">
            {[
              { q: QUALITY.again, label: '忘记', hint: '10 分钟', tone: 'danger', key: '1' },
              { q: QUALITY.hard, label: '模糊', hint: intervalPreview(record, QUALITY.hard), tone: 'warning', key: '2' },
              { q: QUALITY.good, label: '记得', hint: intervalPreview(record, QUALITY.good), tone: 'primary', key: '3' },
              { q: QUALITY.easy, label: '熟练', hint: intervalPreview(record, QUALITY.easy), tone: 'success', key: '4' },
            ].map((btn) => (
              <button key={btn.q} className={`grade-btn ${btn.tone}`} onClick={() => grade(btn.q)} disabled={Boolean(feedback)}>
                <strong>{btn.label}</strong>
                <span>{btn.hint}</span>
                <em>{btn.key}</em>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
