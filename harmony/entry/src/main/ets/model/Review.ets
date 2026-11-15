export enum Quality {
  Again = 1,
  Hard = 3,
  Good = 4,
  Easy = 5
}

export interface ReviewRecord {
  wordId: string;
  ease: number;
  interval: number;
  reps: number;
  due: number;
  lastQuality: number;
  learnedAt: number;
  wrongCount: number;
}

const MINUTE_MS: number = 60 * 1000;
const DAY_MS: number = 86400000;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function createRecord(wordId: string, now: number): ReviewRecord {
  return {
    wordId: wordId,
    ease: 2.5,
    interval: 0,
    reps: 0,
    due: now,
    lastQuality: 0,
    learnedAt: now,
    wrongCount: 0
  };
}

/**
 * Ported from src/lib/sm2.js. A failed recall resets repetitions and returns
 * the card in ten minutes so it can be retried soon.
 */
export function schedule(record: ReviewRecord, quality: number, now: number): ReviewRecord {
  let ease: number = record.ease;
  let interval: number = record.interval;
  let reps: number = record.reps;
  const wrongCount: number = record.wrongCount;

  ease = round2(Math.max(1.3, ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))));

  if (quality < 3) {
    return {
      wordId: record.wordId,
      ease: ease,
      interval: 0,
      reps: 0,
      due: now + 10 * MINUTE_MS,
      lastQuality: quality,
      learnedAt: record.learnedAt,
      wrongCount: wrongCount + 1
    };
  }

  reps += 1;
  if (reps === 1) {
    interval = 1;
  } else if (reps === 2) {
    interval = 6;
  } else {
    interval = Math.max(1, Math.round(interval * ease));
  }

  return {
    wordId: record.wordId,
    ease: ease,
    interval: interval,
    reps: reps,
    due: now + interval * DAY_MS,
    lastQuality: quality,
    learnedAt: record.learnedAt,
    wrongCount: wrongCount
  };
}
