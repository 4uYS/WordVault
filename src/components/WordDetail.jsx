import { useEffect, useState } from 'react'
import { useApp } from '../AppContext'
import { useUI } from '../UIContext'
import { BOOK_MAP, SOURCE_NOTE, STATUS_META } from '../lib/constants'
import { lookupFull } from '../lib/dict'
import { speak } from '../lib/speech'
import { nextReviewLabel } from '../lib/sm2'
import { Icon } from './Icons'
import AiAssistant from './AiAssistant'

const STATUS_OPTIONS = [
  { id: 'unknown', label: '完全陌生' },
  { id: 'familiar', label: '不熟悉' },
  { id: 'known', label: '已掌握' },
]

function play(text, accent) {
  speak(text, accent)
}

export default function WordDetail({ word, onClose }) {
  const { state, dispatch, dict } = useApp()
  const { showToast, openWord } = useUI()
  const [loading, setLoading] = useState(!dict.fullReady)
  const full = lookupFull(word)
  const basic = dict.lookupBasic(word)
  const record = state.wordStates[full?.w || word]
  const data = full || {
    w: word,
    uk: basic?.uk || '',
    us: basic?.us || '',
    tr: basic?.c ? [{ p: basic.p, c: basic.c, e: '' }] : [],
    ex: [],
    ph: [],
    syn: [],
    syno: [],
    ant: [],
    fam: [],
    root: '',
    books: basic?.b || [],
  }

  useEffect(() => {
    if (!dict.fullReady) {
      setLoading(true)
      dict.ensureFullDict().finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
  }, [dict.fullReady, dict.ensureFullDict])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  const toggleFavorite = () => {
    dispatch({ type: 'TOGGLE_FAVORITE', word: data.w })
    showToast(record?.favorite ? '已取消收藏' : '已收藏并纳入复习计划')
  }

  const mark = (status) => {
    dispatch({ type: 'SET_STATUS', word: data.w, status })
    showToast(`已标记为${STATUS_META[status]?.label}`)
  }

  const pronounce = (accent) => {
    play(data.w, accent)
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <article className="word-detail" role="dialog" aria-modal="true" aria-label={`${data.w} 释义`}>
        <header className="detail-header">
          <div className="detail-heading">
            <span className="eyebrow">词条详情</span>
            <h1>{data.w}</h1>
            <div className="detail-phonetics">
              <button className="phonetic-play" onClick={() => pronounce('uk')} disabled={!data.uk}>
                <span>英</span>
                <em>/{data.uk || '—'}/</em>
                <Icon name="volumeSmall" size={16} />
              </button>
              <button className="phonetic-play" onClick={() => pronounce('us')} disabled={!data.us}>
                <span>美</span>
                <em>/{data.us || '—'}/</em>
                <Icon name="volumeSmall" size={16} />
              </button>
            </div>
          </div>
          <div className="detail-actions">
            <button className={`btn ${record?.favorite ? 'btn-primary' : 'btn-outlined'}`} onClick={toggleFavorite}>
              <Icon name={record?.favorite ? 'bookmarkFilled' : 'bookmark'} size={17} />
              {record?.favorite ? '已收藏' : '收藏'}
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="关闭详情">
              <Icon name="close" size={21} />
            </button>
          </div>
        </header>

        <div className="detail-meta-row">
          <span className={`status-pill ${STATUS_META[record?.status]?.tone || 'muted'}`}>
            {STATUS_META[record?.status]?.label || '未学习'}
          </span>
          <span className="meta-item"><Icon name="clock" size={14} /> {nextReviewLabel(record)}</span>
          <span className="meta-item"><Icon name="book" size={14} /> {data.books?.map((b) => BOOK_MAP[b]?.short).filter(Boolean).join(' / ') || '本地词库'}</span>
          {record?.wrongCount > 0 && <span className="meta-item danger"><Icon name="alert" size={14} /> 答错 {record.wrongCount} 次</span>}
        </div>

        <div className="detail-body">
          {loading && !full ? (
            <div className="loading-inline">
              <span className="spinner" />
              <span>正在读取完整词条</span>
            </div>
          ) : null}

          <section className="detail-section">
            <h2>释义</h2>
            <div className="trans-list">
              {data.tr.length ? data.tr.map((t, i) => (
                <div className="trans-row" key={`${t.p}-${i}`}>
                  {t.p && <span className="pos-badge">{t.p}</span>}
                  <div>
                    <p>{t.c || '暂无中文释义'}</p>
                    {t.e && <span className="en-def">{t.e}</span>}
                  </div>
                </div>
              )) : <p className="muted-text">暂无释义</p>}
            </div>
          </section>

          {data.ex.length > 0 && (
            <section className="detail-section">
              <h2>例句</h2>
              <div className="example-list">
                {data.ex.map((ex, i) => (
                  <div className="example-row" key={i}>
                    <button className="example-play" onClick={() => play(ex.en, state.settings.accent)} aria-label="朗读例句">
                      <Icon name="volumeSmall" size={16} />
                    </button>
                    <div>
                      <p>{ex.en}</p>
                      <span>{ex.cn}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {data.ph.length > 0 && (
            <section className="detail-section">
              <h2>常见搭配</h2>
              <div className="phrase-grid">
                {data.ph.map((p, i) => (
                  <div className="phrase-row" key={i}>
                    <strong>{p.en}</strong>
                    <span>{p.cn}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="detail-columns">
            {data.syn.length > 0 && (
              <section className="detail-section">
                <h2>同义词</h2>
                <div className="word-chips">
                  {data.syn.map((s) => (
                    <button key={s} className="word-chip" onClick={() => openWord(s)}>{s}</button>
                  ))}
                </div>
              </section>
            )}

            {data.ant.length > 0 && (
              <section className="detail-section">
                <h2>反义词</h2>
                <div className="word-chips">
                  {data.ant.map((s) => (
                    <button key={s} className="word-chip danger" onClick={() => openWord(s)}>{s}</button>
                  ))}
                </div>
              </section>
            )}
          </div>

          {data.fam.length > 0 && (
            <section className="detail-section">
              <h2>同根词族</h2>
              <div className="family-list">
                {data.fam.map((group, i) => (
                  <div className="family-row" key={i}>
                    {group.p && <span className="pos-badge">{group.p}</span>}
                    <div className="word-chips">
                      {group.words.map((w) => (
                        <button key={w.w} className="word-chip" onClick={() => openWord(w.w)}>
                          {w.w}
                          {w.t && <em>{w.t}</em>}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {data.root && (
            <section className="detail-section mnemonic-section">
              <h2>词根词缀与助记</h2>
              <p className="mnemonic-text">{data.root}</p>
            </section>
          )}

          <AiAssistant entry={data} />

          <section className="detail-section manual-section">
            <h2>掌握程度</h2>
            <p className="section-help">手动标记会同步影响错词本与下一次复习安排。</p>
            <div className="status-options">
              {STATUS_OPTIONS.map((s) => (
                <button
                  key={s.id}
                  className={`status-option ${record?.status === s.id ? 'active' : ''}`}
                  onClick={() => mark(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </section>

          <footer className="detail-source">
            <Icon name="database" size={15} />
            <span>{SOURCE_NOTE}</span>
          </footer>
        </div>
      </article>
    </div>
  )
}
