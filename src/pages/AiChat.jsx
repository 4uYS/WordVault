import { useEffect, useRef, useState } from 'react'
import { useApp } from '../AppContext'
import { activeAiProvider } from '../lib/constants'
import { RichMarkdown, StreamingText } from '../components/RichText'
import {
  buildChatMessages,
  cancelGeneration,
  generate,
  onlineSupported,
} from '../lib/llm'
import { Icon } from '../components/Icons'

const SUGGESTIONS = [
  'affect 和 effect 怎么区分',
  '给 abandon 编一个记忆方法',
  'take on 有哪些常见含义',
  '帮我区分 adapt 和 adopt',
]

export default function AiChat({ navigate }) {
  const { state, dispatch } = useApp()
  const settings = state.settings
  const provider = activeAiProvider(settings)
  const [messages, setMessages] = useState(() => state.ai?.chat || [])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const scrollRef = useRef(null)
  const stickToBottom = useRef(true)

  const supported = onlineSupported()
  const ready = supported

  useEffect(() => {
    if (!stickToBottom.current) return
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages])

  const persist = (list) => {
    dispatch({ type: 'AI_SET_CHAT', messages: list })
  }

  const send = async (raw) => {
    const question = raw.trim()
    if (!question || busy) return
    if (!ready) {
      setError('在线 AI 暂不可用，请检查网络')
      return
    }
    if (provider?.id === 'deepseek' && !provider.key) {
      setError('请先在「我的 → AI 提供方」填写 DeepSeek API Key')
      return
    }
    const history = messages
    const userTurn = { role: 'user', content: question }
    const streaming = [...history, userTurn, { role: 'assistant', content: '' }]
    setMessages(streaming)
    setDraft('')
    setError('')
    setBusy(true)
    stickToBottom.current = true
    try {
      const answer = await generate({
        messages: buildChatMessages(history, question),
        maxTokens: 400,
        temperature: 0.7,
        base: provider?.base,
        model: provider?.model,
        apiKey: provider?.key,
        onToken: (_delta, full) => {
          setMessages([...history, userTurn, { role: 'assistant', content: full }])
        },
      })
      const finalMessages = [...history, userTurn, { role: 'assistant', content: answer }]
      setMessages(finalMessages)
      persist(finalMessages)
    } catch (err) {
      setError(err.message || '生成失败')
      const fallback = [...history, userTurn]
      setMessages(fallback)
      persist(fallback)
    } finally {
      setBusy(false)
    }
  }

  const clearChat = () => {
    if (busy) return
    if (!window.confirm('清空全部 AI 对话记录？')) return
    setMessages([])
    dispatch({ type: 'AI_CLEAR_CHAT' })
    setError('')
  }

  const onScroll = () => {
    const node = scrollRef.current
    if (!node) return
    stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
  }

  if (!supported) {
    return (
      <div className="ai-page">
        <div className="empty-card">
          <Icon name="spark" size={30} />
          <h2>AI 对话</h2>
          <p>当前环境不支持在线 AI，请检查浏览器或应用版本后重试。</p>
          <button className="btn btn-outlined" onClick={() => navigate('home')}>返回首页</button>
        </div>
      </div>
    )
  }

  return (
    <div className="ai-page">
      {messages.length > 0 && (
        <div className="ai-toolbar">
          <span className="ai-toolbar-note">
            <Icon name="lock" size={13} />
            对话已保存在本机
          </span>
          <button className="btn btn-text small" onClick={clearChat} disabled={busy}>清空对话</button>
        </div>
      )}

      <div className="ai-thread" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <div className="ai-welcome">
            <Icon name="spark" size={26} />
            <h2>想弄懂哪个词？</h2>
            <p>由在线 AI 回答，可问释义、搭配、辨析和记忆方法。对话会保存在本机，随时可以回看。</p>
            <div className="ai-suggestions">
              {SUGGESTIONS.map((item) => (
                <button key={item} className="word-chip" onClick={() => send(item)}>
                  {item}
                </button>
              ))}
            </div>
          </div>
        ) : messages.map((message, index) => (
          <div key={index} className={`ai-bubble ${message.role}`}>
            <span className="ai-role">{message.role === 'user' ? '我' : 'AI'}</span>
            {message.role === 'assistant' ? (
              message.content ? (
                busy && index === messages.length - 1 ? (
                  <StreamingText text={message.content} />
                ) : (
                  <RichMarkdown text={message.content} />
                )
              ) : (
                <p className="ai-thinking">{busy ? '正在思考…' : ''}</p>
              )
            ) : (
              <p>{message.content}</p>
            )}
          </div>
        ))}
        {error && <p className="ai-error">{error}</p>}
      </div>

      <form
        className="ai-composer"
        onSubmit={(event) => {
          event.preventDefault()
          send(draft)
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="输入单词或问题"
          disabled={!ready || busy}
        />
        {busy ? (
          <button type="button" className="btn btn-outlined" onClick={cancelGeneration}>停止</button>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={!ready || !draft.trim()}>
            发送
          </button>
        )}
      </form>
    </div>
  )
}
