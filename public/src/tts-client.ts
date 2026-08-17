/**
 * Cua duy nhat ma hang doi di qua de doc mot khuc.
 *
 * Ton tai de `speech-queue.ts` khong phai biet dang noi chuyen voi nha nao. Hang
 * doi la file kho nhat ben client — bo dem `#generation`, tran `MAX_IN_FLIGHT`,
 * lich su `emptied` bi hieu nham la "phat xong" — va no khong nen phai them mot
 * chieu bien thien nua vao dong do.
 *
 * Ba khac biet giua hai nha, che het o day:
 *
 *   | | Polly | Google |
 *   |---|---|---|
 *   | Ky | SigV4, WebCrypto, vai tram dong | `Bearer <token>`, mot dong |
 *   | Than | bytes mp3 tho | JSON, `audioContent` base64 |
 *   | Het han | 403 | 401 (con 403 la thieu quyen, xin lai vo ich) |
 *
 * Cot Polly con o day vi mode `polly` van song de lui ve duoc. Khi nao no khong
 * con thi ca file nay thanh mot lop vo mong — va do la luc nen bo no di, chu
 * khong phai luc giu lai cho "biet dau sau nay".
 */

import * as google from './google-tts-client.ts';
import * as polly from './polly-client.ts';
import { GoogleTtsError } from './google-tts-client.ts';
import { PollyError } from './polly-client.ts';
import type { TtsGrant } from '../../shared/types.ts';

export interface SynthesisResult {
  /** Blob URL cua mp3. Ben goi phai `URL.revokeObjectURL` khi xong. */
  url: string;
  blob: Blob;
}

export interface SynthesizeOptions {
  signal?: AbortSignal;
}

/**
 * Doc mot khuc thanh mp3.
 *
 * GIONG DI THEO GRANT, khong phai mot bien rieng. Truoc day hang doi giu
 * `voiceId`/`engine` rieng, khoi tao tu grant roi cho nguoi hoc doi — nhung khong
 * co cho nao goi `setVoice`, nen hai nguon su that do chi tao ra mot duong lech:
 * moi lan cap lai grant (reconnect, het han) am tham keo giong ve mac dinh cua
 * server. Gio chi con MOT nguon, va `switch` duoi day la cho duy nhat biet grant
 * co hinh dang gi.
 */
export async function synthesize(
  grant: TtsGrant,
  text: string,
  opts: SynthesizeOptions
): Promise<SynthesisResult> {
  switch (grant.provider) {
    case 'google':
      return google.synthesize(grant, text, { voice: grant.voice, ...opts });
    case 'polly':
      return polly.synthesize(grant, text, {
        voiceId: grant.voiceId,
        engine: grant.engine,
        ...opts,
      });
  }
}

/** Con han it hon nguong nay thi coi nhu sap chet, xin cai moi truoc. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Grant con dung duoc khong.
 *
 * Hoi TRUOC khi ban chu khong doi 401 roi moi biet: ban mot khuc bang token con
 * 5 giay la mat khuc do, con hoi truoc thi chi ton mot vong xin lai, va vong do
 * bi che hoan toan sau khuc dang phat.
 */
export const grantUsable = (grant: TtsGrant | null): grant is TtsGrant =>
  Boolean(grant && grant.expiresAt - Date.now() > EXPIRY_MARGIN_MS);

/**
 * Loi nay co dang de xin grant moi khong.
 *
 * Hai nha bao het han bang hai status khac nhau, va Google con mot cai bay nua:
 * 403 cua no la PERMISSION_DENIED (API chua bat, hoac SA thieu quyen) chu khong
 * phai het han. Coi 403 la het han thi moi khuc lai xin mot token moi, token moi
 * lai 403 — mot vong xin token khong loi thoat, dot dung cai quota o cap project
 * dang duoc dung de chan thiet hai.
 */
export function isAuthError(err: unknown): boolean {
  if (err instanceof GoogleTtsError) return err.status === 401;
  if (err instanceof PollyError) return err.status === 403;
  return false;
}
