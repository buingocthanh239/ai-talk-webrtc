/**
 * Viseme — khau hinh mieng. Dung chung server va client.
 *
 * Bo viseme o day la bo 22 ID (0..21) cua Azure Speech, KHONG phai vi ta dung
 * Azure ma vi **rig Spine cua cac nhan vat duoc ve theo bo do**: moi skeleton
 * co dung 22 animation `viseme_0` … `viseme_21`. Ten animation la hop dong
 * giua du lieu va rig, nen bo ten phai theo rig.
 *
 * Tieng noi thi lay tu Amazon Polly, ma Polly dung bo viseme rieng, THO HON.
 * Nen o giua phai co mot bang doi, va **nam cho nao cung mat mat**:
 *
 *   Polly co 18 gia tri -> phu duoc 17/22 hinh. Nam hinh hoa si da ve nhung
 *   Polly khong bao gio goi toi duoc: 5 (ɝ), 9 (aʊ), 10 (ɔɪ), 11 (aɪ), 12 (h).
 *   Ba trong so do la nguyen am doi — thu nguoi Viet hoc tieng Anh hay nuot.
 *
 * Do la cai gia da biet truoc khi chon Polly. Doi sang Azure thi bang doi nay
 * bien mat va ca 22 hinh deu song.
 */

/** Bo 22 khau hinh cua rig, danh so 0..21. 0 la im lang. */
export type VisemeId = number;

export const VISEME_IDS: readonly VisemeId[] = Array.from({ length: 22 }, (_, i) => i);

/** Ten animation tuong ung tren skeleton Spine. */
export const visemeAnimation = (id: VisemeId): string => `viseme_${id}`;

/**
 * Nam khau hinh Polly khong bao gio goi toi.
 *
 * Giu thanh hang so chu khong chi ghi trong comment: man debug hien chung mo
 * di, de khi thay mot thanh do dung im thi biet ngay do la gioi han cua Polly
 * chu khong phai loi.
 */
export const UNREACHABLE_BY_POLLY: readonly VisemeId[] = [5, 9, 10, 11, 12];

/**
 * Polly viseme -> viseme ID cua rig.
 *
 * Cac cho gop lai deu la vi Polly khong tach duoc, khong phai vi rig thieu:
 *   a  gop æ, ɑ, aɪ, aʊ  -> 2   (ɑ)  — mat luon 9 va 11
 *   O  gop ɔ, ɔɪ         -> 3   (ɔ)  — mat luon 10
 *   k  gop g, h, k, ŋ    -> 20        — mat luon 12
 *   @  gop ə, ɚ          -> 1        — mat luon 5
 *   e va E               -> 4
 *
 * `T` (θ va ð) cho ve 17 chu khong phai 19, du Azure xep θ vao 19: 17 la hinh
 * luoi tho ra giua hai rang, va do dung la thu nguoi hoc can NHIN thay. Voi
 * app day phat am thi chon hinh de thay quan trong hon khop bang.
 */
export const POLLY_TO_VISEME: Readonly<Record<string, VisemeId>> = {
  sil: 0,
  '@': 1, // ə, ɚ — schwa
  a: 2, //   æ, ɑ, aɪ, aʊ
  O: 3, //   ɔ, ɔɪ
  E: 4, //   ɛ, ʌ, ɜ
  e: 4, //   eɪ
  i: 6, //   i, ɪ, j
  u: 7, //   u, ʊ, w
  o: 8, //   oʊ
  r: 13, //  ɹ
  l: 14, //  l
  s: 15, //  s, z
  S: 16, //  ʃ, tʃ, dʒ, ʒ
  T: 17, //  θ, ð
  f: 18, //  f, v
  t: 19, //  d, n, t
  k: 20, //  g, h, k, ŋ
  p: 21, //  b, m, p
};

/**
 * Schwa la nguyen am giam, mieng chi he ra. Cho no trong so day thi avatar
 * nhai qua manh o cac am tiet khong nhan — nhin ra ngay la sai.
 */
export const SCHWA_WEIGHT = 0.55;

/**
 * Mo ta khau hinh bang tieng Viet.
 *
 * Truoc day day la bu dap cho viec rig khong co luoi. Rig Spine hien tai CO
 * luoi va rang (slot Tongue / Tooth_U / Tooth_B), nen dong chu nay doi vai:
 * tu cho thay the thanh cho xac nhan — nguoi hoc doc de biet minh dang nhin
 * dung cho, nhat la o 17 (ð) va 14 (l) von rat de nham voi 19.
 */
export const VISEME_HINT_VI: Readonly<Record<VisemeId, string>> = {
  0: 'Mieng nghi, moi kep nhe',
  1: 'Mieng he nho, luoi nam giua — am giam (about, cup)',
  2: 'Ha ham that rong, luoi ha thap (father)',
  3: 'Moi tron vua, ham ha xuong (thought, law)',
  4: 'Mieng he vua, moi keo ngang mot chut (bed, book)',
  5: 'Luoi cuon nhe ve sau, moi hoi tron (bird, her)',
  6: 'Moi keo rong sang hai ben, ham gan khep (see, sit)',
  7: 'Moi tron va chum nho, day ra truoc (goose, we)',
  8: 'Moi tron thanh vong o (go, boat)',
  9: 'Ha ham rong roi CHUM moi lai (now, house)',
  10: 'Tu moi tron chuyen dan sang moi keo ngang (boy, coin)',
  11: 'Ha ham rong roi KEO moi ngang (my, time)',
  12: 'Mieng he, hoi bat ra tu co hong (hat, he)',
  13: 'Moi hoi tron, luoi cuon len nhung KHONG cham dau (red)',
  14: 'Dau luoi cham loi va GIU nguyen, hoi thoat hai ben (light)',
  15: 'Rang gan khep, hoi luon qua khe hep (see, zoo)',
  16: 'Moi chum va dua ra truoc, rang gan cham nhau (she, chair)',
  17: 'Dau luoi tho ra GIUA HAI RANG, co rung (this, that)',
  18: 'Rang cua tren cham moi duoi (fan, van)',
  19: 'Dau luoi cham loi sau rang tren (dog, ten, no, think)',
  20: 'Cuong luoi nang sat ngac mem, dau luoi ha (key, go, sing)',
  21: 'Hai moi mim chat roi bat ra (pen, boy, man)',
};

export interface VisemeFrame {
  /** Moc ms tinh tu dau audio. */
  tMs: number;
  viseme: VisemeId;
  /** Do mo toi da cua khau hinh nay, 0..1. */
  weight: number;
}

/**
 * Doi mot mark cua Polly sang frame. Tra null cho gia tri khong nhan ra —
 * bo qua con hon la nem, vi Polly co the them viseme moi cho ngon ngu khac
 * va mot gia tri la khong dang lam hong ca cau.
 */
export function frameFromPolly(time: number, value: string): VisemeFrame | null {
  const viseme = POLLY_TO_VISEME[value];
  if (viseme === undefined) return null;
  return {
    tMs: time,
    viseme,
    weight: value === '@' ? SCHWA_WEIGHT : 1,
  };
}

/**
 * Doc speech marks cua Polly thanh timeline.
 *
 * Polly tra JSON PHAN CACH BANG DONG chu khong phai mot mang JSON — `JSON.parse`
 * ca cuc se hong ngay tu dau.
 */
export function parseSpeechMarks(text: string): VisemeFrame[] {
  const frames: VisemeFrame[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let mark: { time?: number; type?: string; value?: string };
    try {
      mark = JSON.parse(trimmed) as typeof mark;
    } catch {
      continue; // dong hong thi bo, khong lam mat ca cau
    }
    // Loc luon cac mark khong phai viseme: ta chi xin viseme, nhung tra ve lan
    // loai thi van khong duoc de lot vao timeline.
    if (mark.type !== 'viseme' || typeof mark.time !== 'number' || !mark.value) continue;

    const frame = frameFromPolly(mark.time, mark.value);
    if (frame) frames.push(frame);
  }
  return frames;
}

/**
 * Khau hinh dang mo tai moc `tMs`, va thoi diem het han cua no.
 *
 * Timeline cua Polly la cac moc RIENG LE, khong co do dai: mot viseme keo dai
 * cho toi moc ke tiep. Ham nay tra ve frame dang giu cung voi moc het han, de
 * ben goi tu quyet dinh cach lam muot.
 *
 * frames phai da sap xep tang dan theo tMs — Polly tra dung thu tu do.
 */
export function frameAt(
  frames: readonly VisemeFrame[],
  tMs: number
): { index: number; frame: VisemeFrame; endMs: number | null } | null {
  if (!frames.length || tMs < frames[0]!.tMs) return null;

  // Tim tuyen tinh nguoc tu cuoi la du: goi moi frame render (~60 lan/giay)
  // tren timeline vai chuc phan tu, tim nhi phan khong bu lai duoc do phuc tap.
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i]!;
    if (frame.tMs <= tMs) {
      return { index: i, frame, endMs: frames[i + 1]?.tMs ?? null };
    }
  }
  return null;
}
