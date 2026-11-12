import { useEffect, useState } from 'react'
import { useApp } from '../AppContext'
import { activeAiProvider } from '../lib/constants'
import {
  buildExampleMessages,
  buildExplainMessages,
  cancelGeneration,
  generate,
} from '../lib/llm'
import { Icon } from './Icons'
import { RichMarkdown, StreamingText } from './RichText'

const MODES = [
  { id: 'example', label: 'AI 例句', icon: 'pen' },
  { id: 'explain', label: 'AI 精讲', icon: 'spark' },
]

function formatSavedAt(at) {
  if (!at) return ''
  const d = new Date(at)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function pickSavedMode(record) {
  if (!record) return ''
  if (record.explain && record.example) {
    return record.explain.at >= record.example.at ? 'explain' : 'example'
  }
  return record.explain ? 'explain' : record.example ? 'example' : ''
}

export default function AiAssistant({ entry }) {
  const { state, dispatch } = useApp()
  const settings = state.settings
  const provider = activeAiProvider(settings)
  const [mode, setMode] = useState('')
  const [text, setText] = useState('')
  const [savedAt, setSavedAt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    // 切换词条时恢复这个词已保存的 AI 内容
    const record = state.ai?.entries?.[entry?.w]
    const savedMode = pickSavedMode(record)
    setMode(savedMode)
    setText(savedMode ? record[savedMode].text : '')
    setSavedAt(savedMode ? record[savedMode].at : 0)
    setError('')
    setBusy(false)
  }, [entry?.w])

  const run = async (nextMode) => {
    if (busy) return
    if (!entry?.w) return
    setMode(nextMode)
    setText('')
    setSavedAt(0)
    setError('')
    setBusy(true)
    try {
      const messages = nextMode === 'example'
        ? buildExampleMessages(entry)
        : buildExplainMessages(entry)
      const output = await generate({
        messages,
        maxTokens: nextMode === 'example' ? 360 : 400,
        temperature: 0.6,
        base: provider?.base,
        model: provider?.model,
        apiKey: provider?.key,
        onToken: (_delta, full) => setText(full),
      })
      setText(output)
      const at = Date.now()
      setSavedAt(at)
      dispatch({ type: 'AI_SAVE_ENTRY', word: entry.w, mode: nextMode, text: output })
    } catch (err) {
      setError(err.message || '生成失败')
    } finally {
      setBusy(false)
    }
  }

  const clearSaved = () => {
    if (!entry?.w || !mode) return
    dispatch({ type: 'AI_CLEAR_ENTRY', word: entry.w, mode })
    setMode('')
    setText('')
    setSavedAt(0)
    setError('')
  }

  return (
    <section className="detail-section ai-section">
      <div className="ai-head">
        <h2>AI 学习助手</h2>
        <span className="data-size">{savedAt ? '已保存' : '在线 AI'}</span>
        {busy && (
          <button className="ai-stop" onClick={cancelGeneration}>
            停止
          </button>
        )}
      </div>

      <div className="ai-actions">
        {MODES.map((item) => (
          <button
            key={item.id}
            className={`btn ${mode === item.id ? 'btn-primary' : 'btn-outlined'} btn-sm`}
            onClick={() => run(item.id)}
            disabled={busy}
          >
            <Icon name={item.icon} size={16} />
            {savedAt && mode === item.id ? '重新生成' : item.label}
          </button>
        ))}
        {savedAt && !busy && (
          <button className="btn btn-text btn-sm" onClick={clearSaved}>
            清除结果
          </button>
        )}
      </div>

      {error && <p className="ai-error">{error}</p>}

      {(text || busy) && (
        <div className="ai-output" aria-live="polite">
          {text ? (
            busy ? <StreamingText text={text} /> : <RichMarkdown text={text} />
          ) : (
            <p className="ai-thinking">正在生成…</p>
          )}
          {!busy && savedAt ? (
            <p className="ai-saved-note">已保存在本机 · {formatSavedAt(savedAt)}</p>
          ) : null}
        </div>
      )}
    </section>
  )
}
