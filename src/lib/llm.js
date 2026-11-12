/**
 * 在线 AI。默认走 llm7.io（免费、允许跨域，静态页面可直接请求）。
 * 如需 Kilo Gateway AutoFree，可在设置里改服务地址，应用内会自动走原生桥接。
 */

const onlineBridge = typeof window !== 'undefined' ? window.OnlineLlm : null

export const AI_DEFAULT_BASE = 'https://api.llm7.io/v1'
export const ONLINE_DEFAULT_MODEL = 'codestral-latest'
const FALLBACK_MODEL = 'mistral-Nemo-Instruct-2407'
const KILO_HOST = 'ai-gateway.kilo.ai'
const KILO_FALLBACK_MODEL = 'nvidia/nemotron-3.5-super-vl:free'

const listeners = new Set()

function emit(event) {
  for (const listener of Array.from(listeners)) {
    try {
      listener(event)
    } catch {
      // 单个订阅者出错不应影响其他订阅者
    }
  }
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

if (typeof window !== 'undefined') {
  window.WordVaultOnline = {
    onToken: (id, text) => emit({ type: 'token', id, text }),
    onDone: (id, ok, message) => emit({ type: 'done', id, ok, message }),
  }
}

/** 在线 AI 可用性：应用内走原生桥接，浏览器环境退化为 fetch */
export function onlineSupported() {
  return Boolean(onlineBridge) || typeof fetch === 'function'
}

export function onlineNative() {
  return Boolean(onlineBridge)
}

function endpointOf(base) {
  const raw = String(base || '').trim() || AI_DEFAULT_BASE
  if (/\/chat\/completions$/.test(raw)) return raw
  return `${raw.replace(/\/+$/, '')}/chat/completions`
}

function isKiloBase(base) {
  const raw = String(base || '').trim()
  return raw.includes(KILO_HOST)
}

let onlineAbort = null

export function cancelGeneration() {
  if (onlineBridge) {
    try {
      onlineBridge.cancel()
    } catch {
      // 忽略桥接异常
    }
  }
  if (onlineAbort) {
    onlineAbort.abort()
    onlineAbort = null
  }
}

let counter = 0

function sseDelta(payload) {
  try {
    const json = JSON.parse(payload)
    const delta = json.choices?.[0]?.delta || {}
    return {
      content: delta.content || '',
      reasoning: delta.reasoning || delta.reasoning_content || '',
    }
  } catch {
    return null
  }
}

/**
 * 流式生成。messages 为 [{ role, content }]，role 取 system / user / assistant。
 * 返回完整文本，onToken 每收到一段增量文本触发一次。
 */
export function generate({
  messages,
  maxTokens = 512,
  temperature = 0.6,
  onToken,
  model = ONLINE_DEFAULT_MODEL,
  apiKey = '',
  base = '',
}) {
  // 原生桥接只实现了 Kilo 网关；其他服务（含默认的 llm7.io）直接用 fetch
  if (onlineBridge && isKiloBase(base)) {
    return new Promise((resolve, reject) => {
      counter += 1
      const id = `online-${Date.now()}-${counter}`
      const roles = messages.map((m) => m.role)
      const contents = messages.map((m) => m.content)
      let text = ''

      const unsubscribe = subscribe((event) => {
        if (event.id !== id) return
        if (event.type === 'token') {
          text += event.text
          if (onToken) onToken(event.text, text)
        } else if (event.type === 'done') {
          unsubscribe()
          if (event.ok) resolve(text.trim())
          else reject(new Error(event.message || '在线生成被中止'))
        }
      })

      try {
        onlineBridge.generate(
          id,
          JSON.stringify(roles),
          JSON.stringify(contents),
          model || 'kilo-auto/free',
          apiKey || '',
          Math.max(maxTokens, 768),
          temperature,
        )
      } catch (error) {
        unsubscribe()
        reject(error)
      }
    })
  }

  if (typeof fetch !== 'function') {
    return Promise.reject(new Error('当前环境不支持在线 AI'))
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  onlineAbort = controller
  const endpoint = endpointOf(base)
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const payload = (name) => JSON.stringify({
    model: name,
    messages,
    stream: true,
    max_tokens: Math.max(maxTokens, 768),
    temperature,
  })

  const request = (name) => fetch(endpoint, {
    method: 'POST',
    headers,
    signal: controller?.signal,
    body: payload(name),
  }).then(async (response) => {
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const error = new Error(`在线 AI 返回 ${response.status}${detail ? `：${detail.slice(0, 120)}` : ''}`)
      error.status = response.status
      error.detail = detail
      throw error
    }
    if (!response.body) throw new Error('在线 AI 未返回可读数据')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let reasoning = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const chunk = trimmed.slice(5).trim()
        if (!chunk || chunk === '[DONE]') continue
        const delta = sseDelta(chunk)
        if (!delta) continue
        if (delta.content) content += delta.content
        if (delta.reasoning) reasoning += delta.reasoning
        const piece = delta.content || delta.reasoning
        if (piece && onToken) onToken(piece, content || reasoning)
      }
    }
    const text = (content || reasoning).trim()
    if (!text) throw new Error('在线模型没有返回内容，请稍后重试')
    return text
  })

  const primary = model || ONLINE_DEFAULT_MODEL
  const fallback = isKiloBase(base) ? KILO_FALLBACK_MODEL : FALLBACK_MODEL
  return request(primary)
    .catch((error) => {
      // 模型临时不可用时换一个免费模型再试一次
      const retryable = error.status === 400 && /model_unavailable/i.test(error.detail || '')
      if (retryable && primary !== fallback) {
        return request(fallback)
      }
      // Kilo 免费路由偶尔会挑到需付费的模型
      const paidModel = error.status === 401 && /PAID_MODEL_AUTH_REQUIRED/i.test(error.detail || '')
      if (paidModel && primary !== KILO_FALLBACK_MODEL) {
        return request(KILO_FALLBACK_MODEL)
      }
      throw error
    })
    .catch((error) => {
      if (error?.name === 'AbortError') throw new Error('生成已停止')
      if (error.status === 401) {
        throw new Error('API Key 无效或未填写，请在「我的 → AI 提供方」中检查。')
      }
      if (error.status === 429) throw new Error('免费额度已用完，可填写 API Key 或稍后再试。')
      if (error instanceof TypeError) {
        throw new Error('无法连接在线 AI，请在「我的」检查服务地址或网络后重试。')
      }
      throw error
    })
    .finally(() => {
      onlineAbort = null
    })
}

/* ---------------- 提示词 ---------------- */

const SYSTEM =
  '你是英语学习助手，服务中文母语的学习者。回答使用简体中文，简洁准确，不使用 Markdown 标题、加粗或表情符号。'

function describe(entry) {
  const parts = []
  if (entry?.w) parts.push(`单词：${entry.w}`)
  const tr = (entry?.tr || []).filter((t) => t.c)
  if (tr.length) {
    parts.push(`释义：${tr.map((t) => `${t.p ? `${t.p}. ` : ''}${t.c}`).join('；')}`)
  }
  const ex = (entry?.ex || [])[0]
  if (ex?.en) parts.push(`词库例句：${ex.en}`)
  return parts.join('\n')
}

export function buildExampleMessages(entry) {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${describe(entry)}

请为这个词写 3 个例句，要求场景各不相同、长度适中、贴近真实使用。
严格按下面格式输出，每行一条，不要额外解释：
1. 英文例句 | 中文翻译
2. 英文例句 | 中文翻译
3. 英文例句 | 中文翻译
记忆钩子：一句不超过 30 字的中文联想提示`,
    },
  ]
}

export function buildExplainMessages(entry) {
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${describe(entry)}

请分四段讲解这个单词，每段以「核心含义：」「用法要点：」「近义辨析：」「常见错误：」开头，每段不超过 80 字。`,
    },
  ]
}

export function buildQuizMessages(entry, mode) {
  const kind = mode === 'cloze' ? '填空题（给出含空格的英文句子，答案为该词）' : '单选题（4 个选项）'
  return [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${describe(entry)}

请基于这个词出一道${kind}，只输出一行 JSON，不要代码块，不要多余文字。
格式：{"question":"题干","options":["A","B","C","D"],"answer":0,"explain":"一句中文解析"}
填空题的 options 输出为空数组，answer 输出该单词。answer 为正确选项的下标（从 0 开始）。`,
    },
  ]
}

export function buildChatMessages(history, question) {
  return [
    {
      role: 'system',
      content: `${SYSTEM} 你可以讲解词义、搭配、语法和记忆方法。回答控制在 150 字以内。
可使用 Markdown 的列表、加粗与代码块组织答案；数学或音标公式用 $...$（行内）或 $$...$$（独立成行）包裹。`,
    },
    ...history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: question },
  ]
}

/** 解析 AI 出的题，失败返回 null */
export function parseQuiz(text) {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const raw = JSON.parse(text.slice(start, end + 1))
    const question = String(raw.question || '').trim()
    if (!question) return null
    const options = Array.isArray(raw.options) ? raw.options.map((o) => String(o)) : []
    const answer = Number(raw.answer)
    return {
      question,
      options,
      answer: Number.isFinite(answer) ? answer : 0,
      explain: String(raw.explain || '').trim(),
    }
  } catch {
    return null
  }
}
