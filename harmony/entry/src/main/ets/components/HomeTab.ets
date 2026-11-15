import { BRAND, BRAND_SOFT, BG, CARD, CARD_SHADOW, MUTED, TEXT, TRACK, DANGER } from '../theme/Theme';

@Component
export struct HomeTab {
  @Prop doneToday: number = 0;
  @Prop goal: number = 1;
  @Prop dueCount: number = 0;
  @Prop newRemaining: number = 0;
  @Prop mastered: number = 0;
  @Prop wrongCount: number = 0;
  @Prop streak: number = 0;
  @Prop bookName: string = '';
  @Prop bookLearned: number = 0;
  @Prop bookTotal: number = 0;
  onStart: () => void = () => {};
  onOpenWrong: () => void = () => {};
  onOpenProfile: () => void = () => {};

  private dateLabel(): string {
    const date: Date = new Date();
    const week: string[] = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `${date.getMonth() + 1}月${date.getDate()}日 · ${week[date.getDay()]}`;
  }

  private greeting(): string {
    const hour: number = new Date().getHours();
    if (hour < 6) {
      return '夜深了';
    }
    if (hour < 12) {
      return '早上好';
    }
    if (hour < 18) {
      return '下午好';
    }
    return '晚上好';
  }

  private ringTotal(): number {
    return this.goal > 0 ? this.goal : 1;
  }

  private bookPercent(): number {
    if (this.bookTotal <= 0) {
      return 0;
    }
    return Math.round(this.bookLearned * 100 / this.bookTotal);
  }

  @Builder
  sectionTitle(title: string, trailing: string) {
    Row() {
      Text(title)
        .fontSize(17)
        .fontWeight(FontWeight.Medium)
        .fontColor(TEXT)
        .letterSpacing(-0.2)
      Blank()
      Text(trailing)
        .fontSize(12)
        .fontColor(MUTED)
    }
    .width('100%')
    .margin({ top: 26, bottom: 12 })
  }

  @Builder
  statRow(label: string, value: string) {
    Row() {
      Text(label)
        .fontSize(13)
        .fontColor(MUTED)
      Blank()
      Text(value)
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(TEXT)
    }
    .width('100%')
  }

  @Builder
  taskTile(value: string, label: string, dotColor: string, onTap: () => void) {
    Column({ space: 4 }) {
      Text(value)
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .fontColor(TEXT)
        .letterSpacing(-0.4)
      Row({ space: 5 }) {
        Circle().width(7).height(7).fill(dotColor)
        Text(label)
          .fontSize(12)
          .fontColor(MUTED)
      }
    }
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
    .padding(14)
    .backgroundColor(CARD)
    .borderRadius(16)
    .shadow(CARD_SHADOW)
    .onClick(onTap)
  }

  build() {
    Scroll() {
      Column() {
        Row() {
          Column({ space: 4 }) {
            Text(`${this.dateLabel()}${this.streak > 0 ? ` · 连续 ${this.streak} 天` : ''}`)
              .fontSize(12)
              .fontColor(MUTED)
            Text(this.greeting())
              .fontSize(26)
              .fontWeight(FontWeight.Bold)
              .fontColor(TEXT)
              .letterSpacing(-0.4)
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)

          Stack() {
            Text('WV')
              .fontSize(14)
              .fontWeight(FontWeight.Medium)
              .fontColor(Color.White)
          }
          .width(44)
          .height(44)
          .borderRadius(22)
          .backgroundColor(BRAND)
          .shadow({ radius: 16, color: '#280A59F7', offsetX: 0, offsetY: 6 })
          .onClick(() => this.onOpenProfile())
        }
        .width('100%')
        .padding({ top: 8, bottom: 22 })

        Column() {
          Row() {
            Stack() {
              Progress({
                value: Math.min(this.doneToday, this.ringTotal()),
                total: this.ringTotal(),
                type: ProgressType.Ring
              })
                .width(92)
                .height(92)
                .color(BRAND)
                .backgroundColor(TRACK)
                .style({ strokeWidth: 8 })
              Column({ space: 2 }) {
                Text(`${this.doneToday}`)
                  .fontSize(22)
                  .fontWeight(FontWeight.Bold)
                  .fontColor(TEXT)
                Text('今日词数')
                  .fontSize(10)
                  .fontColor(MUTED)
              }
            }
            .width(92)
            .height(92)

            Column({ space: 10 }) {
              this.statRow('待复习', `${this.dueCount}`)
              this.statRow('新词剩余', `${this.newRemaining}`)
              this.statRow('目标', `${this.ringTotal()} 词`)
            }
            .layoutWeight(1)
            .margin({ left: 20 })
          }
          .width('100%')

          Button('开始今日学习')
            .width('100%')
            .height(50)
            .borderRadius(14)
            .backgroundColor(BRAND)
            .fontColor(Color.White)
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
            .margin({ top: 20 })
            .onClick(() => this.onStart())
        }
        .width('100%')
        .padding(22)
        .backgroundColor(CARD)
        .borderRadius(24)
        .shadow(CARD_SHADOW)

        this.sectionTitle('今日任务', `${this.dueCount + this.newRemaining} 个待完成`)

        Row({ space: 10 }) {
          this.taskTile(`${this.dueCount}`, '待复习', '#F5A623', () => this.onStart())
          this.taskTile(`${this.newRemaining}`, '新词', BRAND, () => this.onStart())
          this.taskTile(`${this.wrongCount}`, '错词', DANGER, () => this.onOpenWrong())
        }
        .width('100%')

        this.sectionTitle('词书进度', `${this.bookLearned} / ${this.bookTotal} 词`)

        Column({ space: 10 }) {
          Row() {
            Row({ space: 8 }) {
              Text('当前词书')
                .fontSize(10)
                .fontColor(BRAND)
                .backgroundColor(BRAND_SOFT)
                .padding({ left: 6, right: 6, top: 2, bottom: 2 })
                .borderRadius(6)
              Text(this.bookName)
                .fontSize(15)
                .fontWeight(FontWeight.Medium)
                .fontColor(TEXT)
            }
            Blank()
            Text(`${this.bookPercent()}%`)
              .fontSize(15)
              .fontWeight(FontWeight.Medium)
              .fontColor(BRAND)
          }
          .width('100%')

          Progress({
            value: this.bookLearned,
            total: this.bookTotal > 0 ? this.bookTotal : 1,
            type: ProgressType.Linear
          })
            .width('100%')
            .height(6)
            .color(BRAND)
            .backgroundColor(TRACK)
            .borderRadius(3)
        }
        .width('100%')
        .padding(16)
        .backgroundColor(CARD)
        .borderRadius(16)
        .shadow(CARD_SHADOW)

        this.sectionTitle('错词巩固', '答错自动收录')

        Row({ space: 12 }) {
          Stack() {
            Text('!')
              .fontSize(18)
              .fontWeight(FontWeight.Bold)
              .fontColor(DANGER)
          }
          .width(40)
          .height(40)
          .borderRadius(20)
          .backgroundColor('#FDECEC')

          Column({ space: 3 }) {
            Text('错词本')
              .fontSize(15)
              .fontWeight(FontWeight.Medium)
              .fontColor(TEXT)
            Text(this.wrongCount > 0 ? `收录 ${this.wrongCount} 个待巩固单词` : '暂无错词，继续保持')
              .fontSize(12)
              .fontColor(MUTED)
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)

          Text('›')
            .fontSize(20)
            .fontColor(MUTED)
        }
        .width('100%')
        .padding(16)
        .backgroundColor(CARD)
        .borderRadius(16)
        .shadow(CARD_SHADOW)
        .onClick(() => this.onOpenWrong())

        Text(`已掌握 ${this.mastered} 词 · 数据仅保存在本机`)
          .fontSize(11)
          .fontColor(MUTED)
          .margin({ top: 20, bottom: 4 })
      }
      .width('100%')
      .padding({ left: 20, right: 20, top: 8, bottom: 24 })
    }
    .width('100%')
    .height('100%')
    .scrollBar(BarState.Off)
    .backgroundColor(BG)
  }
}
