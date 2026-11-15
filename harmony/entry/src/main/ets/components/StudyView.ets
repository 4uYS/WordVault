import { Quality } from '../model/Review';
import { BRAND, BRAND_SOFT, BG, CARD, CARD_SHADOW, MUTED, TEXT, TRACK, SUCCESS, WARNING, DANGER } from '../theme/Theme';

@Component
export struct StudyView {
  @Prop wordText: string = '';
  @Prop phonetic: string = '';
  @Prop pos: string = '';
  @Prop meaning: string = '';
  @Prop example: string = '';
  @Prop exampleCn: string = '';
  @Prop revealed: boolean = false;
  @Prop index: number = 0;
  @Prop total: number = 0;
  @Prop tts: boolean = true;
  onReveal: () => void = () => {};
  onGrade: (quality: number) => void = () => {};
  onExit: () => void = () => {};
  onSpeak: () => void = () => {};

  @Builder
  rateButton(label: string, hint: string, color: string, quality: number) {
    Column({ space: 3 }) {
      Text(label)
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.revealed ? color : '#B8C0CC')
      Text(hint)
        .fontSize(10)
        .fontColor(MUTED)
    }
    .layoutWeight(1)
    .padding({ top: 10, bottom: 10 })
    .backgroundColor(CARD)
    .borderRadius(12)
    .border({ width: 1, color: this.revealed ? color : TRACK })
    .opacity(this.revealed ? 1 : 0.6)
    .enabled(this.revealed)
    .onClick(() => {
      if (this.revealed) {
        this.onGrade(quality);
      }
    })
  }

  build() {
    Column() {
      Row({ space: 12 }) {
        Stack() {
          Text('‹')
            .fontSize(26)
            .fontColor(TEXT)
            .margin({ bottom: 4 })
        }
        .width(38)
        .height(38)
        .borderRadius(19)
        .backgroundColor('#0D182431')
        .onClick(() => this.onExit())

        Column({ space: 6 }) {
          Row() {
            Text('今日学习')
              .fontSize(12)
              .fontColor(MUTED)
            Blank()
            Text(`${this.index + 1} / ${this.total}`)
              .fontSize(12)
              .fontColor(MUTED)
          }
          .width('100%')

          Progress({
            value: this.index + 1,
            total: this.total > 0 ? this.total : 1,
            type: ProgressType.Linear
          })
            .width('100%')
            .height(5)
            .color(BRAND)
            .backgroundColor(TRACK)
            .borderRadius(3)
        }
        .layoutWeight(1)
      }
      .width('100%')
      .padding({ left: 20, right: 20, top: 10, bottom: 12 })

      Column() {
        Column() {
          Text(this.wordText)
            .fontSize(38)
            .fontWeight(FontWeight.Bold)
            .fontColor(TEXT)
            .letterSpacing(-0.8)
            .textAlign(TextAlign.Center)

          Row({ space: 8 }) {
            Text(this.phonetic)
              .fontSize(14)
              .fontColor(MUTED)

            if (this.tts) {
              Text('朗读')
                .fontSize(11)
                .fontColor(BRAND)
                .backgroundColor(BRAND_SOFT)
                .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                .borderRadius(999)
                .onClick(() => this.onSpeak())
            }
          }
          .justifyContent(FlexAlign.Center)
          .margin({ top: 10 })

          Row()
            .width(40)
            .height(3)
            .borderRadius(2)
            .backgroundColor(TRACK)
            .margin({ top: 22, bottom: 22 })

          if (this.revealed) {
            Column({ space: 10 }) {
              Row() {
                Text(this.pos)
                  .fontSize(11)
                  .fontColor(BRAND)
                  .backgroundColor(BRAND_SOFT)
                  .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                  .borderRadius(6)
              }
              .width('100%')
              .justifyContent(FlexAlign.Center)

              Text(this.meaning)
                .fontSize(22)
                .fontWeight(FontWeight.Medium)
                .fontColor(TEXT)
                .textAlign(TextAlign.Center)

              Text(this.example)
                .fontSize(14)
                .fontColor(MUTED)
                .textAlign(TextAlign.Center)
                .margin({ top: 6 })

              Text(this.exampleCn)
                .fontSize(13)
                .fontColor(MUTED)
                .textAlign(TextAlign.Center)
            }
            .width('100%')
          } else {
            Text('轻点卡片查看释义')
              .fontSize(13)
              .fontColor(MUTED)
          }
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
        .padding(24)
        .backgroundColor(CARD)
        .borderRadius(24)
        .shadow(CARD_SHADOW)
        .onClick(() => this.onReveal())
      }
      .layoutWeight(1)
      .width('100%')
      .padding({ left: 20, right: 20 })

      Column({ space: 12 }) {
        Text(this.revealed ? '这次记得怎么样？' : '先回忆一下，再查看释义')
          .fontSize(12)
          .fontColor(MUTED)

        Row({ space: 8 }) {
          this.rateButton('忘记', '10 分钟后', DANGER, Quality.Again)
          this.rateButton('模糊', '明天', WARNING, Quality.Hard)
          this.rateButton('记得', '3 天后', BRAND, Quality.Good)
          this.rateButton('熟练', '7 天后', SUCCESS, Quality.Easy)
        }
        .width('100%')
      }
      .width('100%')
      .padding({ left: 20, right: 20, top: 14, bottom: 18 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(BG)
  }
}
