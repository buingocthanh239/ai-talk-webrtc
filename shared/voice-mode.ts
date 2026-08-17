/**
 * Ba duong dua tieng noi cua AI ra loa. Nguoi hoc chon mot lan luc bat dau bai,
 * va no khoa cho ca buoi.
 *
 *   'openai' — OpenAI Realtime tu phat audio. Giong that cua model, con nguyen
 *              ngu dieu. Dat: tong hoa don gap ~2,1 lan (xem docs/cost.md muc
 *              6), vi audio out dat gap ~2,9 lan Polly va giong AI sinh ra con
 *              nam lai trong context de bi doc lai o moi luot sau.
 *
 *   'google' — OpenAI chi tra ve CHU, client tu goi Google Cloud TTS doc. Day la
 *              duong dang dung.
 *
 *   'polly'  — nhu tren nhung goi Amazon Polly. Giu lai de lui ve duoc khi
 *              Google co van de; khong con la duong mac dinh.
 *
 * Chieu LEN thi ca ba mode giong het nhau: audio cua hoc vien di thang toi
 * Realtime qua WebRTC. Mode chi doi duong tieng AI DI RA.
 *
 * Dung chung server va client vi CA HAI deu phai chan gia tri la: server chan
 * body cua POST va cot cu trong SQLite, client chan localStorage.
 */

export type VoiceMode = 'openai' | 'polly' | 'google';

export const VOICE_MODES = ['openai', 'polly', 'google'] as const satisfies readonly VoiceMode[];

/** Nha TTS ma CLIENT tu goi. Mode 'openai' khong goi nha nao. */
export type TtsProvider = 'polly' | 'google';

/**
 * AI co tu phat audio khong (`output_modalities: ["audio"]`)?
 *
 * false nghia la Realtime chi tra ve chu va client tu goi nha TTS doc.
 *
 * Hoi qua ham nay chu khong so thang o tung cho: gan mot chuc cho trong
 * session.ts va server re theo dung cau hoi NAY.
 *
 * DIEU KIEN PHAI LA `=== 'openai'`, KHONG PHAI `!== 'polly'`. Hai cach viet
 * tuong duong khi chi co hai mode, va cach thu hai la cach cu. Voi mode thu ba
 * thi no lat nguoc y nghia: `google` bi coi la AI tu noi, Realtime duoc bat
 * audio out, va nguoi hoc nghe hai giong doc chong len nhau cung mot cau.
 */
export const aiSpeaksItself = (mode: VoiceMode): boolean => mode === 'openai';

/**
 * Client phai goi nha TTS nao, hay khong goi ai.
 *
 * Tach khoi `aiSpeaksItself` vi day la HAI cau hoi khac nhau: mot cau quyet dinh
 * co bat audio out cua Realtime, mot cau quyet dinh cam grant nao va ky request
 * kieu gi. Truoc day mot phep so sanh tra loi duoc ca hai — chi vi tinh co chi
 * co hai mode.
 */
export const clientTtsProvider = (mode: VoiceMode): TtsProvider | null =>
  mode === 'openai' ? null : mode;

/**
 * Mac dinh la Google.
 *
 * Cung la duong cho moi buoi hoc tao truoc khi co cot `voice_mode` — chung doc
 * ra chuoi rong va roi ve day. Nhung buoi do da ket thuc, cho duy nhat con dung
 * mode la nut "doc lai" o man tong ket, nen keo ca chung sang Google la co y:
 * nuoi mot duong Polly song chi de phuc vu lich su thi khong dang.
 *
 * LUU Y: day la mac dinh cua KIEU, khong phai mac dinh cua mot lan chay. Server
 * con phai xet xem nha do da cau hinh chua — xem `effectiveVoiceMode` trong
 * server/index.ts. Mac dinh tro toi mot nha chua bat la buoi hoc im lang.
 */
export const VOICE_MODE_DEFAULT: VoiceMode = 'google';

/** Nha TTS nao dang co cau hinh dung duoc tren server. */
export interface TtsAvailability {
  polly: boolean;
  google: boolean;
}

/**
 * Mode duoc xin -> mode that su chay duoc.
 *
 * Ton tai vi mot mode co the tro toi mot nha CHUA CAU HINH, va khi do khong cho
 * nao bao loi: grant null la trang thai hop le ("chua bat"), nen buoi hoc chi
 * lang le hien chu ma khong co tieng. Chi can quen `GOOGLE_TTS=on` la moi buoi
 * hoc moi im lang — va do la cai bay ma viec doi mac dinh sang `google` mo ra.
 *
 * Lui ve theo thu tu: nha duoc xin -> nha con lai -> `openai`.
 *
 * `openai` la day cuoi va khong can kiem tra: khong co no thi khong co ca buoi
 * hoc. No dat hon (~2,1 lan ca hoa don, xem docs/cost.md muc 6) nhung co tieng,
 * va do la danh doi dung khi lua chon con lai la im lang.
 */
export function effectiveVoiceMode(wanted: VoiceMode, available: TtsAvailability): VoiceMode {
  const provider = clientTtsProvider(wanted);
  if (!provider) return wanted;
  if (available[provider]) return wanted;

  const other: TtsProvider = provider === 'google' ? 'polly' : 'google';
  return available[other] ? other : 'openai';
}

const isVoiceMode = (v: unknown): v is VoiceMode =>
  typeof v === 'string' && (VOICE_MODES as readonly string[]).includes(v);

/**
 * Gia tri la roi ve `fallback` chu khong nem loi: khong co gia tri nao cua
 * truong nay dang de lam hong mot buoi hoc.
 */
export function normalizeVoiceMode(value: unknown, fallback: VoiceMode = VOICE_MODE_DEFAULT): VoiceMode {
  return isVoiceMode(value) ? value : fallback;
}
