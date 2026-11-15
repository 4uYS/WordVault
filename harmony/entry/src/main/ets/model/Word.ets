export interface WordSeed {
  id: string;
  word: string;
  phonetic: string;
  pos: string;
  meaning: string;
  example: string;
  exampleCn: string;
}

export interface WordBook {
  id: string;
  name: string;
  short: string;
  desc: string;
  color: string;
  words: WordSeed[];
}

export interface Word {
  id: string;
  word: string;
  phonetic: string;
  pos: string;
  meaning: string;
  example: string;
  exampleCn: string;
  book: string;
}
