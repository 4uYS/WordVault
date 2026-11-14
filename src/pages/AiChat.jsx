import { useEffect, useRef, useState } from 'react'
import { useApp } from '../AppContext'
import { useUI } from '../UIContext'
import { activeAiProvider } from '../lib/constants'
import { lookupBasic } from '../lib/dict'
import { RichMarkdown, StreamingText } from '../components/RichText'
import {
  buildChatMessages,
  buildLookupMessages,
  parseAgentReply,
  cancelGeneration,
  generate,
  onlineSupported,
} from '../lib/llm'
import {
  validateActions,
  executeTools,
  buildContextBlock,
  buildLookupContextBlock,
} from '../lib/agentTools'
import { Icon } from '../components/Icons'

const SUGGESTIONS = [
  'affect 和 effect 怎么区分',
  '我还有多少词要复习',
  '查一下 abandon 我背得怎么样',
  '把昵称改成「小词」',
]

// 对话里说「补录 / 加入词书」时，直接用专用补录提示词，
// 否则模型只看到「entry 结构见缺词补录提示词」却拿不到模板，常常只反问不产出指令。
const UPSERT_INTENT = /(补录|收录|加入词书|加进词书|加到词书|收进词书|加(到|进|入)?词(书|库)|添加(到|进)?词(书|库)|存(到|进|入)?词(书|库)|放进词书)/
const INTENT_STOP = new Set([
  'word', 'words', 'book', 'books', 'dictionary', 'please', 'help', 'this', 'that',
  'into', 'about', 'with', 'from', 'what', 'which', 'english', 'wordvault', 'lookup',
  'search', 'custom', 'define', 'definition', 'example', 'quiz', 'study', 'review',
  'offline', 'local', 'longest', 'meaning', 'means', 'nickname', 'vault', 'titin',
])

function pickUpsertWord(question, history) {
  const texts = [question, ...history.slice(-6).map((m) => m.content || '')]
  const candidates = []
  for (const text of texts) {
    for (const match of String(text).matchAll(/[A-Za-z][A-Za-z'\-]{3,}/g)) {
      const word = match[0].toLowerCase().replace(/’/g, "'")
      if (INTENT_STOP.has(word) || word.length > 64) continue
      candidates.push(word)
    }
  }
  // 长词优先：用户指的多半是刚刚讨论过的那个词
  candidates.sort((a, b) => b.length - a.length)
  return candidates.find((word) => /^[a-z][a-z' -]*$/.test(word) && !lookupBasic(word)) || ''
}

export default function AiChat({ navigate }) {
  const { state, dispatch, stats, dict } = useApp()
  const ui = useUI()
  const settings = state.settings
  const provider = activeAiProvider(settings)
  const [messages, setMessages] = useState(() => state.ai?.chat || [])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const scrollRef = useRef(null)
  const stickToBottom = useRef(true)
  const lookupDone = useRef(false)

  const supported = onlineSupported()
  const ready = supported

  const ctx = { state, dispatch, stats, dict, ui, provider }

  useEffect(() => {
    if (!stickToBottom.current) return
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages])

  const persist = (list) => {
    dispatch({ type: 'AI_SET_CHAT', messages: list })
  }

  /**
   * 两阶段协议：
   * 第一轮 AI 若只给只读指令，宿主自动执行后把 [工具结果] 回灌，让 AI 给最终答复；
   * 若含写操作，则停下渲染确认卡片，绝不自动落库。
   */
  const agentRound = async (initialMessages, onStream) => {
    let aiMessages = initialMessages
    let usedLookupFallback = false
    for (let round = 0; round < 3; round += 1) {
      const raw = await generate({
        messages: aiMessages,
        // 补录指令带完整词条 JSON，700 容易被截断成非法 JSON
        maxTokens: 1200,
        temperature: 0.25,
        base: provider?.base,
        model: provider?.model,
        apiKey: provider?.key,
        // 沿用原版逐字吐出的流式回调，把增量实时交给气泡渲染
        onToken: (_delta, full) => onStream?.(full),
      })
      const parsed = parseAgentReply(raw)
      if (parsed.kind !== 'agent') {
        return { text: raw, actions: [], results: '' }
      }
      const checked = validateActions(parsed.actions, { currentBookId: state.settings?.bookId })
      if (!checked.ok) {
        // 模型想补录但指令不合规时，不直接放弃：换专用补录提示词再生成一次
        const upsertWord = parsed.actions.find((a) => a?.tool === 'word.upsert')?.args?.word
        if (upsertWord && !usedLookupFallback) {
          usedLookupFallback = true
          aiMessages = buildLookupMessages(
            buildLookupContextBlock(upsertWord, state, dict)
            + '用户已明确要求补录，请直接输出 word.upsert 指令。',
          )
          continue
        }
        return {
          text: `${parsed.reply}\n\n> 操作已被拦截：${checked.error}`,
          actions: [],
          results: '',
        }
      }
      const auto = checked.actions.filter((a) => a.risk === 'L0' || a.risk === 'L1')
      const pending = checked.actions.filter((a) => a.risk === 'L2' || a.risk === 'L3')
      const exec = auto.length ? await executeTools(auto, ctx) : { results: [] }
      const results = exec.results.join('\n')
      // 只有 L0 只读查询才需要把结果回灌给 AI 组织答案；
      // 纯 L1（朗读 / 跳转 / 主题 / 通知）执行完直接收尾，避免多一次请求又吐乱格式。
      const needsRefeed = auto.some((a) => a.risk === 'L0')
      if (pending.length || !results || !needsRefeed || round === 2) {
        return { text: parsed.reply || parsed.stray, actions: pending, results }
      }
      aiMessages = [
        ...aiMessages,
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content: `[工具结果]\n${results}\n\n请基于以上结果给出最终答复；不要重复已执行过的只读工具。若仍需写操作，输出含 L2/L3 工具的 JSON。`,
        },
      ]
    }
    return { text: '暂时没有拿到结果，请再试一次。', actions: [], results: '' }
  }

  const runTurn = async (displayQuestion, aiMessages) => {
    const history = messages
    const userTurn = { role: 'user', content: displayQuestion }
    setMessages([...history, userTurn, { role: 'assistant', content: '' }])
    setDraft('')
    setError('')
    setBusy(true)
    stickToBottom.current = true
    // 与原版一致：每个 token 都更新最后一条 assistant 气泡；
    // streaming 标记让渲染层知道这是尚未落定的增量文本。
    const onStream = (full) => {
      setMessages([...history, userTurn, {
        role: 'assistant', content: full, streaming: true,
      }])
    }
    try {
      const result = await agentRound(aiMessages, onStream)
      const assistant = {
        role: 'assistant',
        content: result.text || '（无回复）',
        ...(result.actions?.length ? { actions: result.actions } : {}),
        ...(result.results ? { toolResults: result.results } : {}),
      }
      const finalMessages = [...history, userTurn, assistant]
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

  const canStart = () => {
    if (busy) return false
    if (!ready) {
      setError('在线 AI 暂不可用，请检查网络')
      return false
    }
    if (provider?.id === 'deepseek' && !provider.key) {
      setError('请先在「我的 → AI 提供方」填写 DeepSeek API Key')
      return false
    }
    return true
  }

  const send = async (raw) => {
    const question = raw.trim()
    if (!question || !canStart()) return
    const upsertWord = UPSERT_INTENT.test(question) ? pickUpsertWord(question, messages) : ''
    const aiMessages = upsertWord
      ? buildLookupMessages(
        buildLookupContextBlock(upsertWord, state, dict)
        + `用户原话：${question}\n用户已明确要求补录，请直接输出 word.upsert 指令。`,
      )
      : buildChatMessages(
        messages.map((m) => ({ role: m.role, content: m.content })),
        buildContextBlock(state, stats, dict) + question,
      )
    await runTurn(question, aiMessages)
  }

  // 查词页「让 AI 补录」会跳到 #/ai?lookup=xxx，进入后自动发起补录
  useEffect(() => {
    if (lookupDone.current) return
    const match = window.location.hash.match(/[?&]lookup=([^&]+)/)
    if (!match) return
    lookupDone.current = true
    const word = decodeURIComponent(match[1]).trim().toLowerCase()
    if (!word || !ready || (provider?.id === 'deepseek' && !provider.key)) return
    const question = `查不到「${word}」，请补录到词书`
    runTurn(question, buildLookupMessages(buildLookupContextBlock(word, state, dict)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const confirmActions = async (index, actions) => {
    if (busy) return
    setBusy(true)
    try {
      const exec = await executeTools(actions, ctx)
      const text = exec.results.length ? exec.results.join('\n') : '无执行结果'
      const next = messages.map((m, i) => (i === index
        ? { ...m, actionsDone: true, execResult: text, execFailed: exec.errors.length > 0 }
        : m))
      setMessages(next)
      persist(next)
      ui?.showToast?.(exec.errors.length ? '部分操作未成功，请查看结果' : '操作已执行')
      if (!exec.errors.length) {
        const up = actions.find((a) => a.tool === 'word.upsert' || a.tool === 'word.patch')
        if (up) ui?.openWord?.(up.args.word)
      }
    } catch (err) {
      setError(err.message || '执行失败')
    } finally {
      setBusy(false)
    }
  }

  const ignoreActions = (index) => {
    const next = messages.map((m, i) => (i === index
      ? { ...m, actionsDone: true, execResult: '已忽略' }
      : m))
    setMessages(next)
    persist(next)
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
            对话已保存在本机 · 写操作需你确认
          </span>
          <button className="btn btn-text small" onClick={clearChat} disabled={busy}>清空对话</button>
        </div>
      )}

      <div className="ai-thread" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <div className="ai-welcome">
            <Icon name="spark" size={26} />
            <h2>想弄懂哪个词？</h2>
            <p>可以问释义、搭配与记忆方法，也能让我查学习数据、补录生词、改昵称或切换词书。所有写操作都会先给你确认。</p>
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
              <>
                {(() => {
                  // 指令协议输出的是 JSON，流式阶段不把碎片糊在气泡里，
                  // 但仍保留逐字传输：增量实时落在「实时输出」折叠区。
                  const draftJson = message.streaming
                    && (
                      /^\s*(?:```(?:json)?\s*)?\{/.test(message.content || '')
                      || /"(?:actions|reply)"\s*:/.test(message.content || '')
                    )
                  if (!message.content) {
                    return <p className="ai-thinking">{busy ? '正在思考…' : ''}</p>
                  }
                  if (draftJson) {
                    return (
                      <>
                        <p className="ai-thinking">正在生成操作指令…</p>
                        <details className="ai-output">
                          <summary className="setting-label">实时输出</summary>
                          <pre>{message.content}</pre>
                        </details>
                      </>
                    )
                  }
                  return busy && index === messages.length - 1
                    ? <StreamingText text={message.content} />
                    : <RichMarkdown text={message.content} />
                })()}

                {message.toolResults && (
                  <details className="ai-output">
                    <summary className="setting-label">查询结果</summary>
                    <pre>{message.toolResults}</pre>
                  </details>
                )}

                {message.actions?.length > 0 && (
                  <>
                    <div className="section-head compact">
                      <div>
                        <span className="setting-label">待确认操作</span>
                        <span className="tiny-note">{message.actions.length} 项 · 确认后才会生效</span>
                      </div>
                      <span className="data-size">需你确认</span>
                    </div>

                    {message.actions.map((action, i) => (
                      <div className="ai-quiz-entry" key={i}>
                        <div>
                          <strong>{action.tool}</strong>
                          <span>{action.confirm}</span>
                          {action.reason && <p className="ai-explain">依据：{action.reason}</p>}
                        </div>
                        <div className="ai-quiz-actions">
                          <span className={`word-chip static ${action.risk === 'L3' ? 'danger' : ''}`}>
                            {action.risk || 'L2'}
                          </span>
                        </div>
                      </div>
                    ))}

                    {message.actionsDone ? (
                      <div className="ai-output">
                        <p className={message.execFailed ? 'ai-error' : 'ai-explain'}>
                          <Icon name="check" size={14} />
                          {message.execFailed ? '部分操作未成功' : '执行结果'}
                        </p>
                        <pre>{message.execResult || '已处理'}</pre>
                      </div>
                    ) : (
                      <div className="ai-actions">
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={busy}
                          onClick={() => confirmActions(index, message.actions)}
                        >确认执行</button>
                        <button
                          className="btn btn-text btn-sm"
                          disabled={busy}
                          onClick={() => ignoreActions(index)}
                        >忽略</button>
                      </div>
                    )}
                  </>
                )}
              </>
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
          placeholder="问单词，或让我改设置 / 补录词条"
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
