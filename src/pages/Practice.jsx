import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../AppContext'
import { BOOK_MAP, PRACTICE_MODES, activeAiProvider } from '../lib/constants'
import { getIndexWords, lookupFull } from '../lib/dict'
import { speak } from '../lib/speech'
import { buildQuizMessages, cancelGeneration, generate, parseQuiz } from '../lib/llm'
import { Icon } from '../components/Icons'

function shuffle(list) {
  const arr = [...list]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function meaningOf(entry) {
  return entry.tr?.find((t) => t.c)?.c || entry.tr?.[0]?.e || ''
}

function buildQuestions(mode, bookId) {
  const entries = getIndexWords()
    .filter((w) => w.b.includes(bookId))
    .map((w) => lookupFull(w.w))
    .filter(Boolean)

  const usable = entries.filter((e) => {
    if (!meaningOf(e)) return false
    if (mode === 'cloze') {
      return e.ex?.some((ex) => new RegExp(`\\b${escapeRegExp(e.w)}\\b`, 'i').test(ex.en))
    }
    return true
  })

  const picked = shuffle(usable).slice(0, 10)
  return picked.map((entry) => {
    const meaning = meaningOf(entry)
    const others = shuffle(usable.filter((e) => e.w !== entry.w && meaningOf(e) !== meaning)).slice(0, 3)
    const example = entry.ex?.[0]

    if (mode === 'choice') {
      return {
        mode,
        word: entry.w,
        prompt: entry.w,
        phonetic: entry.uk,
        options: shuffle([{ label: meaning, correct: true }, ...others.map((e) => ({ label: meaningOf(e), correct: false }))]),
        example,
        entry,
      }
    }

    if (mode === 'listening') {
      return {
        mode,
        word: entry.w,
        prompt: '',
        options: shuffle([{ label: entry.w, correct: true }, ...others.map((e) => ({ label: e.w, correct: false }))]),
        example,
        entry,
      }
    }

    if (mode === 'cloze') {
      const sentence = entry.ex.find((ex) => new RegExp(`\\b${escapeRegExp(entry.w)}\\b`, 'i').test(ex.en))
      const re = new RegExp(`\\b${escapeRegExp(entry.w)}\\b`, 'i')
      const match = sentence.en.match(re)
      const at = match ? match.index : -1
      return {
        mode,
        word: entry.w,
        prompt: '',
        blankBefore: at >= 0 ? sentence.en.slice(0, at) : sentence.en,
        blankAfter: at >= 0 ? sentence.en.slice(at + entry.w.length) : '',
        options: shuffle([{ label: entry.w, correct: true }, ...others.map((e) => ({ label: e.w, correct: false }))]),
        example: sentence,
        entry,
      }
    }

    return {
      mode: 'spelling',
      word: entry.w,
      prompt: meaning,
      phonetic: entry.uk,
      answer: entry.w,
      example,
      entry,
    }
  })
}

export default function Practice({ navigate, openWord, mode }) {
  const { state, dispatch, dict } = useApp()
  const [activeMode, setActiveMode] = useState(PRACTICE_MODES.some((m) => m.id === mode) ? mode : 'choice')
  const [questions, setQuestions] = useState(null)
  const [index, setIndex] = useState(0)
  const [selected, setSelected] = useState(null)
  const [inputValue, setInputValue] = useState('')
  const [answered, setAnswered] = useState(null)
  const [score, setScore] = useState(0)
  const [finished, setFinished] = useState(false)
  const [aiQuestion, setAiQuestion] = useState(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiSelected, setAiSelected] = useState(null)
  const [aiAnswered, setAiAnswered] = useState(null)
  const inputRef = useRef(null)
  const current = questions?.[index]
  const currentMode = PRACTICE_MODES.find((m) => m.id === activeMode)
  const book = BOOK_MAP[state.settings.bookId]

  useEffect(() => {
    if (!dict.fullReady) dict.ensureFullDict()
  }, [dict.fullReady, dict.ensureFullDict])

  useEffect(() => {
    if (questions && current?.mode === 'listening' && !answered) {
      const timer = window.setTimeout(() => speak(current.word, state.settings.accent), 280)
      return () => window.clearTimeout(timer)
    }
    return undefined
  }, [questions, index, answered, current, state.settings.accent])

  useEffect(() => {
    if (current?.mode === 'spelling' && !answered) inputRef.current?.focus()
  }, [index, current, answered])

  const start = () => {
    if (!dict.fullReady) return
    const list = buildQuestions(activeMode, state.settings.bookId)
    if (list.length < 4) {
      return
    }
    setQuestions(list)
    setIndex(0)
    setSelected(null)
    setInputValue('')
    setAnswered(null)
    setScore(0)
    setFinished(false)
  }

  const submitAnswer = (isCorrect) => {
    if (answered || !current) return
    if (isCorrect) setScore((s) => s + 1)
    setAnswered({ correct: isCorrect })
    dispatch({
      type: 'ANSWER_WORD',
      word: current.word,
      quality: isCorrect ? 4 : 2,
      isNew: !state.wordStates[current.word],
      mode: current.mode,
    })
  }

  const chooseOption = (option) => {
    if (answered) return
    setSelected(option.label)
    submitAnswer(option.correct)
  }

  const submitSpelling = (e) => {
    e.preventDefault()
    if (answered) return
    const ok = inputValue.trim().toLowerCase() === current.answer.toLowerCase()
    submitAnswer(ok)
  }

  const next = () => {
    if (index + 1 >= questions.length) {
      setFinished(true)
      return
    }
    setIndex((i) => i + 1)
    setSelected(null)
    setInputValue('')
    setAnswered(null)
  }

  const reset = () => {
    setQuestions(null)
    setIndex(0)
    setSelected(null)
    setInputValue('')
    setAnswered(null)
    setScore(0)
    setFinished(false)
  }

  const switchMode = (id) => {
    setActiveMode(id)
    reset()
    navigate(`practice/${id}`)
  }

  const requestAiQuestion = async () => {
    if (aiBusy) return
    const pool = getIndexWords()
      .filter((w) => w.b.includes(state.settings.bookId))
      .map((w) => lookupFull(w.w))
      .filter((entry) => entry && meaningOf(entry))
    if (!pool.length) {
      setAiError('当前词书没有可用词条')
      return
    }
    const entry = pool[Math.floor(Math.random() * pool.length)]
    setAiBusy(true)
    setAiError('')
    setAiQuestion(null)
    setAiSelected(null)
    setAiAnswered(null)
    try {
      const provider = activeAiProvider(state.settings)
      const text = await generate({
        messages: buildQuizMessages(entry, activeMode === 'cloze' ? 'cloze' : 'choice'),
        maxTokens: 260,
        temperature: 0.35,
        base: provider?.base,
        model: provider?.model,
        apiKey: provider?.key,
      })
      const quiz = parseQuiz(text)
      if (!quiz) throw new Error('模型输出格式无法解析，请再试一次')
      setAiQuestion({ ...quiz, word: entry.w, entry })
    } catch (err) {
      setAiError(err.message || '生成失败')
    } finally {
      setAiBusy(false)
    }
  }

  const answerAi = (index) => {
    if (aiAnswered) return
    const correct = index === aiQuestion.answer
    setAiSelected(index)
    setAiAnswered({ correct, index })
    dispatch({
      type: 'ANSWER_WORD',
      word: aiQuestion.word,
      quality: correct ? 4 : 2,
      isNew: !state.wordStates[aiQuestion.word],
      mode: 'ai',
    })
  }

  if (aiQuestion) {
    return (
      <div className="focus-page practice-page">
        <div className="focus-bar">
          <button className="icon-btn" onClick={() => { setAiQuestion(null); setAiAnswered(null) }} aria-label="退出 AI 出题">
            <Icon name="chevronLeft" size={22} />
          </button>
          <span className="focus-title">AI 出题</span>
          <span className="focus-progress">{aiQuestion.word}</span>
        </div>

        <div className="quiz-stage single">
          <div className="quiz-card">
            <div className="quiz-head">
              <span className="eyebrow">AI 生成</span>
              <span className="quiz-book">{book.short}</span>
            </div>
            <div className="quiz-prompt">
              <p className="ai-question-text">{aiQuestion.question}</p>
            </div>

            {aiQuestion.options.length > 0 ? (
              <div className="quiz-options">
                {aiQuestion.options.map((option, i) => {
                  const isSelected = aiSelected === i
                  const cls = aiAnswered
                    ? i === aiQuestion.answer ? 'correct' : isSelected ? 'wrong' : 'dim'
                    : ''
                  return (
                    <button key={`${option}-${i}`} className={`quiz-option ${cls}`} onClick={() => answerAi(i)} disabled={Boolean(aiAnswered)}>
                      <span className="option-index">{String.fromCharCode(65 + i)}</span>
                      <span>{option}</span>
                      {aiAnswered && i === aiQuestion.answer && <Icon name="check" size={17} />}
                      {aiAnswered && isSelected && i !== aiQuestion.answer && <Icon name="close" size={17} />}
                    </button>
                  )
                })}
              </div>
            ) : (
              <form
                className="spelling-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (aiAnswered) return
                  const ok = inputValue.trim().toLowerCase() === aiQuestion.word.toLowerCase()
                  setAiSelected(-1)
                  setAiAnswered({ correct: ok, index: -1 })
                  dispatch({
                    type: 'ANSWER_WORD',
                    word: aiQuestion.word,
                    quality: ok ? 4 : 2,
                    isNew: !state.wordStates[aiQuestion.word],
                    mode: 'ai',
                  })
                }}
              >
                <input
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                  placeholder="填写缺失的单词"
                  disabled={Boolean(aiAnswered)}
                  autoComplete="off"
                  spellCheck="false"
                />
                <button type="submit" className="btn btn-primary" disabled={Boolean(aiAnswered) || !inputValue.trim()}>提交</button>
              </form>
            )}

            {aiAnswered && (
              <div className={`quiz-feedback ${aiAnswered.correct ? 'ok' : 'bad'}`}>
                <div className="feedback-head">
                  <Icon name={aiAnswered.correct ? 'check' : 'alert'} size={18} />
                  <strong>{aiAnswered.correct ? '回答正确' : `正确答案：${aiQuestion.options.length ? aiQuestion.options[aiQuestion.answer] : aiQuestion.word}`}</strong>
                </div>
                {aiQuestion.explain && <p className="ai-explain">{aiQuestion.explain}</p>}
                <div className="feedback-actions">
                  <button className="btn btn-text" onClick={() => openWord(aiQuestion.word)}>
                    查看词条
                    <Icon name="arrowRight" size={15} />
                  </button>
                  <button className="btn btn-primary" onClick={requestAiQuestion}>
                    再来一题
                    <Icon name="arrowRight" size={16} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (!dict.fullReady) {
    return (
      <div className="focus-page practice-page">
        <div className="focus-bar">
          <button className="icon-btn" onClick={() => navigate('home')} aria-label="返回"><Icon name="chevronLeft" size={22} /></button>
          <span className="focus-title">专项练习</span>
        </div>
        <div className="study-loading"><span className="spinner large" /><h2>正在装载练习词库</h2><p>首次进入需要从本地读取词条。</p></div>
      </div>
    )
  }

  if (!questions) {
    return (
      <div className="focus-page practice-page">
        <div className="focus-bar">
          <button className="icon-btn" onClick={() => navigate('home')} aria-label="返回"><Icon name="chevronLeft" size={22} /></button>
          <span className="focus-title">专项练习</span>
          <span className="focus-progress">{book.name}</span>
        </div>

        <div className="practice-intro">
          <span className="eyebrow">10 题一组</span>
          <h1>换一种方式，把词从记忆里取出来</h1>
          <p>练习结果会写入 SM-2 复习记录，答错的词自动进入错词本。</p>

          <div className="mode-picker">
            {PRACTICE_MODES.map((m) => (
              <button
                key={m.id}
                className={`mode-card ${activeMode === m.id ? 'active' : ''}`}
                onClick={() => setActiveMode(m.id)}
              >
                <span className="mode-icon"><Icon name={m.icon} size={22} /></span>
                <strong>{m.name}</strong>
                <span>{m.desc}</span>
                <em>{activeMode === m.id ? '已选择' : '选择模式'}</em>
              </button>
            ))}
          </div>

          <div className="practice-start-row">
            <div className="practice-meta">
              <span><Icon name="book" size={14} /> {book.name}</span>
              <span><Icon name="list" size={14} /> 每轮 10 题</span>
              <span><Icon name="database" size={14} /> 纯本地生成</span>
            </div>
            <button className="btn btn-primary" onClick={start}>
              <Icon name="play" size={17} />
              开始练习
            </button>
          </div>

          <div className="ai-quiz-entry">
            <div>
              <strong>AI 出题</strong>
              <span>由在线 AI 针对当前词书随机出题，结果同样计入复习记录</span>
            </div>
            <div className="ai-quiz-actions">
              {aiBusy && (
                <button className="btn btn-text" onClick={cancelGeneration}>停止</button>
              )}
              <button className="btn btn-outlined" onClick={requestAiQuestion} disabled={aiBusy}>
                <Icon name="spark" size={16} />
                {aiBusy ? '生成中…' : '生成一道'}
              </button>
            </div>
          </div>
          {aiError && <p className="ai-error">{aiError}</p>}
        </div>
      </div>
    )
  }

  if (finished) {
    const rate = Math.round((score / questions.length) * 100)
    return (
      <div className="focus-page practice-page">
        <div className="focus-bar">
          <button className="icon-btn" onClick={() => navigate('home')} aria-label="返回"><Icon name="chevronLeft" size={22} /></button>
          <span className="focus-title">练习总结</span>
          <span className="focus-progress">{currentMode?.name}</span>
        </div>
        <div className="study-summary">
          <span className="summary-icon"><Icon name="target" size={40} /></span>
          <span className="eyebrow">本组练习完成</span>
          <h1>{rate >= 80 ? '状态很稳，继续推进' : rate >= 50 ? '基础还在，重点复习错词' : '先把错词吃透，再练一组'}</h1>
          <p>共 {questions.length} 题，答对 {score} 题，正确率 {rate}%。</p>
          <div className="summary-stat-grid two">
            <div><strong>{score}</strong><span>答对题数</span></div>
            <div><strong>{questions.length - score}</strong><span>答错题数</span></div>
          </div>
          <div className="summary-actions">
            <button className="btn btn-primary" onClick={start}>再练一组</button>
            <button className="btn btn-outlined" onClick={() => navigate('wrong')}>查看错词本</button>
            <button className="btn btn-text" onClick={() => navigate('home')}>返回首页</button>
          </div>
        </div>
      </div>
    )
  }

  if (!current) {
    return (
      <div className="focus-page practice-page">
        <div className="study-loading"><span className="spinner large" /><h2>正在生成题目</h2></div>
      </div>
    )
  }

  const progress = Math.round((index / questions.length) * 100)

  return (
    <div className="focus-page practice-page">
      <div className="focus-bar">
        <button className="icon-btn" onClick={() => navigate('home')} aria-label="返回"><Icon name="chevronLeft" size={22} /></button>
        <div className="focus-progress-wrap">
          <div className="focus-progress-meta">
            <span>{currentMode?.name}</span>
            <span>{index + 1} / {questions.length}</span>
          </div>
          <div className="progress-bar focus-progress-bar"><span style={{ width: `${progress}%` }} /></div>
        </div>
        <span className="practice-score">{score} 分</span>
      </div>

      <div className="quiz-stage">
        <div className="quiz-card">
          <div className="quiz-head">
            <span className="eyebrow">第 {index + 1} 题</span>
            <span className="quiz-book">{book.short}</span>
          </div>

          {current.mode === 'choice' && (
            <div className="quiz-prompt">
              <h1>{current.prompt}</h1>
              {current.phonetic && <span>/{current.phonetic}/</span>}
              <p>选择正确的中文释义</p>
            </div>
          )}

          {current.mode === 'listening' && (
            <div className="quiz-prompt listening">
              <button className="listen-orb" onClick={() => speak(current.word, state.settings.accent)} aria-label="播放发音">
                <Icon name="volume" size={34} />
              </button>
              <h2>听发音，选出正确的单词</h2>
              <button className="btn btn-text" onClick={() => speak(current.word, state.settings.accent)}>再听一次</button>
            </div>
          )}

          {current.mode === 'spelling' && (
            <div className="quiz-prompt">
              <span className="prompt-label">根据释义拼写单词</span>
              <h2>{current.prompt}</h2>
              {current.phonetic && <span>/{current.phonetic}/</span>}
            </div>
          )}

          {current.mode === 'cloze' && (
            <div className="quiz-prompt cloze">
              <span className="prompt-label">选词填空</span>
              <p className="cloze-sentence">
                {current.blankBefore}
                <span className={`blank ${answered ? 'filled' : ''}`}>
                  {answered ? current.word : '        '}
                </span>
                {current.blankAfter}
              </p>
              <span className="cloze-cn">{current.example.cn}</span>
            </div>
          )}

          {current.mode === 'spelling' ? (
            <form className="spelling-form" onSubmit={submitSpelling}>
              <input
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="输入英文单词"
                disabled={Boolean(answered)}
                autoComplete="off"
                spellCheck="false"
                aria-label="拼写答案"
              />
              <button type="submit" className="btn btn-primary" disabled={Boolean(answered) || !inputValue.trim()}>提交</button>
            </form>
          ) : (
            <div className={`quiz-options ${current.mode === 'listening' || current.mode === 'cloze' ? 'word-options' : ''}`}>
              {current.options.map((option, i) => {
                const isSelected = selected === option.label
                const cls = answered
                  ? option.correct ? 'correct' : isSelected ? 'wrong' : 'dim'
                  : ''
                return (
                  <button key={option.label} className={`quiz-option ${cls}`} onClick={() => chooseOption(option)} disabled={Boolean(answered)}>
                    <span className="option-index">{String.fromCharCode(65 + i)}</span>
                    <span>{option.label}</span>
                    {answered && option.correct && <Icon name="check" size={17} />}
                    {answered && isSelected && !option.correct && <Icon name="close" size={17} />}
                  </button>
                )
              })}
            </div>
          )}

          {answered && (
            <div className={`quiz-feedback ${answered.correct ? 'ok' : 'bad'}`}>
              <div className="feedback-head">
                <Icon name={answered.correct ? 'check' : 'alert'} size={18} />
                <strong>{answered.correct ? '回答正确' : current.mode === 'spelling' ? `正确答案：${current.answer}` : '再记一次'}</strong>
              </div>
              {current.mode === 'spelling' && !answered.correct && (
                <p className="feedback-word">{current.word}</p>
              )}
              {current.example && (
                <div className="feedback-example">
                  <p>{current.example.en}</p>
                  <span>{current.example.cn}</span>
                </div>
              )}
              <div className="feedback-actions">
                <button className="btn btn-text" onClick={() => openWord(current.word)}>
                  查看词条
                  <Icon name="arrowRight" size={15} />
                </button>
                <button className="btn btn-primary" onClick={next}>
                  {index + 1 >= questions.length ? '查看结果' : '下一题'}
                  <Icon name="arrowRight" size={16} />
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="quiz-side">
          <span className="eyebrow">题型</span>
          <strong>{currentMode?.name}</strong>
          <p>{currentMode?.desc}</p>
          <div className="quiz-side-stats">
            <div><strong>{score}</strong><span>答对</span></div>
            <div><strong>{index + (answered ? 1 : 0)}</strong><span>已答</span></div>
          </div>
          <div className="mode-switch">
            {PRACTICE_MODES.map((m) => (
              <button key={m.id} className={`mode-mini ${activeMode === m.id ? 'active' : ''}`} onClick={() => switchMode(m.id)} title={m.name}>
                <Icon name={m.icon} size={16} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
