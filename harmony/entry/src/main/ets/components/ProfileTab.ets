import { BRAND, BG, CARD, CARD_SHADOW, MUTED, TEXT, DANGER } from '../theme/Theme';

@Component
export struct ProfileTab {
  @Prop dailyNew: number = 20;
  @Prop dailyReview: number = 100;
  @Prop tts: boolean = true;
  @Prop streak: number = 0;
  @Prop learned: number = 0;
  @Prop mastered: number = 0;
  @Prop wrongCount: number = 0;
  onDailyNew: (value: number) => void = () => {};
  onDailyReview: (value: number) => void = () => {};
  onTts: (value: boolean) => void = () => {};
  onReset: () => void = () => {};

  private confirmReset(): void {
    AlertDialog.show({
      title: '重置学习进度',
      message: '将清空所有学习记录、错词本与连续天数，此操作不可撤销。',
      primaryButton: {
        value: '取消',
        action: () => {
        }
      },
      secondaryButton: {
        value: '重置',
        fontColor: DANGER,
        action: () => this.onReset()
      }
    });
  }

  @Builder
  statCell(value: string, label: string) {
    Column({ space: 3 }) {
      Text(value)
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .fontColor(TEXT)
        .letterSpacing(-0.4)
      Text(label)
        .fontSize(11)
        .fontColor(MUTED)
    }
    .layoutWeight(1)
  }

  @Builder
  optionChip(label: string, active: boolean, onTap: () => void) {
    Text(label)
      .fontSize(13)
      .fontColor(active ? Color.White : TEXT)
      .backgroundColor(active ? BRAND : '#F1F3F5')
      .borderRadius(999)
      .padding({ left: 14, right: 14, top: 7, bottom: 7 })
      .margin({ right: 8, bottom: 8 })
      .onClick(onTap)
  }

  @Builder
  cardTitle(title: string, subtitle: string) {
    Column({ space: 3 }) {
      Text(title)
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .fontColor(TEXT)
      Text(subtitle)
        .fontSize(12)
        .fontColor(MUTED)
    }
    .alignItems(HorizontalAlign.Start)
    .width('100%')
  }

  build() {
    Scroll() {
      Column({ space: 16 }) {
        Row({ space: 14 }) {
          Stack() {
            Text('WV')
              .fontSize(18)
              .fontWeight(FontWeight.Medium)
              .fontColor(Color.White)
          }
          .width(56)
          .height(56)
          .borderRadius(28)
          .backgroundColor(BRAND)
          .shadow({ radius: 16, color: '#280A59F7', offsetX: 0, offsetY: 6 })

          Column({ space: 4 }) {
            Text('学习者')
              .fontSize(20)
              .fontWeight(FontWeight.Bold)
              .fontColor(TEXT)
            Text(`连续学习 ${this.streak} 天 · 已学 ${this.learned} 词`)
              .fontSize(12)
              .fontColor(MUTED)
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
        }
        .width('100%')
        .padding({ top: 10, bottom: 4 })

        Row() {
          this.statCell(`${this.streak}`, '连续天数')
          this.statCell(`${this.mastered}`, '已掌握')
          this.statCell(`${this.wrongCount}`, '待巩固错词')
        }
        .width('100%')
        .padding(18)
        .backgroundColor(CARD)
        .borderRadius(16)
        .shadow(CARD_SHADOW)

        Column({ space: 14 }) {
          this.cardTitle('每日计划', '新词与复习上限都会影响今日任务量')

          Text('每日新词上限')
            .fontSize(13)
            .fontColor(MUTED)
            .width('100%')
          Flex({ wrap: FlexWrap.Wrap }) {
            ForEach([10, 20, 30, 50], (value: number) => {
              this.optionChip(`${value} 词`, this.dailyNew === value, () => this.onDailyNew(value))
            })
          }

          Text('每日复习上限')
            .fontSize(13)
            .fontColor(MUTED)
            .width('100%')
          Flex({ wrap: FlexWrap.Wrap }) {
            ForEach([50, 100, 200, 0], (value: number) => {
              this.optionChip(value === 0 ? '不限' : `${value} 词`, this.dailyReview === value,
                () => this.onDailyReview(value))
            })
          }
        }
        .width('100%')
        .padding(18)
        .backgroundColor(CARD)
        .borderRadius(16)
        .shadow(CARD_SHADOW)

        Column({ space: 12 }) {
          this.cardTitle('发音', '使用系统 TTS 朗读单词')

          Row() {
            Text('自动朗读 / 手动朗读')
              .fontSize(14)
              .fontColor(TEXT)
            Blank()
            Toggle({ type: ToggleType.Switch, isOn: this.tts })
              .selectedColor(BRAND)
              .onChange((isOn: boolean) => this.onTts(isOn))
          }
          .width('100%')
        }
        .width('100%')
        .padding(18)
        .backgroundColor(CARD)
        .borderRadius(16)
        .shadow(CARD_SHADOW)

        Column({ space: 14 }) {
          this.cardTitle('数据', '所有记录仅保存在本机，不上传云端')

          Row() {
            Text('重置学习进度')
              .fontSize(14)
              .fontColor(DANGER)
            Blank()
            Text('清空')
              .fontSize(12)
              .fontColor(MUTED)
          }
          .width('100%')
          .onClick(() => this.confirmReset())

          Divider()
            .color('#EDF0F4')

          Row() {
            Text('离线词库')
              .fontSize(14)
              .fontColor(TEXT)
            Blank()
            Text('2026.11')
              .fontSize(12)
              .fontColor(MUTED)
          }
          .width('100%')

          Row() {
            Text('版本')
              .fontSize(14)
              .fontColor(TEXT)
            Blank()
            Text('WordVault for HarmonyOS 0.1.0')
              .fontSize(12)
              .fontColor(MUTED)
          }
          .width('100%')
        }
        .width('100%')
        .padding(18)
        .backgroundColor(CARD)
        .borderRadius(16)
        .shadow(CARD_SHADOW)

        Text('本地优先 · 无账号 · 无网络也能学')
          .fontSize(11)
          .fontColor(MUTED)
          .margin({ top: 4, bottom: 8 })
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
