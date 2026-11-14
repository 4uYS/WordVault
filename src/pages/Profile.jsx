import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../AppContext'
import { useUI } from '../UIContext'
import {
  AI_PROVIDERS,
  BOOK_MAP,
  DAILY_OPTIONS,
  DEFAULT_DAILY_REVIEW,
  FONT_OPTIONS,
  GOALS,
  IDENTITIES,
  LEVELS,
  REVIEW_OPTIONS,
  SOURCE_NOTE,
  activeAiProvider,
} from '../lib/constants'
import { deleteCustomFont, saveCustomFont } from '../lib/fonts'
import { downloadBackup, parseBackup } from '../lib/backup'
import {
  isNativeApp,
  notificationStatus,
  requestNotificationPermission,
} from '../lib/native'
import { Icon } from '../components/Icons'

const TABS = [
  { id: 'study', label: '学习画像', icon: 'target' },
  { id: 'reminder', label: '提醒与声音', icon: 'bell' },
  { id: 'appearance', label: '外观字体', icon: 'palette' },
  { id: 'ai', label: 'AI 引擎', icon: 'spark' },
  { id: 'data', label: '本地数据', icon: 'database' },
]

const TAB_META = {
  study: { title: '目标与节奏', hint: '点击任意一项查看详情并修改' },
  reminder: { title: '学习环境', hint: '提醒时间、通知与发音偏好' },
  appearance: { title: '主题与字体', hint: '修改后立即生效，只保存在本机' },
  ai: { title: 'AI 提供方', hint: '选择、编辑或添加 OpenAI 兼容服务' },
  data: { title: '备份与重置', hint: '所有学习数据只存在这台设备' },
}

const DETAIL_TITLES = {
  identity: '身份标签',
  goal: '学习目标',
  level: '当前英语水平',
  daily: '每日新学单词',
  review: '每日复习上限',
  reminder: '每日提醒时间',
  accent: '发音偏好',
  theme: '主题模式',
  font: '界面字体',
  ai: 'AI 提供方',
  about: '关于 WordVault',
}

function Avatar({ nickname }) {
  const initial = (nickname || '词').trim().slice(0, 1).toUpperCase()
  const hue = Array.from(nickname || 'wordvault').reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 40
  return (
    <span className="profile-avatar" style={{ '--avatar-hue': `${210 + hue}` }}>
      <span>{initial}</span>
      <i />
    </span>
  )
}

/** 可点击进入详情的设置行 */
function Cell({ icon, title, value, desc, danger = false, chevron = true, onClick }) {
  return (
    <button
      type="button"
      className={`settings-cell ${danger ? 'danger' : ''}`}
      onClick={onClick}
    >
      <span className="cell-icon"><Icon name={icon} size={18} /></span>
      <span className="cell-body">
        <span className="cell-line">
          <span className="cell-title">{title}</span>
          {value ? <span className="cell-value">{value}</span> : null}
        </span>
        {desc ? <span className="cell-desc">{desc}</span> : null}
      </span>
      {chevron ? <Icon name="chevronRight" size={17} className="cell-chevron" /> : null}
    </button>
  )
}

/** 行内开关，不需要进入详情 */
function ToggleCell({ icon, title, desc, checked, actionLabel, disabled, onChange }) {
  return (
    <div className="settings-cell">
      <span className="cell-icon"><Icon name={icon} size={18} /></span>
      <span className="cell-body">
        <span className="cell-line">
          <span className="cell-title">{title}</span>
          {actionLabel ? <span className="cell-value">{actionLabel}</span> : null}
        </span>
        {desc ? <span className="cell-desc">{desc}</span> : null}
      </span>
      <button
        type="button"
        className={`toggle-row ${checked ? 'on' : ''}`}
        onClick={onChange}
        disabled={disabled}
        aria-pressed={checked}
        aria-label={title}
      >
        <span className="toggle-track"><i /></span>
      </button>
    </div>
  )
}

export default function Profile() {
  const { state, dispatch, stats, dict } = useApp()
  const { showToast } = useUI()
  const { profile, settings } = state
  const providers = settings.aiProviders?.length ? settings.aiProviders : AI_PROVIDERS
  const aiProvider = activeAiProvider(settings)

  const [tab, setTab] = useState('study')
  const [detail, setDetail] = useState(null)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(profile.nickname)
  const [fontName, setFontName] = useState(settings.customFontName || '')
  const fontInputRef = useRef(null)
  const importRef = useRef(null)

  const identities = profile.identities || []
  const level = LEVELS.find((l) => l.id === profile.level)
  const goal = GOALS.find((g) => g.id === profile.goal)
  const dailyReview = profile.dailyReview ?? DEFAULT_DAILY_REVIEW
  const fontOption = FONT_OPTIONS.find((f) => f.id === settings.font)
  const isNative = isNativeApp()
  const [permission, setPermission] = useState(() => {
    if (isNative) return notificationStatus()
    return typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported'
  })
  const customCount = useMemo(() => (dict.indexWords?.length || 0), [dict.indexWords])
  const activeTab = TABS.find((t) => t.id === tab) || TABS[0]

  useEffect(() => {
    if (!isNative) return undefined
    const refresh = () => setPermission(notificationStatus())
    refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('wordvault:permission-changed', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('wordvault:permission-changed', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [isNative])

  useEffect(() => {
    if (!detail) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') setDetail(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail])

  const switchTab = (id) => {
    setTab(id)
    setDetail(null)
  }

  const saveName = () => {
    const name = nameDraft.trim()
    if (!name) {
      showToast('昵称不能为空')
      return
    }
    dispatch({ type: 'UPDATE_PROFILE', patch: { nickname: name } })
    setEditingName(false)
    showToast('昵称已更新')
  }

  const toggleIdentity = (item) => {
    const list = identities.includes(item)
      ? identities.filter((x) => x !== item)
      : [...identities, item]
    dispatch({ type: 'UPDATE_PROFILE', patch: { identities: list } })
  }

  const chooseGoal = (item) => {
    dispatch({ type: 'UPDATE_PROFILE', patch: { goal: item.id } })
    dispatch({ type: 'UPDATE_SETTINGS', patch: { bookId: item.book } })
    showToast(`目标已更新，默认词书切换为${item.label}`)
  }

  const chooseLevel = (item) => {
    dispatch({ type: 'UPDATE_PROFILE', patch: { level: item.id } })
    showToast(`已切换为${item.label}水平`)
  }

  const chooseDaily = (n) => {
    dispatch({ type: 'UPDATE_PROFILE', patch: { dailyNew: n } })
    showToast(`每日新词已设为 ${n} 个`)
  }

  const chooseReview = (n) => {
    dispatch({ type: 'UPDATE_PROFILE', patch: { dailyReview: n } })
    showToast(n > 0 ? `每日复习上限已设为 ${n} 个` : '已取消每日复习上限')
  }

  const requestPermission = async () => {
    if (isNative) {
      requestNotificationPermission()
      showToast('已请求系统通知权限，允许后请再开启开关')
      return
    }
    if (!('Notification' in window)) {
      showToast('当前浏览器不支持通知')
      return
    }
    const result = await Notification.requestPermission().catch(() => 'denied')
    if (result === 'granted') {
      dispatch({ type: 'UPDATE_PROFILE', patch: { notify: true } })
      showToast('浏览器提醒已开启')
    } else {
      showToast('未获得通知权限，可在浏览器设置中开启')
    }
  }

  const toggleNotify = () => {
    if (!profile.notify && permission === 'default') {
      requestPermission()
      return
    }
    if (permission !== 'granted') {
      showToast(isNative ? '请在系统设置中允许 WordVault 发送通知' : '请先开启浏览器通知权限')
      return
    }
    dispatch({ type: 'UPDATE_PROFILE', patch: { notify: !profile.notify } })
  }

  const handleFontUpload = async (file) => {
    if (!file) return
    if (!/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/.test(file.name)) {
      showToast('请选择 ttf、otf、woff 或 woff2 字体文件')
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      showToast('字体文件不能超过 8 MB')
      return
    }
    try {
      await saveCustomFont(file)
      setFontName(file.name)
      dispatch({ type: 'UPDATE_SETTINGS', patch: { font: 'custom', customFontName: file.name } })
      showToast('自定义字体已应用，仅保存在本设备')
    } catch {
      showToast('字体保存失败，请换一个文件')
    }
  }

  const removeCustomFont = async () => {
    await deleteCustomFont()
    setFontName('')
    dispatch({ type: 'UPDATE_SETTINGS', patch: { font: 'system', customFontName: '' } })
    showToast('已移除自定义字体')
  }

  const exportData = () => {
    const mode = downloadBackup(state)
    showToast(mode === 'native' ? '备份已生成，请选择保存位置' : '备份文件已生成')
  }

  const importData = async (file) => {
    if (!file) return
    try {
      const text = await file.text()
      const data = parseBackup(text)
      const confirmed = window.confirm('导入会覆盖当前设备上的学习记录与画像，确定继续吗？')
      if (!confirmed) return
      dispatch({ type: 'IMPORT_STATE', data })
      showToast('备份已导入')
    } catch (err) {
      showToast(err.message || '导入失败，请检查文件')
    } finally {
      if (importRef.current) importRef.current.value = ''
    }
  }

  const resetProgress = () => {
    if (!window.confirm('确定清空学习记录、复习计划和错词本吗？用户画像会保留。')) return
    dispatch({ type: 'RESET_PROGRESS' })
    showToast('学习记录已清空')
  }

  const resetAll = () => {
    if (!window.confirm('确定清除全部本地数据并重新开始引导吗？此操作无法撤销。')) return
    dispatch({ type: 'RESET_ALL' })
    window.location.hash = '/home'
  }

  /* ---------------- AI 提供方 ---------------- */
  const selectProvider = (id) => dispatch({ type: 'UPDATE_SETTINGS', patch: { aiProviderId: id } })

  const updateProvider = (patch) => {
    if (!aiProvider) return
    const next = providers.map((item) => (item.id === aiProvider.id ? { ...item, ...patch } : item))
    dispatch({ type: 'UPDATE_SETTINGS', patch: { aiProviders: next } })
  }

  const addProvider = () => {
    const id = `custom-${Date.now().toString(36)}`
    const next = [
      ...providers,
      { id, name: '自定义服务', base: '', model: '', key: '', preset: false },
    ]
    dispatch({ type: 'UPDATE_SETTINGS', patch: { aiProviders: next, aiProviderId: id } })
    showToast('已添加自定义提供方，请填写服务地址与模型')
  }

  const removeProvider = (item) => {
    if (!window.confirm(`删除提供方「${item.name}」？`)) return
    const next = providers.filter((entry) => entry.id !== item.id)
    dispatch({
      type: 'UPDATE_SETTINGS',
      patch: { aiProviders: next, aiProviderId: next[0]?.id || 'llm7' },
    })
  }

  /* ---------------- 标签页内容 ---------------- */
  const renderCells = () => {
    if (tab === 'study') {
      return (
        <>
          <Cell
            icon="user"
            title="身份标签"
            value={identities.length ? `${identities.length} 项` : '未选择'}
            desc={identities.length ? identities.join(' · ') : '选择最贴近你的身份，可多选'}
            onClick={() => setDetail('identity')}
          />
          <Cell
            icon="target"
            title="学习目标"
            value={goal?.label || '未设置'}
            desc={goal?.desc || '决定默认词书与学习节奏'}
            onClick={() => setDetail('goal')}
          />
          <Cell
            icon="chart"
            title="当前英语水平"
            value={level?.label || '未设置'}
            desc={level?.desc || '用于推荐每日新词量'}
            onClick={() => setDetail('level')}
          />
          <Cell
            icon="layers"
            title="每日新学单词"
            value={`${profile.dailyNew} 个 / 天`}
            desc="达到上限后当天不再推荐新词，只安排复习"
            onClick={() => setDetail('daily')}
          />
          <Cell
            icon="clock"
            title="每日复习上限"
            value={dailyReview > 0 ? `${dailyReview} 个 / 天` : '不限'}
            desc="超过上限的到期词顺延到次日，避免一次涌入"
            onClick={() => setDetail('review')}
          />
        </>
      )
    }

    if (tab === 'reminder') {
      return (
        <>
          <Cell
            icon="clock"
            title="每日提醒时间"
            value={profile.reminderTime}
            desc={isNative ? '到点由系统通知提醒，关闭应用也能收到' : '应用打开时，到点通过浏览器通知提醒'}
            onClick={() => setDetail('reminder')}
          />
          <ToggleCell
            icon="bell"
            title={isNative ? '系统通知' : '浏览器通知'}
            checked={permission === 'granted' && Boolean(profile.notify)}
            actionLabel={
              permission === 'granted'
                ? profile.notify ? '已开启' : '已关闭'
                : permission === 'denied' ? '已拒绝' : permission === 'unsupported' ? '不支持' : '待授权'
            }
            desc={
              permission === 'granted'
                ? isNative ? '由 Android 通知栏提醒，关闭应用也生效' : '到提醒时间弹出系统通知'
                : permission === 'denied'
                  ? isNative ? '权限被拒绝，请在系统设置中允许通知' : '权限被拒绝，请在浏览器设置中开启'
                  : permission === 'unsupported'
                    ? '当前环境不支持通知'
                    : isNative ? '点击开关授权系统通知权限' : '点击开关授权浏览器通知'
            }
            disabled={permission === 'denied' || permission === 'unsupported'}
            onChange={toggleNotify}
          />
          <Cell
            icon="volume"
            title="发音偏好"
            value={settings.accent === 'uk' ? '英音' : '美音'}
            desc="单词卡片与听音模式的默认口音"
            onClick={() => setDetail('accent')}
          />
          <ToggleCell
            icon="volume"
            title="自动朗读单词"
            checked={settings.autoSpeak}
            actionLabel={settings.autoSpeak ? '已开启' : '已关闭'}
            desc="进入新卡片时自动播放一次发音"
            onChange={() => dispatch({ type: 'UPDATE_SETTINGS', patch: { autoSpeak: !settings.autoSpeak } })}
          />
        </>
      )
    }

    if (tab === 'appearance') {
      const themeLabel = settings.theme === 'system' ? '跟随系统' : settings.theme === 'dark' ? '深色' : '浅色'
      return (
        <>
          <Cell
            icon="palette"
            title="主题模式"
            value={themeLabel}
            desc="浅色、深色或跟随系统外观"
            onClick={() => setDetail('theme')}
          />
          <Cell
            icon="font"
            title="界面字体"
            value={fontOption?.label || '系统默认'}
            desc={settings.font === 'custom' && fontName ? fontName : fontOption?.desc || '跟随设备的最优中文字体'}
            onClick={() => setDetail('font')}
          />
        </>
      )
    }

    if (tab === 'ai') {
      return (
        <>
          <Cell
            icon="spark"
            title="当前 AI 提供方"
            value={aiProvider?.name || '未选择'}
            desc={aiProvider?.base || '选择或添加 OpenAI 兼容服务'}
            onClick={() => setDetail('ai')}
          />
          <Cell
            icon="settings"
            title="管理与添加提供方"
            value={`${providers.length} 个`}
            desc="编辑服务地址、模型与 API Key"
            onClick={() => setDetail('ai')}
          />
          <div className="settings-note">
            <Icon name="lock" size={14} />
            AI 配置与学习记录一样只保存在本机，导出备份时会一并写入文件。
          </div>
        </>
      )
    }

    return (
      <>
        <Cell
          icon="download"
          title="导出备份"
          desc="生成 JSON 文件，包含画像、进度与复习计划"
          chevron={false}
          onClick={exportData}
        />
        <Cell
          icon="upload"
          title="导入恢复"
          desc="从 WordVault 备份文件恢复本设备数据"
          chevron={false}
          onClick={() => importRef.current?.click()}
        />
        <Cell
          icon="trash"
          title="清空学习记录"
          desc="保留画像与设置，只重置单词进度"
          chevron={false}
          onClick={resetProgress}
        />
        <Cell
          icon="refresh"
          title="恢复初始状态"
          desc="清除全部本地数据并重新进入引导"
          danger
          chevron={false}
          onClick={resetAll}
        />
        <Cell
          icon="info"
          title="关于 WordVault"
          value="v1.0"
          desc="纯前端离线应用，本地优先"
          onClick={() => setDetail('about')}
        />
      </>
    )
  }

  /* ---------------- 详情内容 ---------------- */
  const renderDetail = () => {
    if (detail === 'identity') {
      return (
        <>
          <p className="detail-hint">可多选，用于匹配更适合你的学习节奏，之后随时可以调整。</p>
          <div className="tag-toggle-list">
            {IDENTITIES.map((item) => (
              <button
                key={item}
                type="button"
                className={`tag-toggle ${identities.includes(item) ? 'active' : ''}`}
                onClick={() => toggleIdentity(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </>
      )
    }

    if (detail === 'goal') {
      return (
        <>
          <p className="detail-hint">切换目标会把默认词书同步为对应词书，历史学习进度不受影响。</p>
          <div className="option-list">
            {GOALS.map((item) => {
              const active = profile.goal === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`option-row ${active ? 'active' : ''}`}
                  onClick={() => chooseGoal(item)}
                >
                  <span className="option-main">
                    <strong>{item.label}</strong>
                    <span>{item.desc} · 默认 {BOOK_MAP[item.book]?.name || item.book}</span>
                  </span>
                  {active ? <Icon name="check" size={17} /> : null}
                </button>
              )
            })}
          </div>
        </>
      )
    }

    if (detail === 'level') {
      return (
        <>
          <p className="detail-hint">凭感觉选择即可，仅影响每日新词推荐，不会修改历史记录。</p>
          <div className="level-chips">
            {LEVELS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`level-chip ${profile.level === item.id ? 'active' : ''}`}
                onClick={() => chooseLevel(item)}
              >
                <strong>{item.label}</strong>
                <span>{item.desc}</span>
              </button>
            ))}
          </div>
        </>
      )
    }

    if (detail === 'daily') {
      return (
        <>
          <p className="detail-hint">每天最多学多少个新词。到期复习不受这个上限限制。</p>
          <div className="number-options compact-options">
            {DAILY_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                className={`number-option ${profile.dailyNew === n ? 'selected' : ''}`}
                onClick={() => chooseDaily(n)}
              >
                <strong>{n}</strong>
                <span>个 / 天</span>
              </button>
            ))}
          </div>
        </>
      )
    }

    if (detail === 'review') {
      return (
        <>
          <p className="detail-hint">
            每天最多安排多少个到期复习词。超出上限的词不会丢，只是顺延到第二天继续。
          </p>
          <div className="number-options compact-options">
            {REVIEW_OPTIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`number-option ${dailyReview === item.value ? 'selected' : ''}`}
                onClick={() => chooseReview(item.value)}
              >
                <strong>{item.label}</strong>
                <span>{item.desc}</span>
              </button>
            ))}
          </div>
        </>
      )
    }

    if (detail === 'reminder') {
      return (
        <>
          <p className="detail-hint">只有应用处于打开状态时才会检查提醒时间并弹出通知。</p>
          <label className="time-field">
            <Icon name="clock" size={18} />
            <input
              type="time"
              value={profile.reminderTime}
              onChange={(e) => dispatch({ type: 'UPDATE_PROFILE', patch: { reminderTime: e.target.value } })}
              aria-label="提醒时间"
            />
          </label>
        </>
      )
    }

    if (detail === 'accent') {
      return (
        <>
          <p className="detail-hint">影响单词卡片、听音辨词模式和例句朗读的默认口音。</p>
          <div className="segmented">
            <button
              type="button"
              className={settings.accent === 'uk' ? 'active' : ''}
              onClick={() => dispatch({ type: 'UPDATE_SETTINGS', patch: { accent: 'uk' } })}
            >
              英音
            </button>
            <button
              type="button"
              className={settings.accent === 'us' ? 'active' : ''}
              onClick={() => dispatch({ type: 'UPDATE_SETTINGS', patch: { accent: 'us' } })}
            >
              美音
            </button>
          </div>
        </>
      )
    }

    if (detail === 'theme') {
      return (
        <>
          <p className="detail-hint">「跟随系统」会随设备的深色模式自动切换。</p>
          <div className="theme-options">
            {[
              { id: 'light', label: '浅色', icon: 'sun' },
              { id: 'dark', label: '深色', icon: 'moon' },
              { id: 'system', label: '跟随系统', icon: 'settings' },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                className={`theme-option ${settings.theme === t.id ? 'active' : ''}`}
                onClick={() => dispatch({ type: 'UPDATE_SETTINGS', patch: { theme: t.id } })}
              >
                <Icon name={t.icon} size={18} />
                {t.label}
              </button>
            ))}
          </div>
        </>
      )
    }

    if (detail === 'font') {
      return (
        <>
          <div className="font-options">
            {FONT_OPTIONS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`font-option ${settings.font === f.id ? 'active' : ''}`}
                onClick={() => {
                  if (f.id === 'custom' && !fontName) {
                    fontInputRef.current?.click()
                    return
                  }
                  dispatch({
                    type: 'UPDATE_SETTINGS',
                    patch: { font: f.id, customFontName: f.id === 'custom' ? fontName : settings.customFontName },
                  })
                }}
                style={f.stack ? { fontFamily: f.stack } : undefined}
              >
                <strong>{f.label}</strong>
                <span>{f.desc}</span>
                {settings.font === f.id && <Icon name="check" size={15} />}
              </button>
            ))}
          </div>
          <div className="font-upload-row">
            <button type="button" className="btn btn-outlined small" onClick={() => fontInputRef.current?.click()}>
              <Icon name="upload" size={15} />
              {fontName ? '更换字体文件' : '上传自定义字体'}
            </button>
            {fontName && (
              <>
                <span className="font-file-name">{fontName}</span>
                <button type="button" className="btn btn-text small danger-text" onClick={removeCustomFont}>移除</button>
              </>
            )}
          </div>
          <p className="setting-help">字体文件只保存在当前浏览器的 IndexedDB 中，不会上传。刷新后自动恢复。</p>
        </>
      )
    }

    if (detail === 'ai') {
      return (
        <>
          <div className="ai-provider-list">
            {providers.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`ai-provider ${item.id === aiProvider?.id ? 'active' : ''}`}
                onClick={() => selectProvider(item.id)}
              >
                <strong>{item.name}</strong>
                <span>{item.note || item.base || '自定义服务'}</span>
              </button>
            ))}
            <button type="button" className="ai-provider add" onClick={addProvider}>
              <strong>＋ 自定义</strong>
              <span>接入任意 OpenAI 兼容服务</span>
            </button>
          </div>

          {aiProvider ? (
            <div className="ai-online-fields">
              <span className="setting-label">显示名称</span>
              <input
                className="select-field"
                value={aiProvider.name || ''}
                placeholder="例如 我的 DeepSeek"
                onChange={(e) => updateProvider({ name: e.target.value })}
                aria-label="AI 提供方名称"
              />
              <span className="setting-label">服务地址</span>
              <input
                className="select-field"
                value={aiProvider.base || ''}
                placeholder="https://api.deepseek.com/v1"
                onChange={(e) => updateProvider({ base: e.target.value })}
                aria-label="AI 服务地址"
              />
              <span className="setting-label">模型名称</span>
              <input
                className="select-field"
                value={aiProvider.model || ''}
                placeholder="deepseek-chat"
                onChange={(e) => updateProvider({ model: e.target.value })}
                aria-label="AI 模型名称"
              />
              <span className="setting-label">API Key</span>
              <input
                className="select-field"
                type="password"
                value={aiProvider.key || ''}
                placeholder={aiProvider.id === 'deepseek' ? 'sk-...' : '留空使用免费额度'}
                onChange={(e) => updateProvider({ key: e.target.value })}
                aria-label="AI API Key"
              />
              <p className="setting-help">
                {aiProvider.id === 'deepseek'
                  ? 'DeepSeek 需填写 API Key（platform.deepseek.com 获取），浏览器可直接调用。'
                  : '服务地址填到 /v1 即可，应用会自动补 /chat/completions。'}
                内置 llm7.io 免 Key 可用；所有配置仅保存在本机。
              </p>
              {!aiProvider.preset ? (
                <button type="button" className="btn btn-text small danger-text" onClick={() => removeProvider(aiProvider)}>
                  删除此提供方
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      )
    }

    return (
      <div className="about-panel">
        <div className="about-brand">
          <span className="about-mark">WV</span>
          <div>
            <strong>WordVault 词库宝箱</strong>
            <span>版本 1.0 · 纯前端离线应用</span>
          </div>
        </div>
        <div className="about-points">
          <p><Icon name="lock" size={15} /> 所有用户数据仅保存在浏览器 localStorage，不上传任何服务器。</p>
          <p><Icon name="database" size={15} /> 查词与词库全部来自本地文件，不接入第三方词典接口。</p>
          <p><Icon name="volume" size={15} /> 发音使用浏览器内置的 Web Speech API。</p>
          <p><Icon name="info" size={15} /> {SOURCE_NOTE}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page profile-page">
      <header className="profile-head">
        <div className="profile-identity">
          <Avatar nickname={profile.nickname} />
          <div className="profile-name-block">
            <span className="eyebrow">个人中心</span>
            {editingName ? (
              <div className="name-edit">
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  maxLength={16}
                  aria-label="昵称"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(false) }}
                />
                <button type="button" className="btn btn-primary small" onClick={saveName}>保存</button>
                <button type="button" className="btn btn-text small" onClick={() => setEditingName(false)}>取消</button>
              </div>
            ) : (
              <div className="name-row">
                <h1>{profile.nickname}</h1>
                <button
                  type="button"
                  className="icon-btn small"
                  onClick={() => { setNameDraft(profile.nickname); setEditingName(true) }}
                  aria-label="编辑昵称"
                >
                  <Icon name="edit" size={17} />
                </button>
              </div>
            )}
            <div className="identity-tags">
              {identities.map((tag) => <span key={tag}>{tag}</span>)}
              <span className="tag-soft">{goal?.label || '日常提升'}</span>
              <span className="tag-soft">{level?.label || '初级'}</span>
            </div>
          </div>
        </div>
        <div className="profile-stats">
          <div><strong>{stats.streak}</strong><span>连续打卡</span></div>
          <div><strong>{stats.masteredCount}</strong><span>已掌握</span></div>
          <div><strong>{stats.studyDays}</strong><span>累计天数</span></div>
          <div><strong>{stats.wrongCount}</strong><span>待巩固</span></div>
        </div>
      </header>

      <div className="profile-settings">
        <div className="profile-tabs" role="tablist" aria-label="设置分类">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`profile-tab ${tab === item.id ? 'active' : ''}`}
              onClick={() => switchTab(item.id)}
            >
              <Icon name={item.icon} size={17} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>

        {detail ? (
          <section className="panel profile-detail" key={detail} aria-label={DETAIL_TITLES[detail]}>
            <div className="profile-detail-head">
              <button type="button" className="icon-btn" onClick={() => setDetail(null)} aria-label="返回设置列表">
                <Icon name="chevronLeft" size={20} />
              </button>
              <div>
                <span className="eyebrow">{activeTab.label}</span>
                <h2>{DETAIL_TITLES[detail]}</h2>
              </div>
            </div>
            <div className="profile-detail-body">{renderDetail()}</div>
          </section>
        ) : (
          <section className="panel profile-panel" key={tab} aria-label={TAB_META[tab].title}>
            <div className="profile-panel-head">
              <div>
                <span className="eyebrow">{activeTab.label}</span>
                <h2>{TAB_META[tab].title}</h2>
              </div>
              <div className="panel-head-side">
                {tab === 'data' ? <span className="data-size">{customCount} 词条</span> : null}
                <span className="panel-hint">{TAB_META[tab].hint}</span>
              </div>
            </div>
            <div className="settings-list">{renderCells()}</div>
          </section>
        )}
      </div>

      <input
        ref={fontInputRef}
        type="file"
        accept=".ttf,.otf,.woff,.woff2"
        hidden
        onChange={(e) => handleFontUpload(e.target.files?.[0])}
      />
      <input
        ref={importRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => importData(e.target.files?.[0])}
      />

      <footer className="profile-foot">
        <span>WordVault · 本地优先的英语学习工具</span>
        <span>数据仅存于此设备</span>
      </footer>
    </div>
  )
}
