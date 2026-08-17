/**
 * Hai duong dua tieng noi cua AI ra loa. Nguoi hoc chon mot lan luc bat dau
 * bai, va no khoa cho ca buoi.
 *
 *   'openai' — OpenAI Realtime tu phat audio. Giong that cua model, con nguyen
 *              ngu dieu. Dat: tong hoa don gap ~2,1 lan (xem docs/cost.md muc
 *              6), vi audio out dat gap ~2,9 lan Polly va giong AI sinh ra con
 *              nam lai trong context de bi doc lai o moi luot sau.
 *
 *   'polly'  — OpenAI chi tra ve CHU, client tu goi Amazon Polly doc. Re hon,
 *              doi lai mat ngu dieu cua giong Realtime va them mot vong goi.
 *
 * Chieu LEN thi hai mode giong het nhau: audio cua hoc vien di thang toi
 * Realtime qua WebRTC. Mode chi doi duong tieng AI DI RA.
 *
 * Dung chung server va client vi CA HAI deu phai chan gia tri la: server chan
 * body cua POST va cot cu trong SQLite, client chan localStorage.
 */

export type VoiceMode = 'openai' | 'polly';

export const VOICE_MODES = ['openai', 'polly'] as const satisfies readonly VoiceMode[];

/**
 * AI co tu phat audio khong (`output_modalities: ["audio"]`)?
 *
 * false nghia la Realtime chi tra ve chu va client tu goi Polly doc.
 *
 * Hoi qua ham nay chu khong so thang `=== 'openai'` o tung cho: gan mot chuc
 * cho trong session.ts va server re theo dung cau hoi NAY, va them mot mode
 * nua thi sua o day chu khong phai di do lai tung cho.
 */
export const aiSpeaksItself = (mode: VoiceMode): boolean => mode !== 'polly';

/**
 * Mac dinh la duong re. Cung la duong dung cho moi buoi hoc tao truoc khi co
 * cot `voice_mode` — chung doc ra chuoi rong va roi ve day, tuc la hanh vi cu
 * khong doi.
 */
export const VOICE_MODE_DEFAULT: VoiceMode = 'polly';

const isVoiceMode = (v: unknown): v is VoiceMode =>
  typeof v === 'string' && (VOICE_MODES as readonly string[]).includes(v);

/**
 * Gia tri la roi ve `fallback` chu khong nem loi: khong co gia tri nao cua
 * truong nay dang de lam hong mot buoi hoc.
 */
export function normalizeVoiceMode(value: unknown, fallback: VoiceMode = VOICE_MODE_DEFAULT): VoiceMode {
  return isVoiceMode(value) ? value : fallback;
}
