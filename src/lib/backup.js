export function downloadBackup(state) {
  const payload = {
    app: 'WordVault',
    version: 1,
    exportedAt: new Date().toISOString(),
    data: state,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 10)
  a.href = url
  a.download = `wordvault-backup-${stamp}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function parseBackup(text) {
  const json = JSON.parse(text)
  if (json?.app !== 'WordVault' || !json?.data?.profile) {
    throw new Error('不是有效的 WordVault 备份文件')
  }
  return json.data
}
