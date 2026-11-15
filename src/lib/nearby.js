import { isNativeApp } from './native'
import { parseBackup } from './backup'
import {
  NEARBY_SERVICE_UUID,
  decodeBeacon,
  isLanAddress,
} from './nearbyProtocol'

export {
  NEARBY_SERVICE_UUID,
  NEARBY_DEFAULT_PORT,
  NEARBY_BEACON_SIZE,
  decodeBeacon,
  isLanAddress,
  parseManualEndpoint,
  peerFromBeacon,
  encodeBeacon,
  ipToBytes,
  bytesToIp,
} from './nearbyProtocol'

/* ---------------- 平台适配 ---------------- */

function bridge() {
  if (typeof window === 'undefined') return null
  return window.WordVaultNative || null
}

function nativeCall(name, ...args) {
  const b = bridge()
  if (!b || typeof b[name] !== 'function') return null
  try { return b[name](...args) } catch { return null }
}

export function nearbyMode() {
  if (isNativeApp()) return 'native'
  if (typeof navigator !== 'undefined' && navigator.bluetooth) return 'web-bluetooth'
  return 'manual'
}

export const NEARBY_MODE_LABELS = {
  native: 'Android 原生蓝牙',
  'web-bluetooth': '浏览器蓝牙',
  manual: '手动输入地址',
}

/** 本机 HTTP 端点（仅 Android 有服务端） */
export function localEndpoint() {
  const raw = nativeCall('nearbyEndpoint')
  if (!raw) return null
  const m = String(raw).match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/)
  if (!m) return null
  return { ip: m[1], port: Number(m[2]), label: raw }
}

/** 把本机备份交给原生 HTTP 服务托管，供对端 GET 拉取 */
export function hostBackup(text) {
  const ok = nativeCall('nearbySetBackup', text)
  return ok !== null
}

export function startNativeDiscovery() {
  return nativeCall('nearbyStart')
}

export function stopNativeDiscovery() {
  return nativeCall('nearbyStop')
}

/** 监听原生层扫描到的对端；返回取消订阅函数 */
export function onNativePeers(handler) {
  if (typeof window === 'undefined') return () => {}
  const listener = (event) => {
    const list = event?.detail
    if (Array.isArray(list)) handler(list)
  }
  window.addEventListener('wordvault:nearby-peers', listener)
  return () => window.removeEventListener('wordvault:nearby-peers', listener)
}

/** 监听对端 POST 推来的备份；返回取消订阅函数 */
export function onReceivedBackup(handler) {
  if (typeof window === 'undefined') return () => {}
  const listener = (event) => {
    const text = event?.detail
    if (typeof text === 'string' && text) handler(text)
  }
  window.addEventListener('wordvault:nearby-received', listener)
  return () => window.removeEventListener('wordvault:nearby-received', listener)
}

/**
 * 浏览器端 Web Bluetooth 扫描。
 * requestLEScan 可用时读 advertisement 的 Service Data；
 * 不支持时退化为 requestDevice 让用户选一台设备（随后手动填 IP）。
 */
export async function startWebBluetoothScan(onPeers, onStatus) {
  const bt = typeof navigator !== 'undefined' ? navigator.bluetooth : null
  if (!bt) {
    onStatus?.('当前浏览器不支持 Web Bluetooth，请手动输入对方地址')
    return () => {}
  }
  if (typeof bt.requestLEScan === 'function') {
    try {
      // 广播里只有 Service Data（没有单独占位的 Service UUID 字段），
      // 因此不加 service filter，扫到后按 magic 过滤，避免 31 字节超限。
      const scan = await bt.requestLEScan({
        acceptAllDevices: true,
        keepRepeatedDevices: true,
      })
      const listener = (event) => {
        const view = event?.serviceData?.get?.(NEARBY_SERVICE_UUID)
          || event?.serviceData?.get?.(NEARBY_SERVICE_UUID.toUpperCase())
        const peer = peerFromBeacon(decodeBeacon(view), 'ble')
        if (peer && isLanAddress(peer.ip)) onPeers([peer])
      }
      bt.addEventListener('advertisementreceived', listener)
      onStatus?.('正在通过蓝牙扫描附近的 WordVault 设备')
      return () => {
        bt.removeEventListener('advertisementreceived', listener)
        try { scan.stop() } catch { /* 已停止 */ }
      }
    } catch (err) {
      onStatus?.(`蓝牙扫描未启动：${err?.message || '权限被拒绝'}，可手动输入地址`)
    }
  }
  // 退化路径：只做设备选择，地址仍需手动填
  try {
    await bt.requestDevice({ acceptAllDevices: true, optionalServices: [NEARBY_SERVICE_UUID] })
    onStatus?.('已选择设备，请在下方填写对方的局域网 IP:端口')
  } catch (err) {
    onStatus?.(`未选择设备：${err?.message || '已取消'}，可手动输入地址`)
  }
  return () => {}
}

/** 统一扫描入口：返回停止函数 */
export async function startDiscovery(onPeers, onStatus) {
  const mode = nearbyMode()
  if (mode === 'native') {
    const stop = onNativePeers(onPeers)
    startNativeDiscovery()
    onStatus?.('正在广播本机地址并扫描附近设备')
    return () => { stopNativeDiscovery(); stop() }
  }
  if (mode === 'web-bluetooth') {
    return startWebBluetoothScan(onPeers, onStatus)
  }
  onStatus?.('当前环境无蓝牙发现能力，请在下方手动输入对方地址')
  return () => {}
}

/* ---------------- 局域网传输 ---------------- */

function assertPeer(peer) {
  const url = peer?.url
  if (!url || !isLanAddress(peer.ip)) {
    throw new Error('只允许连接局域网地址')
  }
  return url.replace(/\/$/, '')
}

async function request(url, options = {}, timeoutMs = 8000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    return await fetch(url, {
      ...options,
      ...(controller ? { signal: controller.signal } : {}),
      cache: 'no-store',
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function pingPeer(peer) {
  const res = await request(`${assertPeer(peer)}/wordvault/ping`)
  if (!res.ok) throw new Error(`设备无响应（HTTP ${res.status}）`)
  const json = await res.json()
  if (json?.app !== 'WordVault') throw new Error('对方不是 WordVault 设备')
  return json
}

/** 从对端拉取备份，返回校验后的 state（调用方再确认导入） */
export async function pullBackup(peer) {
  const res = await request(`${assertPeer(peer)}/wordvault/backup`)
  if (!res.ok) throw new Error(`拉取失败（HTTP ${res.status}）`)
  const text = await res.text()
  return { text, data: parseBackup(text) }
}

/** 把备份推送给对端，对端会在界面上弹确认，不会静默覆盖 */
export async function pushBackup(peer, text) {
  // 先自检一次，避免把坏数据推过去
  parseBackup(text)
  const res = await request(`${assertPeer(peer)}/wordvault/backup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: text,
  })
  if (!res.ok) throw new Error(`发送失败（HTTP ${res.status}）`)
  return true
}
