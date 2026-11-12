import { useMemo, useState } from 'react'
import { useApp } from '../AppContext'
import { DAILY_OPTIONS, DEFAULT_DAILY_REVIEW, GOALS, IDENTITIES, LEVELS } from '../lib/constants'
import { Icon, LogoMark } from './Icons'

const STEPS = [
  { key: 'identity', kicker: '身份', title: '先认识一下你', desc: '可多选，用来匹配更适合你的学习节奏。' },
  { key: 'goal', kicker: '目标', title: '这次为什么学英语', desc: '我们会据此推荐默认词书，之后随时可以切换。' },
  { key: 'level', kicker: '水平', title: '现在的词汇量大概在哪', desc: '没有考试，凭感觉选择即可，之后可调整。' },
  { key: 'plan', kicker: '计划', title: '给每天定一个小目标', desc: '新词量与提醒时间都可以在个人中心修改。' },
]

export default function Onboarding() {
  const { dispatch } = useApp()
  const [step, setStep] = useState(0)
  const [identities, setIdentities] = useState([])
  const [goal, setGoal] = useState('')
  const [level, setLevel] = useState('')
  const [dailyNew, setDailyNew] = useState(20)
  const [reminderTime, setReminderTime] = useState('20:00')
  const [notify, setNotify] = useState(true)
  const [direction, setDirection] = useState('forward')

  const selectedGoal = GOALS.find((g) => g.id === goal)
  const selectedLevel = LEVELS.find((l) => l.id === level)

  const canNext = useMemo(() => {
    if (step === 0) return identities.length > 0
    if (step === 1) return Boolean(goal)
    if (step === 2) return Boolean(level)
    return true
  }, [step, identities, goal, level])

  const toggleIdentity = (item) => {
    setIdentities((prev) => (prev.includes(item) ? prev.filter((x) => x !== item) : [...prev, item]))
  }

  const chooseLevel = (item) => {
    setLevel(item.id)
    setDailyNew(item.daily)
  }

  const move = (delta) => {
    setDirection(delta > 0 ? 'forward' : 'back')
    setStep((s) => Math.max(0, Math.min(STEPS.length - 1, s + delta)))
  }

  const finish = async () => {
    if (notify && 'Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission()
      } catch {
        // The app still works if the browser rejects notification permission.
      }
    }
    dispatch({
      type: 'COMPLETE_ONBOARDING',
      profile: {
        nickname: '词库旅人',
        identities,
        goal,
        level,
        dailyNew,
        dailyReview: DEFAULT_DAILY_REVIEW,
        reminderTime,
        notify,
        createdAt: Date.now(),
      },
      bookId: selectedGoal?.book || 'cet4',
      settings: { accent: 'us' },
    })
    window.location.hash = '/home'
  }

  const current = STEPS[step]

  return (
    <div className="onboarding">
      <aside className="onboarding-aside">
        <div className="onboarding-aside-inner">
          <div className="onboarding-logo">
            <LogoMark size={44} />
            <div>
              <strong>WordVault</strong>
              <span>词库宝箱</span>
            </div>
          </div>
          <h1>把每一个单词，<br />收进自己的宝箱。</h1>
          <p className="aside-lead">
            离线优先的英语学习工作台。画像、词库、复习记录都只留在当前设备。
          </p>
          <ul className="aside-points">
            <li>
              <Icon name="lock" size={18} />
              <div><strong>数据不出设备</strong><span>所有进度保存在浏览器本地。</span></div>
            </li>
            <li>
              <Icon name="layers" size={18} />
              <div><strong>SM-2 复习调度</strong><span>按掌握程度自动安排复习间隔。</span></div>
            </li>
            <li>
              <Icon name="database" size={18} />
              <div><strong>完整离线词库</strong><span>四六级、考研、雅思、托福、高考。</span></div>
            </li>
          </ul>
          <div className="aside-foot">本地优先 · 无需账号 · 无第三方接口</div>
        </div>
      </aside>

      <section className="onboarding-panel">
        <div className="onboarding-panel-inner">
          <div className="onboarding-topline">
            <span className="step-counter">{String(step + 1).padStart(2, '0')} / 04</span>
            <div className="step-dots" aria-hidden="true">
              {STEPS.map((s, i) => (
                <span key={s.key} className={`step-dot ${i <= step ? 'filled' : ''}`} />
              ))}
            </div>
          </div>

          <div key={step} className={`onboarding-step ${direction}`}>
            <span className="step-kicker">{current.kicker}</span>
            <h2>{current.title}</h2>
            <p className="step-desc">{current.desc}</p>

            {step === 0 && (
              <div className="choice-grid identity-grid">
                {IDENTITIES.map((item) => {
                  const active = identities.includes(item)
                  return (
                    <button
                      key={item}
                      type="button"
                      className={`choice-tile ${active ? 'selected' : ''}`}
                      onClick={() => toggleIdentity(item)}
                      aria-pressed={active}
                    >
                      <span>{item}</span>
                      <span className="tile-mark">{active ? <Icon name="check" size={15} /> : null}</span>
                    </button>
                  )
                })}
              </div>
            )}

            {step === 1 && (
              <div className="choice-grid goal-grid">
                {GOALS.map((item) => {
                  const active = goal === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`goal-tile ${active ? 'selected' : ''}`}
                      onClick={() => setGoal(item.id)}
                      aria-pressed={active}
                    >
                      <strong>{item.label}</strong>
                      <span>{item.desc}</span>
                      <em>{item.book.toUpperCase()}</em>
                    </button>
                  )
                })}
              </div>
            )}

            {step === 2 && (
              <div className="level-list">
                {LEVELS.map((item, index) => {
                  const active = level === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`level-row ${active ? 'selected' : ''}`}
                      onClick={() => chooseLevel(item)}
                      aria-pressed={active}
                    >
                      <span className="level-index">0{index + 1}</span>
                      <span className="level-main">
                        <strong>{item.label}</strong>
                        <span>{item.desc}</span>
                      </span>
                      <span className="level-bars" aria-hidden="true">
                        {[0, 1, 2, 3].map((bar) => (
                          <i key={bar} className={bar <= index ? 'on' : ''} />
                        ))}
                      </span>
                      <span className="tile-mark">{active ? <Icon name="check" size={15} /> : null}</span>
                    </button>
                  )
                })}
              </div>
            )}

            {step === 3 && (
              <div className="plan-step">
                <div className="plan-block">
                  <div className="plan-label">
                    <span>每日新学单词</span>
                    <small>{selectedLevel ? `已按${selectedLevel.label}水平推荐` : '随时可以调整'}</small>
                  </div>
                  <div className="number-options">
                    {DAILY_OPTIONS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`number-option ${dailyNew === n ? 'selected' : ''}`}
                        onClick={() => setDailyNew(n)}
                      >
                        <strong>{n}</strong>
                        <span>个 / 天</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="plan-block">
                  <div className="plan-label">
                    <span>每日学习提醒</span>
                    <small>仅在应用打开时通过浏览器通知提醒</small>
                  </div>
                  <div className="plan-row">
                    <label className="time-field">
                      <Icon name="clock" size={18} />
                      <input
                        type="time"
                        value={reminderTime}
                        onChange={(e) => setReminderTime(e.target.value)}
                        aria-label="提醒时间"
                      />
                    </label>
                    <button
                      type="button"
                      className={`toggle-row ${notify ? 'on' : ''}`}
                      onClick={() => setNotify((v) => !v)}
                      aria-pressed={notify}
                    >
                      <span className="toggle-track"><i /></span>
                      <span>开启浏览器提醒</span>
                    </button>
                  </div>
                </div>

                <div className="plan-summary">
                  <span className="summary-label">计划预览</span>
                  <div className="summary-grid">
                    <div><strong>{dailyNew}</strong><span>每日新词</span></div>
                    <div><strong>{selectedGoal?.label || '待选择'}</strong><span>学习目标</span></div>
                    <div><strong>{selectedLevel?.label || '待选择'}</strong><span>当前水平</span></div>
                    <div><strong>{reminderTime}</strong><span>提醒时间</span></div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="onboarding-actions">
            <button type="button" className="btn btn-text" onClick={() => move(-1)} disabled={step === 0}>
              <Icon name="chevronLeft" size={18} />
              上一步
            </button>
            {step < STEPS.length - 1 ? (
              <button type="button" className="btn btn-primary" onClick={() => move(1)} disabled={!canNext}>
                继续
                <Icon name="arrowRight" size={18} />
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={finish}>
                进入 WordVault
                <Icon name="arrowRight" size={18} />
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
