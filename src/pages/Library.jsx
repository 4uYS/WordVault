import { useMemo, useState } from 'react'
import { useApp } from '../AppContext'
import { BOOKS, STATUS_META } from '../lib/constants'
import { Icon } from '../components/Icons'

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'new', label: '未学习' },
  { id: 'learning', label: '学习中' },
  { id: 'known', label: '已掌握' },
  { id: 'favorite', label: '收藏' },
  { id: 'wrong', label: '错词' },
]

export default function Library({ navigate, openWord }) {
  const { state, dispatch, dict } = useApp()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [limit, setLimit] = useState(60)
  const currentBookId = state.settings.bookId
  const currentBook = BOOKS.find((b) => b.id === currentBookId) || BOOKS[0]
  const indexWords = dict.indexWords || []

  const bookWords = useMemo(
    () => indexWords.filter((w) => w.b.includes(currentBookId)),
    [indexWords, currentBookId],
  )

  const bookCounts = useMemo(() => {
    const counts = { known: 0, learning: 0, favorite: 0, wrong: 0 }
    for (const w of bookWords) {
      const r = state.wordStates[w.w]
      if (!r) continue
      if (r.status === 'known') counts.known++
      else counts.learning++
      if (r.favorite) counts.favorite++
      if (r.wrongFlag) counts.wrong++
    }
    return counts
  }, [bookWords, state.wordStates])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return bookWords.filter((w) => {
      if (q && !w.w.toLowerCase().includes(q) && !(w.c || '').toLowerCase().includes(q)) return false
      const r = state.wordStates[w.w]
      if (filter === 'new') return !r
      if (filter === 'learning') return r && r.status !== 'known'
      if (filter === 'known') return r?.status === 'known'
      if (filter === 'favorite') return Boolean(r?.favorite)
      if (filter === 'wrong') return Boolean(r?.wrongFlag)
      return true
    })
  }, [bookWords, query, filter, state.wordStates])

  const visible = filtered.slice(0, limit)

  const changeBook = (id) => {
    dispatch({ type: 'UPDATE_SETTINGS', patch: { bookId: id } })
    setLimit(60)
    setQuery('')
    setFilter('all')
  }

  const progress = bookWords.length ? Math.round((bookCounts.known / bookWords.length) * 100) : 0

  return (
    <div className="page library-page">
      <header className="page-intro">
        <div>
          <span className="eyebrow">内置词库</span>
          <h1>挑一本适合你的词书</h1>
          <p>完整离线词库，按目标切换。学习进度与掌握状态会分别记录。</p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('study')}>
          <Icon name="play" size={17} />
          开始学习
        </button>
      </header>

      <div className="book-switcher" role="tablist" aria-label="词书选择">
        {BOOKS.map((book) => {
          const active = book.id === currentBookId
          const count = indexWords.filter((w) => w.b.includes(book.id)).length
          return (
            <button
              key={book.id}
              role="tab"
              aria-selected={active}
              className={`book-tab ${active ? 'active' : ''}`}
              onClick={() => changeBook(book.id)}
              style={{ '--book-color': book.color }}
            >
              <span className="book-tab-top">
                <em>{book.short}</em>
                <span>{count}</span>
              </span>
              <strong>{book.name}</strong>
              <span className="book-tab-bar"><i style={{ width: active ? `${Math.max(4, progress)}%` : '0%' }} /></span>
            </button>
          )
        })}
      </div>

      <section className="panel book-overview">
        <div className="book-overview-main">
          <span className="book-chip large" style={{ borderColor: currentBook.color, color: currentBook.color }}>{currentBook.short}</span>
          <div>
            <h2>{currentBook.name}</h2>
            <p>{currentBook.desc}，共 {bookWords.length} 个词条，已掌握 {bookCounts.known} 个。</p>
          </div>
        </div>
        <div className="book-overview-progress">
          <div className="progress-meta">
            <span>掌握进度</span>
            <strong>{progress}%</strong>
          </div>
          <div className="progress-bar">
            <span style={{ width: `${progress}%`, background: currentBook.color }} />
          </div>
          <div className="book-overview-tags">
            <span>学习中 {bookCounts.learning}</span>
            <span>收藏 {bookCounts.favorite}</span>
            <span>错词 {bookCounts.wrong}</span>
          </div>
        </div>
      </section>

      <section className="word-browser">
        <div className="browser-toolbar">
          <div className="search-field compact-search">
            <Icon name="search" size={19} />
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setLimit(60) }}
              placeholder={`在 ${currentBook.name} 中搜索`}
              aria-label="在当前词书中搜索"
            />
            {query && (
              <button className="field-clear" onClick={() => setQuery('')} aria-label="清空搜索">
                <Icon name="close" size={16} />
              </button>
            )}
          </div>
          <div className="filter-tabs">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                className={`filter-tab ${filter === f.id ? 'active' : ''}`}
                onClick={() => { setFilter(f.id); setLimit(60) }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {!dict.indexReady ? (
          <div className="loading-panel">
            <span className="spinner" />
            <p>正在读取本地词库索引</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty-panel">
            <Icon name="search" size={26} />
            <h3>没有符合条件的单词</h3>
            <p>换一个关键词或筛选条件试试。</p>
          </div>
        ) : (
          <>
            <div className="word-list">
              {visible.map((w, index) => {
                const record = state.wordStates[w.w]
                const status = record?.status || 'new'
                return (
                  <button key={w.w} className="word-row" onClick={() => openWord(w.w)}>
                    <span className="word-order">{String(index + 1).padStart(2, '0')}</span>
                    <span className="word-cell">
                      <span className="word-cell-top">
                        <strong>{w.w}</strong>
                        {w.uk && <em>/{w.uk}/</em>}
                        {record?.favorite && <Icon name="bookmarkFilled" size={14} className="favorite-mark" />}
                      </span>
                      <span className="word-meaning">
                        {w.p && <i>{w.p}</i>}
                        {w.c || '暂无释义'}
                      </span>
                    </span>
                    <span className={`status-pill ${status === 'new' ? 'muted' : STATUS_META[status]?.tone || 'primary'}`}>
                      {status === 'new' ? '未学习' : STATUS_META[status]?.label}
                    </span>
                    <Icon name="chevronRight" size={17} className="row-arrow" />
                  </button>
                )
              })}
            </div>
            {visible.length < filtered.length && (
              <button className="btn btn-outlined load-more" onClick={() => setLimit((n) => n + 80)}>
                加载更多
                <span>{visible.length} / {filtered.length}</span>
              </button>
            )}
          </>
        )}
      </section>
    </div>
  )
}
