export const DAY_MS = 86400000

export function dateKey(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayKey() {
  return dateKey(new Date())
}

export function startOfDay(input = new Date()) {
  const d = new Date(input)
  d.setHours(0, 0, 0, 0)
  return d
}

export function addDays(input, n) {
  const d = new Date(input)
  d.setDate(d.getDate() + n)
  return d
}

export function formatShortDate(key) {
  const d = new Date(`${key}T00:00:00`)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function weekDays() {
  const today = startOfDay(new Date())
  return Array.from({ length: 7 }, (_, i) => dateKey(addDays(today, i - 6)))
}

export function weekdayLabel(key) {
  const labels = ['日', '一', '二', '三', '四', '五', '六']
  return labels[new Date(`${key}T00:00:00`).getDay()]
}

export function computeStreak(activity) {
  let cursor = startOfDay(new Date())
  if (!activity[dateKey(cursor)]?.total) {
    cursor = addDays(cursor, -1)
    if (!activity[dateKey(cursor)]?.total) return 0
  }
  let streak = 0
  while (activity[dateKey(cursor)]?.total) {
    streak += 1
    cursor = addDays(cursor, -1)
  }
  return streak
}

export function activeDays(activity) {
  return Object.values(activity || {}).filter((d) => d.total > 0).length
}

export function formatMinutes(minutes) {
  const m = Math.round(minutes || 0)
  if (m < 60) return `${m} 分钟`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

export function clockNow() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
