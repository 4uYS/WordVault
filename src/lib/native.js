/**
 * Android WebView 原生桥接。
 * 单文件 APK 里 Notification API 与 <a download> 都不可用，
 * 因此导出备份与系统通知走这里注入的 WordVaultNative。
 */

const bridge = typeof window !== 'undefined' ? window.WordVaultNative : null

export function isNativeApp() {
  return Boolean(bridge)
}

function call(name, ...args) {
  if (!bridge || typeof bridge[name] !== 'function') return null
  try {
    return bridge[name](...args)
  } catch {
    return null
  }
}

export function nativePlatform() {
  return call('platform') || ''
}

export function notificationStatus() {
  return call('notificationStatus') || 'unsupported'
}

export function requestNotificationPermission() {
  call('requestNotificationPermission')
}

export function notifyNow(title, body) {
  return call('notifyNow', title, body) !== null
}

export function scheduleDailyReminder(hhmm, title, body) {
  return call('scheduleDailyReminder', hhmm, title, body) !== null
}

export function cancelDailyReminder() {
  call('cancelDailyReminder')
}

/** 成功交给原生层后返回 true，调用方据此跳过浏览器下载逻辑。 */
export function exportBackupNative(filename, content) {
  return call('exportBackup', filename, content) !== null
}
