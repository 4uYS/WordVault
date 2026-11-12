import { useMemo, useState } from 'react'
import { useApp } from '../AppContext'
import { useUI } from '../UIContext'
import { BOOK_MAP, STATUS_META } from '../lib/constants'
import { nextReviewLabel } from '../lib/sm2'
import { Icon } from '../components/Icons'

const FILTERS = [
  { id: 'all', label: '全部错词' },
  { id: 'unknown', label: '完全陌生' },
  { id: 'familiar', label: '不熟悉' },
]

export default function WrongBook({ navigate, openWord }) {
  const { state, dispatch, dict } = useApp()
  const { showToast } = useUI()
  const [filter, setFilter] = useState('all')

  const records = useMemo(() => {
    return Object.values(state.wordStates)
      .filter((r) => r.wrongFlag)
      .sort((a, b) => (b.lastReviewedAt || 0) - (a.lastReviewedAt || 0))
  }, [state.wordStates])

  const visible = records.filter((r) => filter === 'all' || r.status === filter)
  const unknownCount = records.filter((r) => r.status === 'unknown').length
  const familiarCount = records.filter((r) => r.status === 'familiar').length

  const markKnown = (word) => {
    dispatch({ type: 'SET_STATUS', word, status: 'known' })
    showToast('已标记为掌握，移出错词本')
  }

  const markFamiliar = (word) => {
    dispatch({ type: 'SET_STATUS', word, status: 'familiar' })
    showToast('已标记为不熟悉，保留在错词本')
  }

  return (
    <div className="focus-page wrong-page">
      <div className="focus-bar">
        <button className="icon-btn" onClick={() => navigate('home')} aria-label="返回"><Icon name="chevronLeft" size={22} /></button>
        <span className="focus-title">错词本</span>
        <span className="focus-progress">{records.length} 个待巩固</span>
      </div>

      <div className="wrong-head">
        <span className="eyebrow">自动收录 · 手动标记</span>
        <h1>把错误变成下一次的熟悉</h1>
        <p>答错的词会自动进入这里，并参与 SM-2 复习计划。标记为“已掌握”后会暂时移出。</p>
        <div className="wrong-summary">
          <div><strong>{records.length}</strong><span>待巩固</span></div>
          <div><strong>{unknownCount}</strong><span>完全陌生</span></div>
          <div><strong>{familiarCount}</strong><span>不熟悉</span></div>
          <div><strong>{records.filter((r) => r.due <= Date.now()).length}</strong><span>今日到期</span></div>
        </div>
      </div>

      <div className="wrong-toolbar">
        <div className="filter-tabs">
          {FILTERS.map((f) => (
            <button key={f.id} className={`filter-tab ${filter === f.id ? 'active' : ''}`} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <button className="btn btn-primary" onClick={() => navigate('practice/choice')}>
          <Icon name="shuffle" size={16} />
          去练习
        </button>
      </div>

      {visible.length === 0 ? (
        <div className="empty-panel wrong-empty">
          <span className="empty-icon"><Icon name="check" size={30} /></span>
          <h3>{records.length ? '这个分类下没有错词' : '错词本还是空的'}</h3>
          <p>{records.length ? '切换筛选条件查看其他错词。' : '学习或练习中答错的单词会自动出现在这里。'}</p>
          <button className="btn btn-outlined" onClick={() => navigate('practice/choice')}>开始专项练习</button>
        </div>
      ) : (
        <div className="wrong-list">
          {visible.map((record) => {
            const basic = dict.lookupBasic(record.word)
            const books = basic?.b?.map((b) => BOOK_MAP[b]?.short).filter(Boolean).join(' · ')
            return (
              <div className="wrong-row" key={record.word}>
                <button className="wrong-main" onClick={() => openWord(record.word)}>
                  <span className="wrong-word">
                    <strong>{record.word}</strong>
                    <span>
                      {basic?.uk ? `/${basic.uk}/` : ''}
                      {books ? ` · ${books}` : ''}
                    </span>
                  </span>
                  <span className="wrong-meaning">
                    {basic?.p && <i>{basic.p}</i>}
                    {basic?.c || '暂无释义'}
                  </span>
                  <span className={`status-pill ${STATUS_META[record.status]?.tone || 'muted'}`}>
                    {STATUS_META[record.status]?.label || '学习中'}
                  </span>
                </button>
                <div className="wrong-side">
                  <span className="wrong-count">错 {record.wrongCount} 次</span>
                  <span className="wrong-due">{nextReviewLabel(record)}</span>
                  <div className="wrong-actions">
                    <button className="btn btn-text" onClick={() => markFamiliar(record.word)}>仍不熟</button>
                    <button className="btn btn-outlined small" onClick={() => markKnown(record.word)}>已掌握</button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
