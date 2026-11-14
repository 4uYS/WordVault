import { useCallback, useEffect, useMemo, useState } from 'react'
import { useApp } from './AppContext'
import { UIContext } from './UIContext'
import { Icon, LogoMark } from './components/Icons'
import Onboarding from './components/Onboarding'
import WordDetail from './components/WordDetail'
import SelectionPopup from './components/SelectionPopup'
import Home from './pages/Home'
import Library from './pages/Library'
import SearchPage from './pages/SearchPage'
import Profile from './pages/Profile'
import Study from './pages/Study'
import Practice from './pages/Practice'
import WrongBook from './pages/WrongBook'
import AiChat from './pages/AiChat'
import { todayKey } from './lib/date'
import { cancelDailyReminder, isNativeApp, scheduleDailyReminder } from './lib/native'
import './styles.css'

function currentRoute() {
  const raw = window.location.hash.replace(/^#\/?/, '')
  return raw || 'home'
}

function ReminderWatcher() {
  const { state, stats } = useApp()
  const native = isNativeApp()

  // Android 原生层：把每日提醒交给 AlarmManager，关闭应用也能收到
  useEffect(() => {
    if (!native) return undefined
    const reminder = state.profile?.reminderTime
    if (!reminder || state.profile?.notify === false) {
      cancelDailyReminder()
      return undefined
    }
    scheduleDailyReminder(
      reminder,
      'WordVault 每日学习提醒',
      '该复习今天的单词了，打开应用完成今日任务。',
    )
    return undefined
  }, [native, state.profile?.reminderTime, state.profile?.notify])

  useEffect(() => {
    if (native) return undefined
    const reminder = state.profile?.reminderTime
    if (!reminder || state.profile?.notify === false || !('Notification' in window)) return undefined
    const check = () => {
      if (Notification.permission !== 'granted') return
      const now = new Date()
      const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      if (clock < reminder) return
      const storageKey = `wordvault.reminder.${todayKey()}`
      if (localStorage.getItem(storageKey)) return
      const remainingNew = stats.newRemaining
      const due = stats.dueCount
      if (remainingNew <= 0 && due <= 0) return
      try {
        new Notification('WordVault 每日学习提醒', {
          body: `今日还有 ${remainingNew} 个新词与 ${due} 个复习词待完成。`,
          tag: 'wordvault-daily',
        })
        localStorage.setItem(storageKey, '1')
      } catch {
        // Notification may be blocked by the browser despite permission.
      }
    }
    check()
    const timer = window.setInterval(check, 30000)
    return () => window.clearInterval(timer)
  }, [native, state.profile?.reminderTime, state.profile?.notify, stats.newRemaining, stats.dueCount])

  return null
}

function BottomNav({ route, navigate }) {
  const tabs = [
    { id: 'home', label: '今日', icon: 'home' },
    { id: 'library', label: '词库', icon: 'book' },
    { id: 'search', label: '查词', icon: 'search' },
    { id: 'ai', label: 'AI', icon: 'spark' },
    { id: 'profile', label: '我的', icon: 'user' },
  ]
  const base = route.split('/')[0].split('?')[0]
  return (
    <nav className="bottom-nav" aria-label="主导航">
      <div className="bottom-nav-inner">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`nav-item ${base === tab.id ? 'active' : ''}`}
            onClick={() => navigate(tab.id)}
            aria-current={base === tab.id ? 'page' : undefined}
          >
            <Icon name={tab.icon} size={22} />
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}

function AppHeader({ navigate, theme }) {
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <button className="brand" onClick={() => navigate('home')} aria-label="返回首页">
          <LogoMark size={34} />
          <span className="brand-text">
            <strong>WordVault</strong>
            <small>词库宝箱</small>
          </span>
        </button>
        <div className="header-actions">
          <span className="local-badge">
            <Icon name="lock" size={13} />
            本地存储
          </span>
          <button className="icon-btn" onClick={() => navigate('search')} aria-label="查词">
            <Icon name="search" size={21} />
          </button>
          <button className="icon-btn" aria-label="切换深色模式" onClick={() => navigate('theme')}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={20} />
          </button>
        </div>
      </div>
    </header>
  )
}

function Shell({ route, navigate, setDetailWord }) {
  const { state, dispatch } = useApp()
  const base = route.split('/')[0].split('?')[0]
  const focus = ['study', 'practice', 'wrong'].includes(base)
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'light')

  useEffect(() => {
    const target = state.settings.theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : state.settings.theme
    setTheme(target)
  }, [state.settings.theme])

  useEffect(() => {
    if (route === 'theme') {
      const next = theme === 'dark' ? 'light' : 'dark'
      dispatch({ type: 'UPDATE_SETTINGS', patch: { theme: next } })
      navigate(base === 'theme' ? 'home' : base)
    }
  }, [route, theme, dispatch, navigate, base])

  let page = null
  if (base === 'home') page = <Home navigate={navigate} openWord={setDetailWord} />
  else if (base === 'library') page = <Library navigate={navigate} openWord={setDetailWord} />
  else if (base === 'search') page = <SearchPage openWord={setDetailWord} />
  else if (base === 'ai') page = <AiChat navigate={navigate} />
  else if (base === 'profile') page = <Profile openWord={setDetailWord} />
  else if (base === 'study') page = <Study navigate={navigate} openWord={setDetailWord} />
  else if (base === 'practice') page = <Practice navigate={navigate} openWord={setDetailWord} mode={route.split('/')[1] || ''} />
  else if (base === 'wrong') page = <WrongBook navigate={navigate} openWord={setDetailWord} />
  else page = <Home navigate={navigate} openWord={setDetailWord} />

  return (
    <div className="app-shell">
      {!focus && <AppHeader navigate={navigate} theme={theme} />}
      <main className={`app-main ${focus ? 'app-main-focus' : ''}`}>
        <div key={route} className="page-transition">
          {page}
        </div>
      </main>
      {!focus && <BottomNav route={route} navigate={navigate} />}
      <ReminderWatcher />
    </div>
  )
}

function Toast({ message }) {
  if (!message) return null
  return (
    <div className="toast" role="status">
      <Icon name="check" size={17} />
      <span>{message}</span>
    </div>
  )
}

export default function App() {
  const { state } = useApp()
  const [route, setRoute] = useState(currentRoute)
  const [detailWord, setDetailWord] = useState(null)
  const [toast, setToast] = useState('')

  useEffect(() => {
    const onChange = () => {
      setRoute(currentRoute())
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', onChange)
    if (!window.location.hash) window.location.hash = '/home'
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(''), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  const navigate = useCallback((path) => {
    const next = `#/${String(path).replace(/^\/+/, '')}`
    if (window.location.hash === next) {
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } else {
      window.location.hash = next
    }
    window.scrollTo({ top: 0 })
  }, [])

  const openWord = useCallback((word) => {
    setDetailWord(typeof word === 'string' ? word : word?.w || '')
  }, [])

  const showToast = useCallback((message) => setToast(message), [])

  const ui = useMemo(
    () => ({ navigate, openWord, showToast }),
    [navigate, openWord, showToast],
  )

  if (!state.profile) {
    return <Onboarding />
  }

  return (
    <UIContext.Provider value={ui}>
      <Shell route={route} navigate={navigate} setDetailWord={openWord} />
      {detailWord && <WordDetail word={detailWord} onClose={() => setDetailWord(null)} />}
      <SelectionPopup />
      <Toast message={toast} />
    </UIContext.Provider>
  )
}
