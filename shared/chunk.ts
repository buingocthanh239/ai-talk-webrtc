/**
 * Cat dong text cua AI thanh nhung khuc gui len Polly.
 *
 * Toan bo do tre nguoi dung cam thay nam o KHUC DAU TIEN: cac khuc sau duoc
 * tong hop trong luc khuc truoc dang phat nen khong lo ra. Vi vay luat cat o
 * day bat doi xung mot cach co y — khuc dau cat som nhat co the, khuc sau gom
 * dai hon de it request va ngu dieu lien mach hon.
 *
 * Ham thuan, khong dung DOM, khong dung fetch. Day la phan de sai nhat trong
 * ca duong TTS (cat nham giua "Mr. Smith" thi Polly doc ra hai cau roi rac) va
 * cung la phan de kiem tra nhat.
 */

export interface ChunkLimits {
  /** Khuc dau: khong cat ngan hon nguong nay du gap dau cau. */
  firstMin: number;
  /** Khuc dau: qua nguong nay thi cat o ranh gioi tu gan nhat. */
  firstMax: number;
  /** Khuc sau: gom toi het cau VA dat nguong nay. */
  min: number;
  /** Khuc sau: tran cung, khong bao gio vuot. */
  max: number;
}

export const DEFAULT_LIMITS: ChunkLimits = {
  firstMin: 15,
  firstMax: 40,
  min: 60,
  max: 200,
};

/**
 * Viet tat ket thuc bang dau cham nhung KHONG phai het cau.
 *
 * Thieu bang nay thi "Ask Dr. Lee about it." bi cat thanh hai khuc, va Polly
 * doc "Dr." thanh mot cau hoan chinh voi ngu dieu xuong giong.
 */
const ABBREVIATIONS = [
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr',
  'vs', 'etc', 'no', 'fig', 'approx', 'inc', 'ltd',
  'e.g', 'i.e', 'a.m', 'p.m', 'u.s', 'u.k',
];

const ABBREV_RE = new RegExp(
  `(?:^|[\\s("'“])(?:${ABBREVIATIONS.map((a) => a.replace(/\./g, '\\.')).join('|')})\\.$`,
  'i'
);

const SENTENCE_END = new Set(['.', '!', '?']);
const SOFT_BREAK = new Set([',', ';', ':', '—', '–']);
/** Dau dong sau dau cau van tinh la ket cau: `)`, `"`, `'`, `]`. */
const CLOSERS = new Set([')', ']', '"', "'", '”', '’']);

const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/**
 * Vi tri KET THUC (exclusive) cua mot cau bat dau tu 0, hoac -1.
 *
 * `atEnd` = da chac chan khong con chu nao chay tiep vao day nua. Trong luc
 * streaming thi mot dau `.` o cuoi buffer chua ket luan duoc gi: no co the la
 * het cau, ma cung co the la "3." dang cho "14" chay toi.
 */
export function findSentenceEnd(text: string, from: number, atEnd: boolean): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === undefined || !SENTENCE_END.has(c)) continue;

    // "..." — chi moc cuoi cung moi la ranh gioi.
    let j = i;
    while (j + 1 < text.length && SENTENCE_END.has(text[j + 1] ?? '')) j++;
    // Nuot cac dau dong ngay sau: `He said "go."` cat sau dau nhay.
    while (j + 1 < text.length && CLOSERS.has(text[j + 1] ?? '')) j++;

    const next = text[j + 1];
    if (next === undefined) {
      // Chua co gi phia sau: chi chot duoc khi dong text da dong han.
      if (atEnd) return j + 1;
      return -1;
    }
    if (!isSpace(next)) {
      // 3.14 — dau cham dinh giua hai chu so, khong phai het cau.
      i = j;
      continue;
    }
    if (c === '.' && isDigit(text[i - 1]) && isDigit(text[i + 1])) {
      i = j;
      continue;
    }
    if (ABBREV_RE.test(text.slice(0, j + 1))) {
      i = j;
      continue;
    }
    return j + 1;
  }
  return -1;
}

/** Vi tri ket thuc cua dau ngat mem dau tien tu `from`, hoac -1. */
function findSoftBreak(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === undefined || !SOFT_BREAK.has(c)) continue;
    if (isSpace(text[i + 1])) return i + 1;
  }
  return -1;
}

/** Ranh gioi tu cuoi cung khong vuot qua `limit`, hoac -1. */
function lastWordBreak(text: string, limit: number, min: number): number {
  for (let i = Math.min(limit, text.length) - 1; i >= min; i--) {
    if (isSpace(text[i])) return i;
  }
  return -1;
}

/**
 * Bo cac ky tu markdown model hay chen vao.
 *
 * Polly doc `**really**` thanh "asterisk asterisk really" — nghe ra ngay la
 * hong, va nguoi hoc dang tap nghe thi khong doan duoc do la loi cua may.
 */
export function sanitize(text: string): string {
  return text
    .replace(/`+/g, '')
    .replace(/\*+/g, '')
    .replace(/(^|\n)\s*#{1,6}\s*/g, '$1')
    .replace(/[ \t]+/g, ' ');
}

/**
 * Gom delta thanh khuc. Giu buffer va biet minh dang o khuc thu may — chi hai
 * bien, nhung dat o mot cho de cho goi khong phai tu quan.
 */
export class SentenceChunker {
  #buffer = '';
  #first = true;
  readonly #limits: ChunkLimits;

  constructor(limits: ChunkLimits = DEFAULT_LIMITS) {
    this.#limits = limits;
  }

  /** Nap them mot delta, tra ve cac khuc da du dieu kien cat. */
  push(delta: string): string[] {
    this.#buffer += sanitize(delta);
    return this.#drain(false);
  }

  /** Het dong: tra not phan con lai bat ke dai ngan. */
  flush(): string[] {
    return this.#drain(true);
  }

  reset(): void {
    this.#buffer = '';
    this.#first = true;
  }

  #drain(atEnd: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const cut = this.#nextCut(atEnd);
      if (cut <= 0) break;
      const piece = this.#buffer.slice(0, cut).trim();
      this.#buffer = this.#buffer.slice(cut);
      if (piece) {
        out.push(piece);
        this.#first = false;
      }
    }

    if (atEnd) {
      const rest = this.#buffer.trim();
      this.#buffer = '';
      if (rest) {
        out.push(rest);
        this.#first = false;
      }
    }
    return out;
  }

  /** Vi tri cat cho khuc ke tiep, hoac -1 khi chua du dieu kien. */
  #nextCut(atEnd: boolean): number {
    const text = this.#buffer;
    const { firstMin, firstMax, min, max } = this.#limits;

    if (this.#first) {
      // Khuc dau: bat cu ranh gioi nao — cung, mem, hay chi la qua dai — deu
      // duoc, mien la qua nguong toi thieu. Cang som cang tot.
      const hard = findSentenceEnd(text, firstMin, atEnd);
      if (hard > 0) return hard;

      const soft = findSoftBreak(text, firstMin);
      if (soft > 0) return soft;

      if (text.length > firstMax) {
        const word = lastWordBreak(text, firstMax, firstMin);
        return word > 0 ? word : firstMax;
      }
      return -1;
    }

    const hard = findSentenceEnd(text, min, atEnd);
    if (hard > 0 && hard <= max) return hard;

    if (text.length > max) {
      // Cham tran ma van chua het cau — cat o cho de nghe nhat con lai.
      const soft = findSoftBreak(text, min);
      if (soft > 0 && soft <= max) return soft;
      const word = lastWordBreak(text, max, min);
      return word > 0 ? word : max;
    }
    return -1;
  }
}
