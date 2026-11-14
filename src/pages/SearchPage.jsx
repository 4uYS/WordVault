import { useMemo, useRef, useState } from 'react'
import { useApp } from '../AppContext'
import { BOOK_MAP } from '../lib/constants'
import { searchWords, suggestionsFor } from '../lib/dict'
import { Icon } from '../components/Icons'

function Highlight({ text, query }) {
  const q = query.trim()
  if (!q) return text
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  )
}

export default function SearchPage({ navigate, openWord }) {
  const { state, dispatch, dict } = useApp()
  const [query, setQuery] = useState('')
  const inputRef = useRef(null)
  const results = useMemo(() => searchWords(query, 40), [query, dict.indexReady])
  const suggestions = useMemo(
    () => suggestionsFor(state.settings.bookId, 8),
    [state.settings.bookId, dict.indexReady],
  )

  const commit = (term) => {
    if (term.trim()) dispatch({ type: 'ADD_SEARCH', term })
  }

  const open = (word) => {
    commit(query.trim() || word)
    openWord(word)
  }

  return (
    <div className="page search-page">
      <header className="page-intro search-intro">
        <div>
          <span className="eyebrow">本地查词</span>
          <h1>查一个词，随手收进宝箱</h1>
          <p>所有释义来自随应用分发的离线词库，不会发起任何第三方请求。</p>
        </div>
        <span className="offline-tag">
          <Icon name="lock" size={14} />
          离线可用
        </span>
      </header>

      <div className="search-hero">
        <form
          className="search-field big-search"
          onSubmit={(e) => { e.preventDefault(); if (results[0]) open(results[0].w); else commit(query) }}
        >
          <Icon name="search" size={22} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入英文单词或中文释义"
            aria-label="查词"
            autoComplete="off"
            spellCheck="false"
          />
          {query && (
            <button type="button" className="field-clear" onClick={() => { setQuery(''); inputRef.current?.focus() }} aria-label="清空">
              <Icon name="close" size={18} />
            </button>
          )}
          <button type="submit" className="btn btn-primary search-submit">查词</button>
        </form>
        <div className="search-hint-row">
          <span><Icon name="lock" size={13} /> 仅本地匹配</span>
          <span><Icon name="layers" size={13} /> 覆盖 {dict.indexWords?.length || 0} 个词条</span>
          <span><Icon name="eye" size={13} /> 选中任意英文即可取词</span>
        </div>
      </div>

      {query ? (
        <section className="search-results">
          <div className="results-head">
            <h2>{query.trim() ? `“${query.trim()}” 的结果` : '搜索结果'}</h2>
            <span>{results.length} 个匹配</span>
          </div>
          {!dict.indexReady ? (
            <div className="loading-panel"><span className="spinner" /><p>正在读取本地词库</p></div>
          ) : results.length === 0 ? (
            <div className="empty-panel">
              <Icon name="search" size={28} />
              <h3>本地词库中没有找到</h3>
              <p>试试只输入词根，或换一个中文关键词。当前词库不包含所有英语专有名词。</p>
              {/^[a-zA-Z][a-zA-Z'\- ]*$/.test(query.trim()) && (
                <div className="ai-actions">
                  <button
                    className="btn btn-outlined btn-sm"
                    onClick={() => navigate(`ai?lookup=${encodeURIComponent(query.trim().toLowerCase())}`)}
                  >
                    <Icon name="spark" size={16} />
                    让 AI 补录「{query.trim().toLowerCase()}」
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="result-list">
              {results.map((w) => (
                <button key={w.w} className="result-row" onClick={() => open(w.w)}>
                  <span className="result-word">
                    <strong><Highlight text={w.w} query={query} /></strong>
                    {w.uk && <em>/{w.uk}/</em>}
                  </span>
                  <span className="result-meaning">
                    {w.p && <i>{w.p}</i>}
                    <span>{w.c || '暂无释义'}</span>
                  </span>
                  <span className="result-books">
                    {w.b.slice(0, 2).map((b) => (
                      <i key={b} style={{ color: BOOK_MAP[b]?.color }}>{BOOK_MAP[b]?.short}</i>
                    ))}
                  </span>
                  <Icon name="chevronRight" size={16} />
                </button>
              ))}
            </div>
          )}
        </section>
      ) : (
        <>
          {state.searches.length > 0 && (
            <section className="panel history-panel">
              <div className="section-head compact">
                <div>
                  <span className="eyebrow">搜索历史</span>
                  <h2>最近查过</h2>
                </div>
                <button className="btn btn-text" onClick={() => dispatch({ type: 'CLEAR_SEARCH' })}>清空</button>
              </div>
              <div className="history-list">
                {state.searches.map((s) => (
                  <button key={s.term} className="history-item" onClick={() => setQuery(s.term)}>
                    <Icon name="clock" size={15} />
                    <span>{s.term}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="panel suggestion-panel">
            <div className="section-head compact">
              <div>
                <span className="eyebrow">随手一学</span>
                <h2>来自当前词书</h2>
              </div>
              <span className="tiny-note">{BOOK_MAP[state.settings.bookId]?.name}</span>
            </div>
            <div className="suggestion-grid">
              {suggestions.map((w) => (
                <button key={w.w} className="suggestion-card" onClick={() => open(w.w)}>
                  <strong>{w.w}</strong>
                  <span>/{w.uk}/</span>
                  <em>{w.c}</em>
                </button>
              ))}
            </div>
          </section>

          <section className="selection-demo panel">
            <div className="demo-head">
              <span className="eyebrow">长按选词</span>
              <h2>选中下方任意英文单词</h2>
            </div>
            <p>
              Reading builds a bridge between what you know and what you are learning. Try selecting
              any English word in this paragraph to see its local definition.
            </p>
            <p className="demo-cn">阅读会在已知与未知之间搭一座桥。用鼠标拖选或手机长按上面段落中的英文单词，即可弹出本地释义。</p>
          </section>
        </>
      )}
    </div>
  )
}
