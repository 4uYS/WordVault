import { useMemo, useState } from 'react'
import { useApp } from '../AppContext'
import { PRACTICE_MODES } from '../lib/constants'
import { computeStreak, formatMinutes, formatShortDate, todayKey, weekDays, weekdayLabel } from '../lib/date'
import { Icon } from '../components/Icons'

function greeting() {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 19) return '下午好'
  return '晚上好'
}

function WeeklyChart({ activity }) {
  const [metric, setMetric] = useState('new')
  const days = useMemo(() => weekDays(), [])
  const values = days.map((key) => {
    const d = activity[key] || {}
    return {
      key,
      new: d.newWords || 0,
      review: d.reviewWords || 0,
      minutes: Math.round(d.minutes || 0),
    }
  })
  const max = Math.max(1, ...values.map((v) => v[metric]))
  const totalNew = values.reduce((sum, v) => sum + v.new, 0)
  const totalReview = values.reduce((sum, v) => sum + v.review, 0)
  const totalMinutes = values.reduce((sum, v) => sum + v.minutes, 0)

  const metrics = [
    { id: 'new', label: '新学词数', color: 'var(--primary)' },
    { id: 'review', label: '复习词数', color: 'var(--secondary)' },
    { id: 'minutes', label: '学习时长', color: 'var(--success)' },
  ]

  return (
    <section className="panel weekly-panel">
      <div className="section-head">
        <div>
          <span className="eyebrow">本周概览</span>
          <h2>学习节奏</h2>
        </div>
        <div className="metric-tabs">
          {metrics.map((m) => (
            <button
              key={m.id}
              className={`metric-tab ${metric === m.id ? 'active' : ''}`}
              onClick={() => setMetric(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className={`weekly-chart ${metric}`}>
        {values.map((v) => {
          const value = v[metric]
          const height = value > 0 ? Math.max(6, (value / max) * 100) : 2
          return (
            <div className="chart-col" key={v.key}>
              <span className="chart-value">{value || ''}</span>
              <div className="chart-bar-track">
                <div
                  className="chart-bar"
                  style={{ height: `${height}%`, background: metrics.find((m) => m.id === metric)?.color }}
                />
              </div>
              <span className="chart-label">{v.key === todayKey() ? '今天' : weekdayLabel(v.key)}</span>
              <span className="chart-date">{formatShortDate(v.key)}</span>
            </div>
          )
        })}
      </div>

      <div className="week-summary">
        <div><span>本周学习时长</span><strong>{formatMinutes(totalMinutes)}</strong></div>
        <div><span>本周新学</span><strong>{totalNew} 词</strong></div>
        <div><span>本周复习</span><strong>{totalReview} 词</strong></div>
      </div>
    </section>
  )
}

export default function Home({ navigate }) {
  const { state, stats, dict } = useApp()
  const { profile } = state
  const { currentBook, dailyNew, dailyReview, reviewRemaining, dueCount, newRemaining, todayActivity } = stats
  const newDone = Math.min(todayActivity.newWords, dailyNew)
  const reviewDone = todayActivity.reviewWords
  // 受每日复习上限约束后，今天真正需要完成的到期词数量
  const dueToday = dailyReview > 0 ? Math.min(dueCount, reviewRemaining) : dueCount
  const denominator = Math.max(1, dailyNew + reviewDone + dueToday)
  const progress = Math.min(100, Math.round(((newDone + reviewDone) / denominator) * 100))
  const allDone = newRemaining <= 0 && dueToday <= 0
  const reviewLimitHit = dailyReview > 0 && reviewRemaining === 0 && dueCount > 0

  const bookStats = useMemo(() => {
    const words = dict.indexWords || []
    const inBook = words.filter((w) => w.b.includes(currentBook.id))
    const known = inBook.filter((w) => state.wordStates[w.w]?.status === 'known').length
    return { total: inBook.length, known }
  }, [dict.indexWords, currentBook.id, state.wordStates])

  const streak = computeStreak(state.activity)
  const accuracy = todayActivity.total ? Math.round((todayActivity.correct / todayActivity.total) * 100) : 0

  return (
    <div className="page home-page">
      <header className="page-intro">
        <div>
          <span className="eyebrow">今日任务 · {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</span>
          <h1>{greeting()}，{profile.nickname}</h1>
          <p>目标：{stats.goal?.label || '稳步提升'}。今天适合先复习，再学新词。</p>
        </div>
        <div className="level-stamp">
          <span>当前水平</span>
          <strong>{stats.level?.label || '初级'}</strong>
          <em>{currentBook.name}</em>
        </div>
      </header>

      <section className="task-hero">
        <div className="task-hero-main">
          <div className="task-hero-head">
            <span className="eyebrow">今日学习</span>
            <span className={`task-status ${allDone ? 'done' : ''}`}>
              <Icon name={allDone ? 'check' : 'target'} size={15} />
              {allDone ? '已完成' : '进行中'}
            </span>
          </div>
          <div className="task-progress-row">
            <strong className="task-percent">{progress}<small>%</small></strong>
            <div className="task-progress-copy">
              <span>新学 {newDone} / {dailyNew}</span>
              <span>复习 {reviewDone}{dailyReview > 0 ? ` / ${dailyReview}` : ''} 词</span>
              <span className={dueCount ? 'due' : ''}>待复习 {dueCount}</span>
            </div>
          </div>
          <div className="progress-bar large" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${progress}%` }} />
          </div>
          {reviewLimitHit ? (
            <p className="task-note">
              <Icon name="clock" size={14} />
              今日复习已达上限（{dailyReview} 个），剩余 {dueCount} 个到期词将顺延到明天。
            </p>
          ) : null}
          <div className="task-hero-actions">
            <button className="btn btn-primary" onClick={() => navigate('study')}>
              <Icon name="play" size={17} />
              {allDone ? '再复习一轮' : dueToday > 0 && newRemaining > 0 ? '开始今日学习' : dueToday > 0 ? '开始复习' : '学习新词'}
            </button>
            <button className="btn btn-outlined" onClick={() => navigate('practice/choice')}>
              <Icon name="shuffle" size={17} />
              专项练习
            </button>
          </div>
        </div>
        <div className="task-hero-side">
          <div className="task-mini">
            <span>连续打卡</span>
            <strong>{streak}<small>天</small></strong>
            <em>累计 {stats.studyDays} 天</em>
          </div>
          <div className="task-mini">
            <span>今日正确率</span>
            <strong>{accuracy}<small>%</small></strong>
            <em>{todayActivity.total} 次作答</em>
          </div>
        </div>
      </section>

      <div className="stat-strip">
        <div className="stat-cell">
          <span>已掌握单词</span>
          <strong>{stats.masteredCount}</strong>
          <em>词</em>
        </div>
        <div className="stat-cell">
          <span>错词待巩固</span>
          <strong>{stats.wrongCount}</strong>
          <em>词</em>
        </div>
        <div className="stat-cell">
          <span>当前词书进度</span>
          <strong>{bookStats.total ? Math.round((bookStats.known / bookStats.total) * 100) : 0}<small>%</small></strong>
          <em>{bookStats.known} / {bookStats.total}</em>
        </div>
        <div className="stat-cell">
          <span>今日学习时长</span>
          <strong>{Math.round(todayActivity.minutes || 0)}</strong>
          <em>分钟</em>
        </div>
      </div>

      <WeeklyChart activity={state.activity} />

      <section className="practice-section">
        <div className="section-head">
          <div>
            <span className="eyebrow">专项练习</span>
            <h2>换一种方式记单词</h2>
          </div>
          <button className="btn btn-text" onClick={() => navigate('practice/choice')}>
            全部模式
            <Icon name="chevronRight" size={16} />
          </button>
        </div>
        <div className="practice-grid">
          {PRACTICE_MODES.map((mode) => (
            <button key={mode.id} className="practice-card" onClick={() => navigate(`practice/${mode.id}`)}>
              <span className="practice-icon"><Icon name={mode.icon} size={22} /></span>
              <strong>{mode.name}</strong>
              <span>{mode.desc}</span>
              <em>来自 {currentBook.short}</em>
            </button>
          ))}
        </div>
      </section>

      <div className="home-bottom-grid">
        <section className="panel book-mini-panel">
          <div className="section-head compact">
            <div>
              <span className="eyebrow">当前词书</span>
              <h2>{currentBook.name}</h2>
            </div>
            <span className="book-chip" style={{ borderColor: currentBook.color }}>{currentBook.short}</span>
          </div>
          <p>{currentBook.desc} · 共收录 {bookStats.total} 词</p>
          <div className="progress-bar">
            <span style={{ width: `${bookStats.total ? (bookStats.known / bookStats.total) * 100 : 0}%`, background: currentBook.color }} />
          </div>
          <div className="book-mini-foot">
            <span>已掌握 {bookStats.known} 词</span>
            <button className="btn btn-text" onClick={() => navigate('library')}>
              切换词书
              <Icon name="arrowRight" size={15} />
            </button>
          </div>
        </section>

        <button className="panel wrong-mini-panel" onClick={() => navigate('wrong')}>
          <span className="wrong-icon"><Icon name="alert" size={24} /></span>
          <div>
            <span className="eyebrow">错词本</span>
            <h2>{stats.wrongCount ? `${stats.wrongCount} 个词等待巩固` : '错词本还是空的'}</h2>
            <p>{stats.wrongCount ? '按遗忘曲线重新安排，逐个标记掌握程度。' : '做练习或学习时答错的单词会自动收进这里。'}</p>
          </div>
          <Icon name="arrowRight" size={20} className="wrong-arrow" />
        </button>
      </div>
    </div>
  )
}
