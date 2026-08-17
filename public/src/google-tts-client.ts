/**
 * Goi Google Cloud TTS THANG tu browser.
 *
 * So voi `polly-client.ts` thi file nay ngan hon mot nua, va ca phan bien mat la
 * phan ky: Google chi doi `Authorization: Bearer <token>`. Khong SigV4, khong
 * WebCrypto, va — cho quan trong tren mobile va LAN — KHONG doi secure context.
 * Duong Polly khong bao gio chay noi tren `http://192.168.x.x` vi `crypto.subtle`
 * khong ton tai o do; duong nay chay.
 *
 * BA CHO KHAC POLLY, ca ba deu de quen:
 *
 *   1. Than tra ve la JSON `{audioContent: "<base64>"}` chu KHONG phai bytes mp3.
 *      Quen giai ma thi the <audio> nhan mot chuoi chu cai va im lang.
 *   2. Khong co cua xep hang. Polly bat noi tiep vi endpoint h2 cua no bao
 *      `MAX_CONCURRENT_STREAMS = 1`; Google khong co rang buoc do, nen khuc N+1
 *      duoc tong hop that su song song voi khuc N. Dung mang `serial` sang day.
 *   3. Token het han la 401 (Polly la 403).
 */

import type { GoogleTtsGrant } from '../../shared/types.ts';
import type { SynthesisResult } from './tts-client.ts';

const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

/** Mot khuc doc lau hon nguong nay thi bo — khong duoc de hang doi treo. */
const TIMEOUT_MS = 10_000;
/** 429 la quota cua ca project, nen no la chuyen co that. */
const RETRY_MS = [200, 600];

export class GoogleTtsError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * base64 -> bytes. `atob` co san trong moi browser va trong Node >= 16.
 *
 * Cap phat `ArrayBuffer` tuong minh chu khong de `new Uint8Array(n)` tu lo: kieu
 * mac dinh la `ArrayBufferLike`, con `BlobPart` doi dung `ArrayBuffer` (no khong
 * nhan `SharedArrayBuffer`).
 */
function decodeAudio(base64: string): Uint8Array<ArrayBuffer> {
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export interface GoogleSynthesizeOptions {
  voice: { name: string; languageCode: string };
  signal?: AbortSignal;
}

/**
 * Doc mot khuc thanh mp3.
 *
 * KHONG gui `speakingRate` hay `pitch`. Toc do doc di qua `playbackRate` cua the
 * <audio> — `speakingRate` nam trong request nen chi doi duoc tu khuc KE TIEP,
 * con `playbackRate` doi duoc giua chung mot cau. Do cung la ly do ca duong nay
 * dung <audio> chu khong phai Web Audio.
 */
export async function synthesize(
  grant: GoogleTtsGrant,
  text: string,
  opts: GoogleSynthesizeOptions
): Promise<SynthesisResult> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  const body = JSON.stringify({
    input: { text },
    voice: { languageCode: opts.voice.languageCode, name: opts.voice.name },
    audioConfig: { audioEncoding: 'MP3' },
  });

  for (let attempt = 0; ; attempt++) {
    let status: number;
    let payload: string;
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          // Token trong HEADER chu khong phai `?key=` / `?access_token=`: query
          // string nam trong log cua moi proxy tren duong di.
          Authorization: `Bearer ${grant.accessToken}`,
          'Content-Type': 'application/json',
        },
        body,
        signal,
      });
      status = res.status;
      payload = await res.text();
    } catch (err) {
      // LOI TANG MANG — khong co status nao ca, `fetch` nem thang. Doi Wi-Fi, may
      // vua ngu day, socket dut giua chung. Chrome KHONG tu thu lai POST (chi thu
      // lai method idempotent) nen phai tu lam. Ma ta thi biet la an toan: cung
      // mot dau vao cho ra cung mot audio.
      console.error(err);
      if (signal.aborted || attempt >= RETRY_MS.length) throw err;
      await sleep(RETRY_MS[attempt] ?? 0);
      continue;
    }

    if (status === 200) {
      let audioContent: unknown;
      try {
        audioContent = (JSON.parse(payload) as { audioContent?: unknown }).audioContent;
      } catch {
        throw new GoogleTtsError(`Google tra ve 200 nhung khong phai JSON`, status);
      }
      if (typeof audioContent !== 'string' || !audioContent) {
        // Tra ve blob rong thi the <audio> ban `ended` ngay va ca luot chay tiep
        // nhu khong co gi — cau AI bien mat ma khong ai bao loi.
        throw new GoogleTtsError('Google tra ve 200 nhung khong co audioContent', status);
      }
      const blob = new Blob([decodeAudio(audioContent)], { type: 'audio/mpeg' });
      return { url: URL.createObjectURL(blob), blob };
    }

    // 429 = quota cua project, 5xx = phia Google. Cac loi khac (401 het han, 400
    // sai ten giong) thi thu lai chi ton them thoi gian.
    const retryable = status === 429 || status >= 500;
    if (retryable && attempt < RETRY_MS.length) {
      await sleep(RETRY_MS[attempt] ?? 0);
      continue;
    }

    throw new GoogleTtsError(
      `Google TTS tra ve ${status}: ${payload.slice(0, 300)}`,
      status
    );
  }
}
