/**
 * Cau hinh Google Cloud Text-to-Speech.
 *
 * File nay KHONG goi Google. Server khong doc cau nao ca — moi request tong hop
 * deu do client tu goi (`public/src/google-tts-client.ts`), vi khuc dau tien cua
 * moi luot la toan bo do tre nguoi dung cam thay va mot vong round trip qua
 * backend nam dung tren duong nong do.
 *
 * Cai con lai o day chi la doc env: giong mac dinh. Con credential thi khong doc
 * o day — viec do thuoc ve `google-token.ts`, giong het cach `polly.ts` de
 * credential cho `sts.ts`.
 *
 * KHAC POLLY MOT DIEM DANG NHO: khong co `region` va khong co `engine`. Ten giong
 * cua Google mang ca hai thong tin do trong chinh no — `en-US-Chirp3-HD-Achird`
 * noi ro ngon ngu, ho giong va bien the — nen khong con gi de khai rieng.
 */

/** Giong Google: ten day du cong ngon ngu. Google doi CA HAI trong moi request. */
export interface GoogleTtsVoice {
  name: string;
  languageCode: string;
}

export interface GoogleTtsConfig {
  voice: GoogleTtsVoice;
}

/**
 * Chirp3-HD la ho giong moi nhat va tu nhien nhat, ~$30/1M ky tu.
 *
 * Chi la diem xuat phat: tung nhan vat de len bang `voiceGoogle` trong
 * `server/characters/*.json`, va mapping that su nen chon bang tai — xem
 * `GET /dev/voices`.
 */
const DEFAULT_VOICE = 'en-US-Chirp3-HD-Achird';

/**
 * Suy ngon ngu tu ten giong: `en-US-Chirp3-HD-Achird` -> `en-US`.
 *
 * Google doi ca `voice.name` lan `voice.languageCode` trong moi request, va khong
 * khop nhau thi tra 400. Bat nguoi cau hinh khai hai truong bat buoc phai khop
 * la dat mot cai bay, nen suy ra thay vi hoi.
 */
export function languageOf(voiceName: string): string | null {
  return /^([a-z]{2,3}-[A-Z]{2})(-|$)/.exec(voiceName)?.[1] ?? null;
}

/**
 * Doc cau hinh tu env. null = chua bat Google TTS.
 *
 * Nga ra khi ten giong khai sai chu khong lang le lay mac dinh: request tong hop
 * do client ban va moi khuc mot request, nen mot ten giong sai khong lam server
 * hong — no lam moi khuc cua moi buoi hoc tra 400 trong browser cua nguoi hoc,
 * va cho duy nhat thay duoc la console cua may ho.
 */
export function googleTtsConfigFromEnv(env = process.env): GoogleTtsConfig | null {
  if ((env.GOOGLE_TTS ?? 'off') !== 'on') return null;

  const raw = env.GOOGLE_TTS_VOICE;
  if (raw !== undefined && !raw.trim()) {
    throw new Error('GOOGLE_TTS_VOICE dat nhung rong. Bo han bien do de dung mac dinh.');
  }
  const name = raw?.trim() || DEFAULT_VOICE;

  const languageCode = env.GOOGLE_TTS_LANGUAGE?.trim() || languageOf(name);
  if (!languageCode) {
    throw new Error(
      `Khong suy ra duoc ngon ngu tu GOOGLE_TTS_VOICE="${name}". Ten giong cua ` +
        'Google bat dau bang ma ngon ngu (vd en-US-Chirp3-HD-Achird) — neu giong ' +
        'nay khong theo quy tac do thi khai thang GOOGLE_TTS_LANGUAGE.'
    );
  }

  return { voice: { name, languageCode } };
}
