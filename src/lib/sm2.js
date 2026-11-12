export const QUALITY = {
  again: 1,
  hard: 3,
  good: 4,
  easy: 5,
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/**
 * SM-2 spaced repetition. A failed recall resets repetitions and returns
 * the card in ten minutes so it can be retried in the same session.
 */
export function schedule(record, quality, now = Date.now()) {
  let ease = record?.ease ?? 2.5
  let interval = record?.interval ?? 0
  let reps = record?.reps ?? 0

  ease = round2(Math.max(1.3, ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))))

  if (quality < 3) {
    reps = 0
    interval = 0
    return {
      ease,
      interval,
      reps,
      due: now + 10 * 60 * 1000,
      lastQuality: quality,
    }
  }

  reps += 1
  if (reps === 1) interval = 1
  else if (reps === 2) interval = 6
  else interval = Math.max(1, Math.round(interval * ease))

  return {
    ease,
    interval,
    reps,
    due: now + interval * 86400000,
    lastQuality: quality,
  }
}

const MIN = 60 * 1000
const DAY = 86400000

function humanize(ms) {
  if (ms < 60 * MIN) return `${Math.max(1, Math.round(ms / MIN))} 分钟`
  const days = Math.round(ms / DAY)
  if (days < 30) return `${days} 天`
  if (days < 365) return `${Math.round(days / 30)} 个月`
  return `${Math.round(days / 365)} 年`
}

export function intervalPreview(record, quality) {
  const next = schedule(record, quality)
  return humanize(next.due - Date.now())
}

export function nextReviewLabel(record) {
  if (!record?.due) return '尚未安排'
  const diff = record.due - Date.now()
  if (diff <= 0) return '现在复习'
  return `${humanize(diff)}后复习`
}
