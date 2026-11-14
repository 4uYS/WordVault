import { exportBackupNative, isNativeApp } from './native'

/**
 * 导出学习记录。
 * 浏览器里直接下载文件；Android 单文件 WebView 里走原生分享面板，
 * 返回值 'native' | 'web' 供调用方决定提示文案。
 */
export function downloadBackup(state) {
  const payload = {
    app: 'WordVault',
    version: 1,
    exportedAt: new Date().toISOString(),
    data: state,
  }
  const stamp = new Date().toISOString().slice(0, 10)
  const filename = `wordvault-backup-${stamp}.json`
  const text = JSON.stringify(payload, null, 2)

  if (isNativeApp() && exportBackupNative(filename, text)) {
    return 'native'
  }

  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return 'web'
}

export function parseBackup(text) {
  const json = JSON.parse(text)
  if (json?.app !== 'WordVault' || !json?.data?.profile) {
    throw new Error('不是有效的 WordVault 备份文件')
  }
  return json.data
}
