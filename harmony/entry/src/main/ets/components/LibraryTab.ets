import { BRAND, BRAND_SOFT, BG, CARD, CARD_SHADOW, MUTED, TEXT, TRACK } from '../theme/Theme';

export interface BookProgress {
  id: string;
  name: string;
  short: string;
  desc: string;
  color: string;
  total: number;
  learned: number;
  current: boolean;
}

@Component
export struct LibraryTab {
  @Prop books: BookProgress[] = [];
  onSelectBook: (id: string) => void = () => {};

  @Builder
  bookCard(book: BookProgress) {
    Column({ space: 12 }) {
      Row({ space: 12 }) {
        Stack() {
          Text(book.short)
            .fontSize(12)
            .fontWeight(FontWeight.Medium)
            .fontColor(book.color)
        }
        .width(44)
        .height(44)
        .borderRadius(12)
        .backgroundColor(BRAND_SOFT)

        Column({ space: 3 }) {
          Text(book.name)
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .fontColor(TEXT)
          Text(book.desc)
            .fontSize(12)
            .fontColor(MUTED)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        Column({ space: 4 }) {
          if (book.current) {
            Text('当前')
              .fontSize(10)
              .fontColor(BRAND)
              .backgroundColor(BRAND_SOFT)
              .padding({ left: 6, right: 6, top: 2, bottom: 2 })
              .borderRadius(6)
          }
          Text(`${book.learned} / ${book.total}`)
            .fontSize(12)
            .fontColor(MUTED)
        }
        .alignItems(HorizontalAlign.End)
      }
      .width('100%')

      Progress({
        value: book.learned,
        total: book.total > 0 ? book.total : 1,
        type: ProgressType.Linear
      })
        .width('100%')
        .height(6)
        .color(book.color)
        .backgroundColor(TRACK)
        .borderRadius(3)
    }
    .width('100%')
    .padding(16)
    .backgroundColor(CARD)
    .borderRadius(16)
    .shadow(CARD_SHADOW)
    .onClick(() => this.onSelectBook(book.id))
  }

  build() {
    Column() {
      Column({ space: 4 }) {
        Text('词库')
          .fontSize(28)
          .fontWeight(FontWeight.Bold)
          .fontColor(TEXT)
          .letterSpacing(-0.4)
        Text(`${this.books.length} 本词书 · 全部离线 · 点击切换今日新词来源`)
          .fontSize(12)
          .fontColor(MUTED)
      }
      .alignItems(HorizontalAlign.Start)
      .width('100%')
      .padding({ left: 20, right: 20, top: 18, bottom: 16 })

      List({ space: 12 }) {
        ForEach(this.books, (book: BookProgress) => {
          ListItem() {
            this.bookCard(book)
          }
        }, (book: BookProgress) => `${book.id}-${book.learned}-${book.current}`)
      }
      .layoutWeight(1)
      .width('100%')
      .padding({ left: 20, right: 20, bottom: 20 })
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(BG)
  }
}
