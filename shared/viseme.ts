/**
 * Viseme — khau hinh mieng. Dung chung server va client.
 *
 * Server sinh timeline tu Amazon Polly speech marks, client dung timeline do
 * de keo morph target cua avatar. Bang map nam o day chu khong o mot trong hai
 * phia, vi ca hai deu phai hieu CUNG mot bo ten: server ghi ra `PP`, client
 * tra `viseme_PP` tren mesh — lech mot ky tu la mom dung im ma khong bao loi.
 *
 * Hai bo ten khac nhau di qua file nay:
 *   - Polly tra ve bo cua no (17 gia tri + sil), theo IPA.
 *   - Avatar Ready Player Me nhan bo Oculus OVR LipSync (15 morph target).
 * Bo Oculus THO HON: no khong tach `e` voi `E`, cung khong tach `o` voi `O`.
 * Do la gioi han cua rig, khong phai cua Polly — Polly phan biet duoc.
 */

/** Bo 15 viseme cua Oculus OVR LipSync, dung ten hau to cua Ready Player Me. */
export type Viseme =
  | 'sil'
  | 'PP'
  | 'FF'
  | 'TH'
  | 'DD'
  | 'kk'
  | 'CH'
  | 'SS'
  | 'nn'
  | 'RR'
  | 'aa'
  | 'E'
  | 'I'
  | 'O'
  | 'U';

export const VISEMES: readonly Viseme[] = [
  'sil',
  'PP',
  'FF',
  'TH',
  'DD',
  'kk',
  'CH',
  'SS',
  'nn',
  'RR',
  'aa',
  'E',
  'I',
  'O',
  'U',
];

/** Ten morph target tren mesh cua Ready Player Me. */
export const morphName = (v: Viseme): string => `viseme_${v}`;

/**
 * Polly viseme -> Oculus viseme.
 *
 * Nguon: bang phoneme/viseme en-US cua Polly. Vai cho gop lai la CO Y:
 *   t  gop d/n/t  -> DD   (Oculus tach nn rieng cho n, nhung n va d cung
 *                          khau hinh moi; khac nhau o cach nha luoi)
 *   l             -> nn   (nn cua Oculus la luoi cham loi, dung cho l)
 *   e va E        -> E    (rig khong co shape rieng cho /eɪ/)
 *   o va O        -> O
 *   @ (schwa)     -> E nhung nhe hon, xem SCHWA_WEIGHT
 */
export const POLLY_TO_VISEME: Readonly<Record<string, Viseme>> = {
  sil: 'sil',
  p: 'PP', // b, m, p
  f: 'FF', // f, v
  T: 'TH', // θ, ð
  t: 'DD', // d, n, t
  k: 'kk', // g, h, k, ŋ
  S: 'CH', // ʃ, tʃ, dʒ, ʒ
  s: 'SS', // s, z
  l: 'nn', // l
  r: 'RR', // ɹ
  a: 'aa', // æ, ɑ, aɪ, aʊ
  e: 'E', //  eɪ
  E: 'E', //  ɛ, ʌ, ɜ
  '@': 'E', // ə, ɚ — schwa, mieng gan nhu nghi
  i: 'I', //  i, ɪ, j
  o: 'O', //  oʊ
  O: 'O', //  ɔ, ɔɪ
  u: 'U', //  u, ʊ, w
};

/**
 * Schwa la nguyen am giam, mieng chi he ra. Cho no trong so day nhu `E` thi
 * avatar nhai qua manh o cac am tiet khong nhan — nhin ra ngay la sai.
 */
export const SCHWA_WEIGHT = 0.55;

/**
 * Mo ta khau hinh bang tieng Viet.
 *
 * Day khong phai trang tri. Avatar Ready Player Me KHONG CO LUOI, morph target
 * cua no gan nhu chi co moi va ham — ma dung nhung phan biet kho nhat voi
 * nguoi Viet hoc tieng Anh lai nam o luoi: θ/ð (luoi giua hai rang), l va n,
 * am r. Nhin avatar khong thay duoc nhung cho do, nen phai noi thanh chu.
 */
export const VISEME_HINT_VI: Readonly<Record<Viseme, string>> = {
  sil: 'Mieng nghi, moi kep nhe',
  PP: 'Hai moi mim chat roi bat ra (p, b, m)',
  FF: 'Rang cua tren cham moi duoi (f, v)',
  TH: 'Dau luoi tho ra GIUA HAI RANG (th) — cho de luoi sau rang',
  DD: 'Dau luoi cham loi sau rang tren, mieng he (t, d, n)',
  kk: 'Cuong luoi nang len sat ngac mem, dau luoi ha (k, g, ng)',
  CH: 'Moi chum va dua ra truoc, rang gan cham nhau (ch, sh, j)',
  SS: 'Rang gan khep, hoi luon qua khe hep (s, z)',
  nn: 'Dau luoi cham loi va GIU nguyen, hoi thoat hai ben (l, n)',
  RR: 'Moi hoi tron, luoi cuon len nhung KHONG cham dau (r)',
  aa: 'Ha ham that rong, luoi nam thap (father, cat)',
  E: 'Mieng he vua, moi keo ngang mot chut (bed, but)',
  I: 'Moi keo rong sang hai ben, ham gan khep (see, sit)',
  O: 'Moi tron thanh vong o, ham ha vua (go, thought)',
  U: 'Moi tron va chum nho, day ra truoc (goose, would)',
};

export interface VisemeFrame {
  /** Moc ms tinh tu dau audio. */
  tMs: number;
  viseme: Viseme;
  /** Do mo toi da cua khau hinh nay, 0..1. */
  weight: number;
}

/** Mot cau/tu de luyen khau hinh, kem audio va timeline da tinh san. */
export interface DrillItem {
  id: string;
  text: string;
  /** Nhan de biet cau nay tu dau ra: tu vung hay vi du cua muc tieu. */
  source: 'vocabulary' | 'example';
  audioUrl: string;
  frames: VisemeFrame[];
}

export interface DrillResponse {
  /** false khi chua cau hinh Polly — client an tab luyen khau hinh di. */
  enabled: boolean;
  /** URL file .glb cua avatar. null thi client chi ve thanh do viseme. */
  avatarUrl: string | null;
  items: DrillItem[];
}

/**
 * Doi mot mark cua Polly sang frame. Tra null cho gia tri khong nhan ra —
 * bo qua con hon la nem, vi Polly co the them viseme moi cho ngon ngu khac
 * va mot gia tri la khong dang lam hong ca cau.
 */
export function frameFromPolly(time: number, value: string): VisemeFrame | null {
  const viseme = POLLY_TO_VISEME[value];
  if (!viseme) return null;
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
 *
 * Nam o shared chu khong o server vi ca hai phia deu goi Polly: server cho man
 * luyen khau hinh (cau co dinh, cache duoc), client cho hoi thoai (cau sinh ra
 * luc chay). Hai ban parse khac nhau la hai bo loi khac nhau.
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
 * Khau hinh dang mo tai moc `tMs`, va tien do da di duoc trong khau hinh do.
 *
 * Timeline cua Polly la cac moc RIENG LE, khong co do dai: mot viseme keo dai
 * cho toi moc ke tiep. Ham nay tra ve frame dang giu cung voi thoi diem het
 * han cua no, de ben goi tu quyet dinh cach lam muot.
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
