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

/* ---------------- 执行过程：阅读式过程流 ---------------- */

const TOOL_LABELS = {
  'dict.lookup': '查词条', 'dict.search': '搜词库', 'dictionary.stats': '词库统计',
  'stats.get': '查学习统计', 'word.get': '查学习记录', 'word.list': '列单词',
  'book.list': '列词书', 'wrongbook.list': '查错词本', 'history.list': '查搜索历史',
  'profile.get': '读个人资料', 'settings.get': '读设置', 'ai.provider.list': '列 AI 提供方',
  'ai.entry.get': '读 AI 缓存', 'system.info': '查系统状态', 'quiz.generate': '出题',
  'example.generate': '生成例句', 'explain.generate': '生成精讲',
  'ui.navigate': '跳转页面', 'ui.openWord': '打开词条', 'speech.speak': '朗读',
  'speech.stop': '停止朗读', 'theme.toggle': '切换主题', 'notification.test': '测试通知',
  'notification.request': '请求通知权限', 'word.setStatus': '标记状态',
  'word.toggleFavorite': '切换收藏', 'word.answer': '记录评分', 'word.batchStatus': '批量标记',
  'wrongbook.remove': '移出错词本', 'word.clearAiCache': '清 AI 缓存',
  'search.clear': '清空搜索历史', 'chat.clear': '清空对话', 'profile.update': '改个人资料',
  'settings.update': '改设置', 'book.switch': '切换词书', 'font.set': '切换字体',
  'font.remove': '移除字体', 'ai.provider.switch': '切换 AI 提供方',
  'reminder.set': '设每日提醒', 'reminder.cancel': '取消提醒', 'backup.export': '导出备份',
  'word.upsert': '补录词条', 'word.patch': '修正释义', 'word.removeCustom': '删自建词条',
}

function toolLabel(tool) {
  return TOOL_LABELS[tool] || tool
}

function clip(text, max = 140) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 结构化动作清单：只记工具名 / 风险 / 是否需确认，不把原始 token 流写进历史 */
function describeActions(actions) {
  if (!actions?.length) return '无操作'
  return actions.map((a) => `${toolLabel(a.tool)}（${a.tool}）· ${a.risk} · ${a.confirm ? '需确认' : '自动执行'}`).join('\n')
}

/* ---------------- 平铺思考卡片：文档流内普通区块，无遮罩 / 浮层 ---------------- */

/** demo 同款自绘展开控件：圆形外框 + 上下两条折线，靠 opacity 切换，不做旋转 */
function Disclosure() {
  return (
    <svg className="disclosure" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="ring" cx="12" cy="12" r="10.1" />
      <path className="mark up" d="M8.1 13.5 L12 9.6 L15.9 13.5" />
      <path className="mark down" d="M8.1 10.5 L12 14.4 L15.9 10.5" />
    </svg>
  )
}

/** demo 图标库：云朵 / 拼图 / 代码 / 对勾 / 图片 / 工具 / 警告，全局挂一次 */
const SVG_DEFS = `<defs>
<g id="i-cloud" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
<path d="M6.4 17.2h10.4a3.7 3.7 0 0 0 .3-7.4A5.2 5.2 0 0 0 7.2 8.3 4.5 4.5 0 0 0 6.4 17.2Z"/>
<path d="M9.6 12.4a2.6 2.6 0 0 1 4.4-1.2M14 10.9v2.3h-2.3"/>
</g>
<g id="i-puzzle" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
<rect x="3.6" y="6" width="14.4" height="13" rx="2.2"/>
<path d="M8.6 6V4.5a1.6 1.6 0 0 1 3.2 0V6M18 12.2h1.5a1.6 1.6 0 0 1 0 3.2H18"/>
</g>
<g id="i-code" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
<rect x="3" y="4.2" width="18" height="15.6" rx="3"/>
<path d="m9.2 9.8-2.6 2.2 2.6 2.2m5.6-4.4 2.6 2.2-2.6 2.2"/>
</g>
<g id="i-check" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
<rect x="3" y="4.2" width="18" height="15.6" rx="3"/>
<path d="m7.4 12 3.1 3.1 6.1-6.2"/>
</g>
<g id="i-image" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
<rect x="3" y="4.5" width="18" height="15" rx="2.6"/>
<circle cx="8.4" cy="9.4" r="1.3"/>
<path d="m3.8 17.2 5-4.4 3.4 3 3.2-2.6 4.8 4"/>
</g>
<g id="i-tool" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
<path d="M3.5 7.5h17M3.5 12h17M3.5 16.5h17"/>
<circle cx="9" cy="7.5" r="2.1" fill="#fff"/>
<circle cx="15" cy="12" r="2.1" fill="#fff"/>
<circle cx="8" cy="16.5" r="2.1" fill="#fff"/>
</g>
<g id="i-alert" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
<circle cx="12" cy="12" r="9"/>
<path d="M12 7.6v5.2"/>
<circle cx="12" cy="16.4" r=".9" fill="currentColor" stroke="none"/>
</g>
</defs>`

function ThoughtDefs() {
  return (
    <svg
      width="0"
      height="0"
      style={{ position: 'absolute' }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: SVG_DEFS }}
    />
  )
}

function IconUse({ name }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true"><use href={`#i-${name}`} /></svg>
  )
}

/** 按步骤语义挑图标，贴近 demo 里「已加载技能 / 已执行代码 / 已完成查找」的区分 */
function pickIcon(kind, title) {
  if (kind === 'thought' || kind === 'event') return 'cloud'
  if (kind === 'error') return 'alert'
  if (kind === 'confirm') return 'tool'
  if (kind === 'narrative') return ''
  const t = String(title || '')
  if (/校验|拦截|执行|回灌|生成|拆出/.test(t)) return 'code'
  if (/加载|技能|提示词|换用/.test(t)) return 'puzzle'
  if (/补录|修正|删|改|设置|清空|导出|切换|标记|评分|提醒|朗读|跳转|通知/.test(t)) return 'code'
  if (/查|读|列|统计|记录|完成|查找|结果/.test(t)) return 'check'
  return 'tool'
}

/** 可折叠思考节点：云朵图标 + 标题 + 自绘展开控件，展开后是叙事段落 */
function FoldNode({ step }) {
  const [open, setOpen] = useState(true)
  const failed = step.status === 'failed'
  return (
    <>
      <button
        className={`fold-head ${failed ? 'failed' : ''}`}
        type="button"
        aria-expanded={String(open)}
        onClick={() => setOpen(!open)}
      >
        <IconUse name={failed ? 'alert' : (step.icon || 'cloud')} />
        <span>{step.title}</span>
        <Disclosure />
      </button>
      <div className={`fold-body ${open ? '' : 'collapsed'}`}>
        {step.note && <p className={failed ? 'error-text' : ''}>{step.note}</p>}
        {step.detail && (
          <details className="ai-output">
            <summary className="tiny-note">点击查看详情</summary>
            <pre>{step.detail}</pre>
          </details>
        )}
      </div>
    </>
  )
}

/** 一行灰调动作状态 + 「点击查看详情」下钻，对应 demo 的 .step / .bullet */
function ActionRow({ step }) {
  const [show, setShow] = useState(false)
  const failed = step.status === 'failed'
  return (
    <>
      <div className={`step ${failed ? 'failed' : 'done'}`}>
        <IconUse name={failed ? 'alert' : (step.icon || 'check')} />
        <span>{step.note || step.title}</span>
        {step.status === 'running' && <span>进行中</span>}
      </div>
      {step.detail && (
        <div className="bullet">
          <i />
          <span>{clip(step.title, 44)}</span>
          <button type="button" onClick={() => setShow(!show)}>点击查看详情</button>
          {show && (
            <pre className="ai-output" style={{ width: '100%', margin: '6px 0 12px' }}>
              {step.detail}
            </pre>
          )}
        </div>
      )}
    </>
  )
}

function renderThoughtStep(step) {
  if (step.kind === 'narrative') {
    return <p className="intro" key={step.id}>{step.note}</p>
  }
  if (step.kind === 'thought') return <FoldNode step={step} key={step.id} />
  if (step.kind === 'action' || step.kind === 'event' || step.kind === 'confirm') {
    return <ActionRow step={step} key={step.id} />
  }
  // 错误节点：默认展开 + 红字，绝不折进去看不见
  return (
    <FoldNode
      key={step.id}
      step={{ ...step, kind: 'thought', icon: 'alert', note: step.note || step.title }}
    />
  )
}

/** 平铺卡片：默认展开、可一键收起；运行中强制展开；答案留在卡片下方的文档流里 */
function ThoughtCard({ trace, running, failed, children }) {
  const [open, setOpen] = useState(true)
  useEffect(() => { if (running) setOpen(true) }, [running])
  if (!Array.isArray(trace) || !trace.length) return null
  const title = running ? '正在思考' : failed ? '执行遇到问题' : '已完成思考'
  return (
    <section className="thought-card">
      <button
        className="thought-head"
        type="button"
        aria-expanded={String(open)}
        onClick={() => setOpen(!open)}
      >
        <span className={failed ? 'error-text' : ''}>{title}</span>
        <Disclosure />
      </button>
      <div className={`thought-content ${open ? '' : 'collapsed'}`}>
        {trace.map(renderThoughtStep)}
        {children}
      </div>
    </section>
  )
}

/** 幂等增量更新：步骤按 id 定位，追加或替换，互不覆盖（Dify agent_thought 同款做法） */
function makeLedger(trace, renderTrace) {
  const started = new Map()
  let seq = 0
  return {
    add(kind, title, extra = {}) {
      const id = `s${++seq}`
      const at = Date.now()
      started.set(id, at)
      trace.push({
        id, kind, title, note: '', detail: '', status: 'running', ms: 0,
        icon: pickIcon(kind, title), ...extra,
      })
      renderTrace()
      return id
    },
    close(id, status, note, extra = {}) {
      const i = trace.findIndex((s) => s.id === id)
      if (i < 0) return
      trace[i] = {
        ...trace[i], status, note: note || trace[i].note,
        ms: Date.now() - (started.get(id) || Date.now()), ...extra,
      }
      renderTrace()
    },
    failAll(message) {
      for (let i = 0; i < trace.length; i += 1) {
        if (trace[i].status === 'running') {
          trace[i] = { ...trace[i], status: 'failed', note: '这一步未跑完' }
        }
      }
      trace.push({
        id: `s${++seq}`, kind: 'error', title: '任务中断',
        note: message || '已中止', detail: '', status: 'failed', ms: 0,
      })
      renderTrace()
    },
  }
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

  /** 只 merge 最后一条 assistant，不重建整条消息，避免流式把过程记录冲掉 */
  const patchAssistant = (patch) => {
    setMessages((prev) => {
      const next = prev.slice()
      const i = next.length - 1
      if (i < 0 || next[i]?.role !== 'assistant') return prev
      next[i] = { ...next[i], ...patch }
      return next
    })
  }

  /**
   * 两阶段协议 + 阅读式过程流：
   * 第一轮 AI 若只给只读指令，宿主自动执行后把 [工具结果] 回灌，让 AI 给最终答复；
   * 若含写操作，则停下渲染确认卡片，绝不自动落库。
   * 模型自己写的 reply 作为叙事段落收进过程流，宿主只补客观步骤，不伪造「内心独白」。
   */
  const agentRound = async (initialMessages, onStream, ledger) => {
    let aiMessages = initialMessages
    let usedLookupFallback = false
    let narratedReply = false
    for (let round = 0; round < 3; round += 1) {
      const thinkId = ledger.add('thought', round === 0 ? '理解问题，生成回复与操作' : '根据工具结果组织答复', {
        note: round === 0 ? '正在读取本机状态并生成回复…' : '正在基于上一步的结果整理答复…',
      })
      const raw = await generate({
        messages: aiMessages,
        // 补录指令带完整词条 JSON，700 容易被截断成非法 JSON
        maxTokens: 1200,
        temperature: 0.25,
        base: provider?.base,
        model: provider?.model,
        apiKey: provider?.key,
        // 沿用原版逐字吐出的流式回调，把增量实时交给气泡渲染
        onToken: (_delta, full) => onStream?.(round, full),
      })
      const parsed = parseAgentReply(raw)
      if (parsed.kind !== 'agent') {
        ledger.close(thinkId, 'done', '已生成普通文本回复，不需要调用任何工具。', { title: '直接作答' })
        return { text: raw, actions: [], results: '' }
      }

      const checked = validateActions(parsed.actions, { currentBookId: state.settings?.bookId })
      if (!checked.ok) {
        ledger.close(thinkId, 'failed', `指令校验未通过：${checked.error}`, { title: '指令校验未通过' })
        ledger.add('error', '操作已被拦截', { note: checked.error, status: 'failed' })
        // 模型想补录但指令不合规时，不直接放弃：换专用补录提示词再生成一次
        const upsertWord = parsed.actions.find((a) => a?.tool === 'word.upsert')?.args?.word
        if (upsertWord && !usedLookupFallback) {
          usedLookupFallback = true
          ledger.add('action', '换用补录专用提示词再试一次', {
            note: `补录「${upsertWord}」的指令没通过校验，我换一套更明确的写法重新生成。`,
            status: 'done', detail: `目标词：${upsertWord}`,
          })
          aiMessages = buildLookupMessages(
            buildLookupContextBlock(upsertWord, state, dict)
            + '用户已明确要求补录，请直接输出 word.upsert 指令。',
          )
          continue
        }
        return {
          text: `${parsed.reply}\n\n> 操作已被拦截：${checked.error}`,
          actions: [], results: '',
        }
      }

      ledger.close(thinkId, 'done', '回复里带了可执行的操作，我先把它们拆开看一遍。', {
        title: `已生成 ${checked.actions.length} 个操作`,
        detail: describeActions(checked.actions),
      })

      // 模型真实写下的过渡语，作为过程流里的叙事段落（不伪造思考）
      if (!narratedReply && parsed.reply?.trim()) {
        narratedReply = true
        ledger.add('narrative', 'AI 自述', {
          note: parsed.reply.trim(), status: 'done',
        })
      }
      ledger.add('thought', `拆出 ${checked.actions.length} 个操作`, {
        note: '先确认每一步要做什么、哪些可以自动执行、哪些必须等你点确认。',
        detail: describeActions(checked.actions),
        status: 'done',
      })

      const auto = checked.actions.filter((a) => a.risk === 'L0' || a.risk === 'L1')
      const pending = checked.actions.filter((a) => a.risk === 'L2' || a.risk === 'L3')

      let exec = { results: [], errors: [], outcomes: [] }
      if (auto.length) {
        const execId = ledger.add('action', '执行本机操作', {
          note: `正在执行 ${auto.length} 个操作：${auto.map((a) => toolLabel(a.tool)).join('、')}。`,
          detail: auto.map((a) => toolLabel(a.tool)).join('、'),
        })
        exec = await executeTools(auto, ctx)
        ledger.close(
          execId,
          exec.errors.length ? 'failed' : 'done',
          exec.errors.length
            ? `${exec.outcomes.length} 个操作里有 ${exec.errors.length} 个没成功。`
            : `${exec.outcomes.length} 个操作都已执行完毕。`,
          { title: exec.errors.length ? '部分操作没成功' : '操作执行完毕' },
        )
        // 每个外部动作一行「已 XXX」，结果挂在下钻里，不堆状态徽章
        for (const outcome of exec.outcomes) {
          ledger.add('action', toolLabel(outcome.tool), {
            note: `已${toolLabel(outcome.tool)}：${clip(outcome.text, 110)}`,
            detail: outcome.text,
            status: outcome.ok ? 'done' : 'failed',
            ms: outcome.ms,
          })
        }
      }
      const results = exec.results.join('\n')

      if (pending.length) {
        ledger.add('confirm', '等待你确认', {
          note: `有 ${pending.length} 项要改动本机数据，我先列出来等你确认，不会自己动手。`,
          detail: pending.map((a) => `${toolLabel(a.tool)}：${a.confirm}`).join('\n'),
          status: 'pending',
        })
        return { text: parsed.reply || parsed.stray, actions: pending, results }
      }

      // 只有 L0 只读查询才需要把结果回灌给 AI 组织答案；
      // 纯 L1（朗读 / 跳转 / 主题 / 通知）执行完直接收尾，避免多一次请求又吐乱格式。
      const needsRefeed = auto.some((a) => a.risk === 'L0')
      if (!results || !needsRefeed || round === 2) {
        return { text: parsed.reply || parsed.stray, actions: [], results }
      }
      ledger.add('thought', '结果已回灌，继续整理答复', {
        note: '查询到的结果已经交回给模型，让它基于真实数据说人话，而不是再猜一遍。',
        detail: results,
        status: 'done',
      })
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
    const turnStart = Date.now()
    // trace 是本轮的权威数据；渲染态只在渲染时同步，最后随消息一起持久化
    const trace = []
    const renderTrace = () => patchAssistant({ trace: [...trace] })
    const ledger = makeLedger(trace, renderTrace)

    setMessages([...history, userTurn, {
      role: 'assistant', content: '', streaming: true, phase: 'text', trace: [],
    }])
    setDraft('')
    setError('')
    setBusy(true)
    stickToBottom.current = true

    // 与原版一致：每个 token 都更新最后一条 assistant 气泡；
    // 指令 JSON 的增量收进「实时输出」，普通文本走逐字晕开，两者互不覆盖。
    const onStream = (_round, full) => {
      const jsonDraft = /^\s*(?:```(?:json)?\s*)?\{/.test(full)
        || /"(?:actions|reply)"\s*:/.test(full)
      patchAssistant({
        content: full,
        streaming: true,
        phase: jsonDraft ? 'json' : 'text',
      })
    }

    try {
      const result = await agentRound(aiMessages, onStream, ledger)
      const assistant = {
        role: 'assistant',
        content: result.text || '（无回复）',
        streaming: false,
        phase: null,
        trace: [...trace],
        traceMs: Date.now() - turnStart,
        ...(result.actions?.length ? { actions: result.actions } : {}),
        ...(result.results ? { toolResults: result.results } : {}),
      }
      const finalMessages = [...history, userTurn, assistant]
      setMessages(finalMessages)
      persist(finalMessages)
    } catch (err) {
      const message = err?.message || '生成失败'
      setError(message)
      // 出错/主动停止时保留气泡与已走过的步骤，不把过程抹掉
      ledger.failAll(message)
      const assistant = {
        role: 'assistant',
        content: '',
        errorText: message,
        streaming: false,
        phase: null,
        trace: [...trace],
        traceMs: Date.now() - turnStart,
      }
      const finalMessages = [...history, userTurn, assistant]
      setMessages(finalMessages)
      persist(finalMessages)
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
      const next = messages.map((m, i) => {
        if (i !== index) return m
        const trace = Array.isArray(m.trace)
          ? m.trace.map((s) => (s.status === 'pending'
            ? { ...s, status: exec.errors.length ? 'failed' : 'done', note: '你已确认，操作已执行。' }
            : s))
          : m.trace
        return {
          ...m, trace, actionsDone: true, execResult: text,
          execFailed: exec.errors.length > 0,
        }
      })
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
    const next = messages.map((m, i) => {
      if (i !== index) return m
      const trace = Array.isArray(m.trace)
        ? m.trace.map((s) => (s.status === 'pending'
          ? { ...s, status: 'done', note: '你选择了忽略，没有改动任何数据。' }
          : s))
        : m.trace
      return { ...m, trace, actionsDone: true, execResult: '已忽略' }
    })
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
      <ThoughtDefs />
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
                {/* 思考过程平铺在聊天文档流里，默认展开、可一键收起 */}
                <ThoughtCard
                  trace={message.trace}
                  running={Boolean(message.streaming)}
                  failed={(message.trace || []).some((s) => s.status === 'failed')}
                >
                  {message.streaming && message.phase === 'json' && message.content && (
                    <>
                      <p className="ai-thinking">正在生成操作指令…</p>
                      <details className="ai-output" open>
                        <summary className="tiny-note">实时输出</summary>
                        <pre>{message.content}</pre>
                      </details>
                    </>
                  )}
                </ThoughtCard>

                {message.errorText && <p className="ai-error">{message.errorText}</p>}

                <div className="thought-answer">
                  {(() => {
                    // 指令 JSON 的增量已收进上方卡片，这里不重复渲染
                    if (message.streaming && message.phase === 'json') return null
                    if (!message.content) {
                      return <p className="ai-thinking">{message.streaming ? '正在思考…' : ''}</p>
                    }
                    return message.streaming && index === messages.length - 1
                      ? <StreamingText text={message.content} />
                      : <RichMarkdown text={message.content} />
                  })()}
                </div>

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
