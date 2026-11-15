import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { ReviewRecord, createRecord, schedule } from '../model/Review';

export interface AppSettings {
  dailyNew: number;
  /** 每日复习上限，0 表示不限 */
  dailyReview: number;
  tts: boolean;
  bookId: string;
}

export interface StoreState {
  records: ReviewRecord[];
  settings: AppSettings;
  day: string;
  newDone: number;
  reviewDone: number;
  streak: number;
  lastDay: string;
  wrongIds: string[];
}

const DAY_MS: number = 86400000;

function dayKey(now: number): string {
  const date: Date = new Date(now);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function defaultState(): StoreState {
  return {
    records: [],
    settings: {
      dailyNew: 20,
      dailyReview: 100,
      tts: true,
      bookId: 'cet4'
    },
    day: dayKey(Date.now()),
    newDone: 0,
    reviewDone: 0,
    streak: 0,
    lastDay: '',
    wrongIds: []
  };
}

export class StudyStore {
  private static instance: StudyStore = new StudyStore();

  static get(): StudyStore {
    return StudyStore.instance;
  }

  private filePath: string = '';
  private stateValue: StoreState = defaultState();

  get state(): StoreState {
    return this.stateValue;
  }

  init(context: common.UIAbilityContext): void {
    if (this.filePath.length > 0) {
      return;
    }
    this.filePath = `${context.filesDir}/wordvault-state.json`;
    try {
      if (fileIo.accessSync(this.filePath)) {
        const raw: string = fileIo.readTextSync(this.filePath);
        if (raw.length > 0) {
          this.stateValue = JSON.parse(raw) as StoreState;
        }
      }
    } catch (err) {
      console.error(`WordVault: failed to restore state: ${JSON.stringify(err)}`);
      this.stateValue = defaultState();
    }
    this.rollover();
  }

  review(wordId: string, quality: number): ReviewRecord {
    this.rollover();
    const now: number = Date.now();
    const index: number = this.stateValue.records.findIndex((record: ReviewRecord) => record.wordId === wordId);
    const isNew: boolean = index < 0;
    const existing: ReviewRecord = isNew ? createRecord(wordId, now) : this.stateValue.records[index];
    const next: ReviewRecord = schedule(existing, quality, now);

    if (isNew) {
      this.stateValue.records.push(next);
      this.stateValue.newDone += 1;
    } else {
      this.stateValue.records[index] = next;
      this.stateValue.reviewDone += 1;
    }

    const wrongIndex: number = this.stateValue.wrongIds.indexOf(wordId);
    if (quality < 3) {
      if (wrongIndex < 0) {
        this.stateValue.wrongIds.push(wordId);
      }
    } else if (next.reps >= 3 && wrongIndex >= 0) {
      this.stateValue.wrongIds.splice(wrongIndex, 1);
    }

    if (this.stateValue.lastDay !== this.stateValue.day) {
      const yesterday: string = dayKey(now - DAY_MS);
      this.stateValue.streak = this.stateValue.lastDay === yesterday ? this.stateValue.streak + 1 : 1;
      this.stateValue.lastDay = this.stateValue.day;
    }

    this.save();
    return next;
  }

  setDailyNew(value: number): void {
    this.stateValue.settings.dailyNew = value;
    this.save();
  }

  setDailyReview(value: number): void {
    this.stateValue.settings.dailyReview = value;
    this.save();
  }

  setTts(value: boolean): void {
    this.stateValue.settings.tts = value;
    this.save();
  }

  setBook(bookId: string): void {
    this.stateValue.settings.bookId = bookId;
    this.save();
  }

  reset(): void {
    this.stateValue = defaultState();
    this.save();
  }

  private rollover(): void {
    const today: string = dayKey(Date.now());
    if (this.stateValue.day === today) {
      return;
    }
    const yesterday: string = dayKey(Date.now() - DAY_MS);
    if (this.stateValue.lastDay !== today && this.stateValue.lastDay !== yesterday) {
      this.stateValue.streak = 0;
    }
    this.stateValue.day = today;
    this.stateValue.newDone = 0;
    this.stateValue.reviewDone = 0;
    this.save();
  }

  private save(): void {
    if (this.filePath.length === 0) {
      return;
    }
    try {
      const file: fileIo.File = fileIo.openSync(this.filePath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      fileIo.writeSync(file.fd, JSON.stringify(this.stateValue));
      fileIo.closeSync(file);
    } catch (err) {
      console.error(`WordVault: failed to persist state: ${JSON.stringify(err)}`);
    }
  }
}
