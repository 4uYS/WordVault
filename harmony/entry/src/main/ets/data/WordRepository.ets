import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { Word, WordBook } from '../model/Word';

const BOOK_FILES: string[] = [
  'cet4',
  'cet6',
  'kaoyan',
  'ielts',
  'toefl',
  'gaokao',
  'tem8',
  'gre',
  'sat',
  'gmat',
  'tem4'
];

export interface BookInfo {
  id: string;
  name: string;
  short: string;
  desc: string;
  color: string;
  total: number;
}

export class WordRepository {
  static books: BookInfo[] = [];
  static words: Word[] = [];
  private static wordMap: Map<string, Word> = new Map();

  static load(context: common.UIAbilityContext): void {
    if (this.words.length > 0) {
      return;
    }
    const decoder: util.TextDecoder = util.TextDecoder.create('utf-8');
    for (const id of BOOK_FILES) {
      try {
        const bytes: Uint8Array = context.resourceManager.getRawFileContentSync(`wordbooks/${id}.json`);
        const raw: string = decoder.decodeToString(bytes);
        const book: WordBook = JSON.parse(raw) as WordBook;
        const info: BookInfo = {
          id: book.id,
          name: book.name,
          short: book.short,
          desc: book.desc,
          color: book.color,
          total: book.words.length
        };
        this.books.push(info);
        for (const seed of book.words) {
          const word: Word = {
            id: seed.id,
            word: seed.word,
            phonetic: seed.phonetic,
            pos: seed.pos,
            meaning: seed.meaning,
            example: seed.example,
            exampleCn: seed.exampleCn,
            book: book.id
          };
          this.words.push(word);
          this.wordMap.set(word.id, word);
        }
      } catch (err) {
        console.error(`WordVault: failed to load wordbook ${id}: ${JSON.stringify(err)}`);
      }
    }
  }

  static getWord(id: string): Word | undefined {
    return this.wordMap.get(id);
  }

  static getBook(id: string): BookInfo | undefined {
    return this.books.find((book: BookInfo) => book.id === id);
  }
}
