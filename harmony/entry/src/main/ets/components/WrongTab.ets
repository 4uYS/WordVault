import { BRAND, BG, CARD, CARD_SHADOW, MUTED, TEXT, DANGER } from '../theme/Theme';

export interface WrongEntry {
  id: string;
  word: string;
  meaning: string;
  wrongCount: number;
}

@Component
export struct WrongTab {
  @Prop items: WrongEntry[] = [];
  onStudyWrong: () => void = () => {};

  private totalMistakes(): number {
    let total: number = 0;
    for (const item of this.items) {
      total += item.wrongCount;
    }
    return total;
  }

  @Builder
  summaryCell(value: string, label: string) {
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
    .alignItems(HorizontalAlign.Start)
  }

  build() {
    Column() {
      Column({ space: 4 }) {
        Text('错词本')
          .fontSize(28)
          .fontWeight(FontWeight.Bold)
          .fontColor(TEXT)
          .letterSpacing(-0.4)
        Text('答错自动收录，连续答对 3 次移出')
          .fontSize(12)
          .fontColor(MUTED)
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')
      .padding({ left: 20, right: 20, top: 18, bottom: 16 })

      Column() {
        Row() {
          this.summaryCell(`${this.items.length}`, '待巩固')
          this.summaryCell(`${this.totalMistakes()}`, '累计答错')
          this.summaryCell('3 次', '移出标准')
        }
        .width('100%')
        .padding(18)
        .backgroundColor(CARD)
        .borderRadius(16)
        .shadow(CARD_SHADOW)
      }
      .width('100%')
      .padding({ left: 20, right: 20 })

      if (this.items.length === 0) {
        Column({ space: 8 }) {
          Text('还没有错词')
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
            .fontColor(TEXT)
          Text('学习时选择「忘记」或「模糊」的单词会出现在这里')
            .fontSize(12)
            .fontColor(MUTED)
            .textAlign(TextAlign.Center)
        }
        .layoutWeight(1)
        .width('100%')
        .justifyContent(FlexAlign.Center)
        .padding(32)
      } else {
        List({ space: 10 }) {
          ForEach(this.items, (item: WrongEntry) => {
            ListItem() {
              Row({ space: 12 }) {
                Column({ space: 3 }) {
                  Text(item.word)
                    .fontSize(17)
                    .fontWeight(FontWeight.Medium)
                    .fontColor(TEXT)
                  Text(item.meaning)
                    .fontSize(12)
                    .fontColor(MUTED)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)

                Text(`错 ${item.wrongCount} 次`)
                  .fontSize(11)
                  .fontColor(DANGER)
                  .backgroundColor('#FDECEC')
                  .padding({ left: 8, right: 8, top: 3, bottom: 3 })
                  .borderRadius(999)
              }
              .width('100%')
              .padding(16)
              .backgroundColor(CARD)
              .borderRadius(16)
              .shadow(CARD_SHADOW)
            }
          }, (item: WrongEntry) => `${item.id}-${item.wrongCount}`)
        }
        .layoutWeight(1)
        .width('100%')
        .padding({ left: 20, right: 20, top: 14, bottom: 14 })
        .scrollBar(BarState.Off)
      }

      Column() {
        Button(this.items.length > 0 ? `重练错词（${this.items.length}）` : '暂无错词')
          .width('100%')
          .height(48)
          .borderRadius(14)
          .backgroundColor(this.items.length > 0 ? BRAND : '#DCE2EA')
          .fontColor(Color.White)
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .enabled(this.items.length > 0)
          .onClick(() => this.onStudyWrong())
      }
      .width('100%')
      .padding({ left: 20, right: 20, top: 4, bottom: 16 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(BG)
  }
}
