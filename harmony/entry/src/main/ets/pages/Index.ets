import { common } from '@kit.AbilityKit';
import { promptAction } from '@kit.ArkUI';
import { Word } from '../model/Word';
import { ReviewRecord } from '../model/Review';
import { WordRepository } from '../data/WordRepository';
import { StudyStore, AppSettings, StoreState } from '../data/StudyStore';
import { Speech } from '../data/Speech';
import { HomeTab } from '../components/HomeTab';
import { LibraryTab, BookProgress } from '../components/LibraryTab';
import { WrongTab, WrongEntry } from '../components/WrongTab';
import { ProfileTab } from '../components/ProfileTab';
import { StudyView } from '../components/StudyView';
import { BRAND, BG, CARD, MUTED } from '../theme/Theme';

@Entry
@Component
struct Index {
  @State tabIndex: number = 0;
  @State words: Word[] = [];
  @State records: ReviewRecord[] = [];
  @State wrongIds: string[] = [];
  @State settings: AppSettings = {
    dailyNew: 20,
    dailyReview: 100,
    tts: true,
    bookId: 'cet4'
  };
  @State newDone: number = 0;
  @State reviewDone: number = 0;
  @State streak: number = 0;
  @State studying: boolean = false;
  @State queue: Word[] = [];
  @State queueIndex: number = 0;
  @State revealed: boolean = false;
  private controller: TabsController = new TabsController();
  private recordMap: Map<string, ReviewRecord> = new Map();

  aboutToAppear(): void {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    StudyStore.get().init(context);
    WordRepository.load(context);
    this.words = WordRepository.words.slice();
    this.sync();
  }

  onBackPress(): boolean {
    if (this.studying) {
      this.exitStudy();
      return true;
    }
    return false;
  }

  private sync(): void {
    const state: StoreState = StudyStore.get().state;
    this.records = state.records.slice();
    this.wrongIds = state.wrongIds.slice();
    this.newDone = state.newDone;
    this.reviewDone = state.reviewDone;
    this.streak = state.streak;
    this.settings = {
      dailyNew: state.settings.dailyNew,
      dailyReview: state.settings.dailyReview,
      tts: state.settings.tts,
      bookId: state.settings.bookId
    };
    const map: Map<string, ReviewRecord> = new Map();
    for (const record of this.records) {
      map.set(record.wordId, record);
    }
    this.recordMap = map;
  }

  private todayDone(): number {
    return this.newDone + this.reviewDone;
  }

  private dueCount(): number {
    const now: number = Date.now();
    let count: number = 0;
    for (const word of this.words) {
      const record: ReviewRecord | undefined = this.recordMap.get(word.id);
      if (record !== undefined && record.due <= now) {
        count += 1;
      }
    }
    return count;
  }

  private newRemaining(): number {
    return Math.max(0, this.settings.dailyNew - this.newDone);
  }

  private todayGoal(): number {
    const due: number = this.dueCount();
    const limit: number = this.settings.dailyReview;
    const reviews: number = limit > 0 ? Math.min(due, limit) : due;
    return this.settings.dailyNew + reviews;
  }

  private masteredCount(): number {
    let count: number = 0;
    for (const record of this.records) {
      if (record.reps >= 3) {
        count += 1;
      }
    }
    return count;
  }

  private currentBookName(): string {
    const book = WordRepository.getBook(this.settings.bookId);
    return book !== undefined ? book.name : '未选择';
  }

  private currentBookLearned(): number {
    let count: number = 0;
    for (const word of this.words) {
      if (word.book === this.settings.bookId && this.recordMap.has(word.id)) {
        count += 1;
      }
    }
    return count;
  }

  private currentBookTotal(): number {
    const book = WordRepository.getBook(this.settings.bookId);
    return book !== undefined ? book.total : 0;
  }

  private bookProgressList(): BookProgress[] {
    const list: BookProgress[] = [];
    for (const book of WordRepository.books) {
      let learned: number = 0;
      for (const word of this.words) {
        if (word.book === book.id && this.recordMap.has(word.id)) {
          learned += 1;
        }
      }
      list.push({
        id: book.id,
        name: book.name,
        short: book.short,
        desc: book.desc,
        color: book.color,
        total: book.total,
        learned: learned,
        current: this.settings.bookId === book.id
      });
    }
    return list;
  }

  private wrongEntries(): WrongEntry[] {
    const list: WrongEntry[] = [];
    for (const id of this.wrongIds) {
      const word: Word | undefined = WordRepository.getWord(id);
      const record: ReviewRecord | undefined = this.recordMap.get(id);
      if (word !== undefined) {
        list.push({
          id: id,
          word: word.word,
          meaning: `${word.pos} ${word.meaning}`,
          wrongCount: record !== undefined ? Math.max(1, record.wrongCount) : 1
        });
      }
    }
    return list;
  }

  private startDaily(): void {
    const now: number = Date.now();
    const limit: number = this.settings.dailyReview;
    const newLimit: number = this.newRemaining();
    const reviews: Word[] = [];
    const fresh: Word[] = [];

    for (const word of this.words) {
      const record: ReviewRecord | undefined = this.recordMap.get(word.id);
      if (record !== undefined && record.due <= now) {
        if (limit === 0 || reviews.length < limit) {
          reviews.push(word);
        }
      }
    }
    for (const word of this.words) {
      if (word.book !== this.settings.bookId || this.recordMap.has(word.id)) {
        continue;
      }
      if (fresh.length >= newLimit) {
        break;
      }
      fresh.push(word);
    }

    reviews.sort((a: Word, b: Word) => {
      const recordA: ReviewRecord | undefined = this.recordMap.get(a.id);
      const recordB: ReviewRecord | undefined = this.recordMap.get(b.id);
      return (recordA !== undefined ? recordA.due : 0) - (recordB !== undefined ? recordB.due : 0);
    });

    const list: Word[] = reviews.concat(fresh);
    if (list.length === 0) {
      promptAction.showToast({ message: '今天的任务已完成，明天见' });
      return;
    }
    this.beginSession(list);
  }

  private startWrong(): void {
    const list: Word[] = [];
    for (const id of this.wrongIds) {
      const word: Word | undefined = WordRepository.getWord(id);
      if (word !== undefined) {
        list.push(word);
      }
    }
    if (list.length === 0) {
      promptAction.showToast({ message: '错词本是空的' });
      return;
    }
    this.beginSession(list);
  }

  private beginSession(list: Word[]): void {
    this.queue = list;
    this.queueIndex = 0;
    this.revealed = false;
    this.studying = true;
  }

  private handleGrade(quality: number): void {
    if (this.queueIndex >= this.queue.length) {
      return;
    }
    const word: Word = this.queue[this.queueIndex];
    StudyStore.get().review(word.id, quality);
    this.sync();

    const nextIndex: number = this.queueIndex + 1;
    if (nextIndex >= this.queue.length) {
      const finished: number = this.queue.length;
      this.studying = false;
      this.queue = [];
      this.queueIndex = 0;
      this.revealed = false;
      promptAction.showToast({ message: `本次学习完成，共 ${finished} 个单词` });
      return;
    }
    this.queueIndex = nextIndex;
    this.revealed = false;
  }

  private exitStudy(): void {
    this.studying = false;
    this.revealed = false;
  }

  private updateDailyNew(value: number): void {
    StudyStore.get().setDailyNew(value);
    this.sync();
  }

  private updateDailyReview(value: number): void {
    StudyStore.get().setDailyReview(value);
    this.sync();
  }

  private updateTts(value: boolean): void {
    StudyStore.get().setTts(value);
    this.sync();
  }

  private selectBook(bookId: string): void {
    StudyStore.get().setBook(bookId);
    this.sync();
    promptAction.showToast({ message: `已切换到 ${this.currentBookName()}` });
  }

  private resetProgress(): void {
    StudyStore.get().reset();
    this.sync();
    promptAction.showToast({ message: '学习进度已重置' });
  }

  @Builder
  tabBarItem(label: string, index: number) {
    Column({ space: 5 }) {
      Text(label)
        .fontSize(12)
        .fontWeight(this.tabIndex === index ? FontWeight.Medium : FontWeight.Regular)
        .fontColor(this.tabIndex === index ? BRAND : MUTED)
      Circle()
        .width(4)
        .height(4)
        .fill(this.tabIndex === index ? BRAND : Color.Transparent)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }

  build() {
    Column() {
      if (this.studying && this.queue.length > 0) {
        StudyView({
          wordText: this.queue[this.queueIndex].word,
          phonetic: this.queue[this.queueIndex].phonetic,
          pos: this.queue[this.queueIndex].pos,
          meaning: this.queue[this.queueIndex].meaning,
          example: this.queue[this.queueIndex].example,
          exampleCn: this.queue[this.queueIndex].exampleCn,
          revealed: this.revealed,
          index: this.queueIndex,
          total: this.queue.length,
          tts: this.settings.tts,
          onReveal: () => {
            this.revealed = true;
          },
          onGrade: (quality: number) => {
            this.handleGrade(quality);
          },
          onExit: () => {
            this.exitStudy();
          },
          onSpeak: () => {
            Speech.speak(this.queue[this.queueIndex].word);
          }
        })
      } else {
        Tabs({ barPosition: BarPosition.End, index: this.tabIndex, controller: this.controller }) {
          TabContent() {
            HomeTab({
              doneToday: this.todayDone(),
              goal: this.todayGoal(),
              dueCount: this.dueCount(),
              newRemaining: this.newRemaining(),
              mastered: this.masteredCount(),
              wrongCount: this.wrongIds.length,
              streak: this.streak,
              bookName: this.currentBookName(),
              bookLearned: this.currentBookLearned(),
              bookTotal: this.currentBookTotal(),
              onStart: () => {
                this.startDaily();
              },
              onOpenWrong: () => {
                this.tabIndex = 2;
                this.controller.changeIndex(2);
              },
              onOpenProfile: () => {
                this.tabIndex = 3;
                this.controller.changeIndex(3);
              }
            })
          }
          .tabBar(this.tabBarItem('今日', 0))

          TabContent() {
            LibraryTab({
              books: this.bookProgressList(),
              onSelectBook: (id: string) => {
                this.selectBook(id);
              }
            })
          }
          .tabBar(this.tabBarItem('词库', 1))

          TabContent() {
            WrongTab({
              items: this.wrongEntries(),
              onStudyWrong: () => {
                this.startWrong();
              }
            })
          }
          .tabBar(this.tabBarItem('错词', 2))

          TabContent() {
            ProfileTab({
              dailyNew: this.settings.dailyNew,
              dailyReview: this.settings.dailyReview,
              tts: this.settings.tts,
              streak: this.streak,
              learned: this.records.length,
              mastered: this.masteredCount(),
              wrongCount: this.wrongIds.length,
              onDailyNew: (value: number) => {
                this.updateDailyNew(value);
              },
              onDailyReview: (value: number) => {
                this.updateDailyReview(value);
              },
              onTts: (value: boolean) => {
                this.updateTts(value);
              },
              onReset: () => {
                this.resetProgress();
              }
            })
          }
          .tabBar(this.tabBarItem('我的', 3))
        }
        .width('100%')
        .height('100%')
        .barHeight(58)
        .barBackgroundColor(CARD)
        .backgroundColor(BG)
        .scrollable(false)
        .onChange((index: number) => {
          this.tabIndex = index;
          this.sync();
        })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(BG)
  }
}
