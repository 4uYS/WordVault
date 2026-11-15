/**
 * 附近设备同步 · 纯协议层（无浏览器依赖，可在 Node 中自检）。
 * BLE beacon 编解码、局域网地址校验、peer 构造都集中在这里，
 * Android 端 NearbyBridge.java 用同样的字节布局实现。
 */

export const NEARBY_SERVICE_UUID = '0000fa57-0000-1000-8000-00805f9b34fb'
export const NEARBY_CHAR_UUID = '0000fa58-0000-1000-8000-00805f9b34fb'
export const NEARBY_DEFAULT_PORT = 8765
/**
 * BLE 广播包只有 31 字节：Flags AD(3) + 128-bit Service UUID(16) + AD 头(2)
 * 已占 21，Service Data 最多再放 10 字节。用 9 字节留 1 字节余量。
 */
export const NEARBY_BEACON_SIZE = 9

const MAGIC = 0x57  // 'W'
const VERSION = 1

/* ---------------- 纯协议函数（可离线自检） ---------------- */

export function ipToBytes(ip) {
  const parts = String(ip || '').trim().split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return nums
}

export function bytesToIp(bytes) {
  if (!bytes || bytes.length < 4) return null
  return Array.from(bytes.slice(0, 4)).join('.')
}

/** FNV-1a 32 位，取低 16 位做设备短名，避免放进昵称等个人信息 */
export function hashName(name) {
  let h = 0x811c9dc5
  for (let i = 0; i < String(name).length; i += 1) {
    h ^= String(name).charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h & 0xffff
}

/**
 * Beacon 布局（9 字节）：
 *  0    magic 'W'
 *  1    version
 *  2-5  IPv4      4 bytes
 *  6-7  port      uint16 大端
 *  8    flags     bit0 可接收 / bit1 已托管备份
 */
export function encodeBeacon({ ip, port = NEARBY_DEFAULT_PORT, flags = 1 }) {
  const ipb = ipToBytes(ip)
  if (!ipb) return null
  const p = Number(port)
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null
  const out = new Uint8Array(NEARBY_BEACON_SIZE)
  out[0] = MAGIC
  out[1] = VERSION
  out[2] = ipb[0]; out[3] = ipb[1]; out[4] = ipb[2]; out[5] = ipb[3]
  out[6] = (p >> 8) & 0xff
  out[7] = p & 0xff
  out[8] = flags & 0xff
  return out
}

export function decodeBeacon(input) {
  let bytes = input
  if (bytes instanceof DataView) {
    bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  } else if (bytes instanceof ArrayBuffer) {
    bytes = new Uint8Array(bytes)
  }
  if (!bytes || bytes.length < NEARBY_BEACON_SIZE) return null
  const b = Uint8Array.from(bytes.slice(0, NEARBY_BEACON_SIZE))
  if (b[0] !== MAGIC || b[1] !== VERSION) return null
  const ip = bytesToIp(b.slice(2, 6))
  if (!ip) return null
  const port = (b[6] << 8) | b[7]
  if (port < 1 || port > 65535) return null
  return {
    ip, port, flags: b[8],
    hasBackup: Boolean(b[8] & 2), canReceive: Boolean(b[8] & 1),
  }
}

export function peerFromBeacon(decoded, source = 'ble') {
  if (!decoded) return null
  const { ip, port, hasBackup, canReceive } = decoded
  return {
    id: `${ip}:${port}`,
    name: `WordVault · ${ip.split('.').pop()}`,
    ip, port, hasBackup, canReceive, source,
    url: `http://${ip}:${port}`,
  }
}

/** 手动输入 "192.168.1.5" / "192.168.1.5:8765" 归一化 */
export function parseManualEndpoint(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const m = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/)
  if (!m) return null
  const ip = ipToBytes(m[1])
  if (!ip) return null
  const port = m[2] ? Number(m[2]) : NEARBY_DEFAULT_PORT
  if (port < 1 || port > 65535) return null
  return {
    id: `${ip.join('.')}:${port}`,
    name: `手动添加 · ${ip.join('.')}:${port}`,
    ip: ip.join('.'), port, hasBackup: true, canReceive: true,
    source: 'manual', url: `http://${ip.join('.')}:${port}`,
  }
}

/** 只允许局域网/本机地址，防止把备份发到公网 */
export function isLanAddress(ip) {
  const b = ipToBytes(ip)
  if (!b) return false
  if (b[0] === 127 || b[0] === 10) return true
  if (b[0] === 192 && b[1] === 168) return true
  if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return true
  if (b[0] === 169 && b[1] === 254) return true
  return false
}

