import DECtalkMini from './dectalk'

let voicesCache = []
let webSpeechBroken = false
let failureReported = false

function reportFailure(err) {
  if (failureReported) return
  failureReported = true
  console.warn('语音播放失败，请联系反馈', err)
}

function refreshVoices() {
  if (typeof window === 'undefined' || !window.speechSynthesis) return []
  const voices = window.speechSynthesis.getVoices()
  if (voices.length) voicesCache = voices
  return voicesCache
}

if (typeof window !== 'undefined' && window.speechSynthesis) {
  refreshVoices()
  window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices)
}

function pickVoice(accent) {
  const voices = refreshVoices()
  if (!voices.length) return null
  const lang = accent === 'uk' ? 'en-gb' : 'en-us'
  const exact = voices.find((v) => v.lang?.toLowerCase() === lang)
  const english = voices.find((v) => v.lang?.toLowerCase().startsWith('en'))
  return exact || english || null
}

/* ---------------- DECtalk WASM 后备 ---------------- */

const DECTALK_SAMPLE_RATE = 11025
let dectalkInit = null
let dectalkSpeak = null
let dectalkFree = null
let audioContext = null
let audioSource = null
let audioChunks = []

function ensureDectalk() {
  if (!dectalkInit) {
    dectalkInit = DECtalkMini()
      .then((module) => {
        module.cwrap('speak_init', null, [])()
        dectalkSpeak = module.cwrap('speak', 'number', ['number'])
        dectalkFree = module.cwrap('free', null, ['number'])
        window.onDECtalkAudioCallback = (tts, ptr, length) => {
          // 回调只在本轮 speak 期间触发，直接拷贝样本避免堆内存被回收
          audioChunks.push(new Int16Array(module.HEAP16.buffer, ptr, length).slice())
        }
        return module
      })
      .catch((err) => {
        dectalkInit = null
        throw err
      })
  }
  return dectalkInit
}

function resolveAudioContext() {
  if (!audioContext) {
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (!Ctor) throw new Error('AudioContext unavailable')
    audioContext = new Ctor()
  }
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {})
  return audioContext
}

function stopDectalk() {
  if (audioSource) {
    try {
      audioSource.stop()
    } catch {
      // 已经结束
    }
    audioSource = null
  }
  audioChunks = []
}

async function speakWithDectalk(text) {
  const module = await ensureDectalk()
  stopDectalk()

  const ptr = module.stringToNewUTF8(text)
  try {
    dectalkSpeak(ptr)
  } finally {
    dectalkFree(ptr)
  }

  if (!audioChunks.length) return
  let total = 0
  for (const chunk of audioChunks) total += chunk.length
  if (!total) return

  const ctx = resolveAudioContext()
  const buffer = ctx.createBuffer(1, total, DECTALK_SAMPLE_RATE)
  const samples = buffer.getChannelData(0)
  let offset = 0
  for (const chunk of audioChunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      samples[offset + i] = chunk[i] / 32768
    }
    offset += chunk.length
  }
  audioChunks = []

  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.onended = () => {
    if (audioSource === source) audioSource = null
  }
  audioSource = source
  source.start()
}

/* ---------------- 对外接口 ---------------- */

export function speak(text, accent = 'us', rate = 0.88) {
  if (!text) return

  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null
  const voice = synth ? pickVoice(accent) : null

  // 没有语音合成接口、没有可用英文语音、或之前调用报错时，自动切到 DECtalk
  if (synth && voice && !webSpeechBroken) {
    stopDectalk()
    synth.cancel()
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = accent === 'uk' ? 'en-GB' : 'en-US'
    utter.rate = rate
    utter.pitch = 1
    utter.voice = voice
    utter.onerror = (event) => {
      if (event.error === 'interrupted' || event.error === 'canceled') return
      webSpeechBroken = true
      speakWithDectalk(text).catch(reportFailure)
    }
    try {
      synth.speak(utter)
      return
    } catch (err) {
      webSpeechBroken = true
      reportFailure(err)
    }
  }

  speakWithDectalk(text).catch(reportFailure)
}

/**
 * 长文朗读：按句子边界切成 <=200 字符的片段，一次性排队。
 * speak() 每次都会 cancel，连续调用多个 speech.speak 只会听到最后一段；
 * 这里统一 cancel 一次再依次入队。DECtalk 降级路径直接读全文（不受该限制）。
 * 返回实际片段数，供执行器回显。
 */
export function speakLong(text, accent = 'us', rate = 0.88) {
  const source = String(text || '').trim()
  if (!source) return 0

  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null
  const voice = synth ? pickVoice(accent) : null
  if (!synth || !voice || webSpeechBroken) {
    speakWithDectalk(source).catch(reportFailure)
    return 1
  }

  const chunks = []
  let buf = ''
  const flush = () => {
    if (buf) { chunks.push(buf); buf = '' }
  }
  for (const sentence of source.split(/(?<=[.!?。！？;；])\s+|\n+/)) {
    let rest = String(sentence || '').trim()
    // 单句超过 200 时按词硬切，避免浏览器截断超长 utterance
    while (rest.length > 200) {
      flush()
      const cut = rest.lastIndexOf(' ', 200)
      const take = cut > 80 ? cut : 200
      chunks.push(rest.slice(0, take).trim())
      rest = rest.slice(take).trim()
    }
    if (!rest) continue
    if (buf && buf.length + 1 + rest.length > 200) flush()
    buf = buf ? `${buf} ${rest}` : rest
  }
  flush()
  const list = chunks.length ? chunks : [source.slice(0, 200)]

  stopDectalk()
  synth.cancel()
  for (const chunk of list) {
    const utter = new SpeechSynthesisUtterance(chunk)
    utter.lang = accent === 'uk' ? 'en-GB' : 'en-US'
    utter.rate = rate
    utter.pitch = 1
    utter.voice = voice
    utter.onerror = (event) => {
      if (event.error === 'interrupted' || event.error === 'canceled') return
      webSpeechBroken = true
    }
    try {
      synth.speak(utter)
    } catch (err) {
      reportFailure(err)
      break
    }
  }
  return list.length
}

export function stopSpeech() {
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.cancel()
  }
  stopDectalk()
}
