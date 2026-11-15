import { useEffect, useRef, useState } from 'react'
import { useApp } from '../AppContext'
import { useUI } from '../UIContext'
import { Icon } from '../components/Icons'
import { serializeBackup, parseBackup } from '../lib/backup'
import {
  NEARBY_DEFAULT_PORT,
  NEARBY_MODE_LABELS,
  hostBackup,
  isLanAddress,
  localEndpoint,
  nearbyMode,
  onReceivedBackup,
  parseManualEndpoint,
  pingPeer,
  pullBackup,
  pushBackup,
  startDiscovery,
} from '../lib/nearby'

/** 我的 → 本地数据 → 附近设备传输 */
export default function NearbyPanel() {
  const { state, dispatch } = useApp()
  const { showToast } = useUI()
  const mode = nearbyMode()

  const [endpoint, setEndpoint] = useState(() => localEndpoint())
  const [peers, setPeers] = useState([])
  const [scanning, setScanning] = useState(false)
  const [status, setStatus] = useState('')
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState('')
  const [pendingText, setPendingText] = useState('')
  const stopRef = useRef(null)

  const upsertPeer = (incoming) => {
    if (!Array.isArray(incoming)) return
    setPeers((prev) => {
      const map = new Map(prev.map((p) => [p.id, p]))
      for (const p of incoming) {
        if (!p?.id || !isLanAddress(p.ip)) continue
        map.set(p.id, { ...map.get(p.id), ...p, seenAt: Date.now() })
      }
      return Array.from(map.values()).filter(
        (p) => Date.now() - (p.seenAt || 0) < 45000,
      )
    })
  }

  // 对端推送过来的备份不静默覆盖，先弹确认卡片
  useEffect(() => onReceivedBackup((text) => {
    try {
      parseBackup(text)
      setPendingText(text)
      showToast('收到一台设备发来的备份，请确认后导入')
    } catch {
      showToast('收到的备份格式不正确，已忽略')
    }
  }), [showToast])

  useEffect(() => {
    if (typeof window === 'undefined') return () => {}
    const listener = (event) => {
      if (typeof event?.detail === 'string' && event.detail) setStatus(event.detail)
      setEndpoint(localEndpoint())
    }
    window.addEventListener('wordvault:nearby-status', listener)
    return () => window.removeEventListener('wordvault:nearby-status', listener)
  }, [])

  useEffect(() => () => { stopRef.current?.() }, [])

  const start = async () => {
    if (scanning) return
    setScanning(true)
    setStatus('')
    // 把本机备份交给原生服务托管，蓝牙广播里会标记「已备好备份」
    if (mode === 'native') hostBackup(serializeBackup(state))
    stopRef.current = await startDiscovery(upsertPeer, setStatus)
    setEndpoint(localEndpoint())
  }

  const stop = () => {
    stopRef.current?.()
    stopRef.current = null
    setScanning(false)
    setStatus('已停止扫描')
  }

  const addManual = () => {
    const peer = parseManualEndpoint(manual)
    if (!peer) {
      showToast('请填写正确的局域网地址，如 192.168.1.5:8765')
      return
    }
    if (!isLanAddress(peer.ip)) {
      showToast('只允许输入局域网地址')
      return
    }
    upsertPeer([peer])
    setManual('')
    showToast('已添加设备')
  }

  const withBusy = async (key, fn) => {
    if (busy) return
    setBusy(key)
    try { await fn() } catch (err) {
      showToast(err?.message || '操作失败，请确认两台设备在同一 Wi-Fi')
    } finally { setBusy('') }
  }

  const receive = (peer) => withBusy(`pull:${peer.id}`, async () => {
    await pingPeer(peer)
    const { data } = await pullBackup(peer)
    if (!window.confirm(`从 ${peer.name} 导入备份？会覆盖本机的学习记录与画像。`)) return
    dispatch({ type: 'IMPORT_STATE', data })
    showToast('备份已导入')
  })

  const send = (peer) => withBusy(`push:${peer.id}`, async () => {
    await pingPeer(peer)
    const text = serializeBackup(state)
    await pushBackup(peer, text)
    showToast('已发送，请在对方设备上确认导入')
  })

  const confirmPending = () => {
    if (!pendingText) return
    try {
      const data = parseBackup(pendingText)
      dispatch({ type: 'IMPORT_STATE', data })
      setPendingText('')
      showToast('备份已导入')
    } catch {
      showToast('备份解析失败')
    }
  }

  return (
    <div className="detail-section">
      <div className="section-head compact">
        <div>
          <span className="setting-label">设备发现方式</span>
          <span className="tiny-note">{NEARBY_MODE_LABELS[mode]}</span>
        </div>
        <span className="data-size">{endpoint ? endpoint.label : '仅接收 / 发送'}</span>
      </div>

      <p className="setting-help">
        蓝牙只负责发现附近设备（广播本机局域网地址），学习备份通过同一 Wi-Fi 直连传输，
        不经过任何外部服务器。两台设备需连接同一个局域网。
      </p>

      <div className="ai-actions">
        {scanning ? (
          <button className="btn btn-outlined btn-sm" onClick={stop}>停止扫描</button>
        ) : (
          <button className="btn btn-primary btn-sm" onClick={start}>
            <Icon name="refresh" size={15} /> 扫描附近设备
          </button>
        )}
      </div>
      {status && <p className="setting-help">{status}</p>}

      {mode === 'manual' && (
        <p className="setting-help">
          当前浏览器既没有原生蓝牙桥接也不支持 Web Bluetooth，请直接在下方填写对方显示的 IP:端口。
        </p>
      )}

      {peers.length === 0 ? (
        <div className="ai-output">
          <p className="ai-explain">
            {scanning ? '正在寻找附近的 WordVault…' : '还没有发现设备。点「扫描附近设备」，或手动添加地址。'}
          </p>
        </div>
      ) : peers.map((peer) => (
        <div className="ai-quiz-entry" key={peer.id}>
          <div>
            <strong>{peer.name}</strong>
            <span>{peer.ip}:{peer.port} · {peer.source === 'manual' ? '手动' : '蓝牙发现'}</span>
            <p className="ai-explain">
              {peer.hasBackup ? '已备好备份，可直接接收' : '可接收你发送的备份'}
            </p>
          </div>
          <div className="ai-quiz-actions">
            <button
              className="btn btn-outlined btn-sm"
              disabled={Boolean(busy)}
              onClick={() => receive(peer)}
            >
              <Icon name="download" size={14} /> 接收
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={Boolean(busy)}
              onClick={() => send(peer)}
            >
              <Icon name="upload" size={14} /> 发送
            </button>
          </div>
        </div>
      ))}

      <div className="section-head compact">
        <div>
          <span className="setting-label">手动添加设备</span>
          <span className="tiny-note">默认端口 {NEARBY_DEFAULT_PORT}</span>
        </div>
      </div>
      <div className="ai-actions">
        <input
          className="nearby-ip-input"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addManual() }}
          placeholder="192.168.1.5:8765"
          inputMode="decimal"
        />
        <button className="btn btn-outlined btn-sm" onClick={addManual}>添加</button>
      </div>

      {pendingText && (
        <>
          <div className="section-head compact">
            <div>
              <span className="setting-label">收到一份备份</span>
              <span className="tiny-note">确认后才会覆盖本机数据</span>
            </div>
            <span className="data-size">{(pendingText.length / 1024).toFixed(0)} KB</span>
          </div>
          <div className="ai-quiz-entry">
            <div>
              <strong>确认导入</strong>
              <span>来自同一局域网的另一台设备</span>
            </div>
            <div className="ai-quiz-actions">
              <button className="btn btn-primary btn-sm" onClick={confirmPending}>确认导入</button>
              <button className="btn btn-text btn-sm" onClick={() => setPendingText('')}>忽略</button>
            </div>
          </div>
        </>
      )}

      <p className="setting-help">
        <Icon name="lock" size={13} /> 接收端永远需要你点一次确认；局域网服务端只在扫描期间开启。
        Android 设备可被发现并收发，桌面浏览器可扫描 Android 并向其收发；iOS Safari 请使用手动地址或文件备份。
      </p>
    </div>
  )
}
