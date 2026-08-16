/**
 * Goi Amazon Polly THANG tu browser, tu ky SigV4.
 *
 * Cung thuat toan voi `server/polly.ts`, chi khac node:crypto -> WebCrypto nen
 * moi buoc deu async. Backend chi cap credential tam (xem `server/sts.ts`) roi
 * dung ngoai duong audio hoan toan.
 *
 * MOT CHO SE LAM MAT NUA BUOI NEU KHONG BIET TRUOC:
 *
 *   `crypto.subtle` chi ton tai trong secure context. `http://localhost` co,
 *   nhung `http://192.168.x.x` thi KHONG — mo tren dien thoai cung mang LAN se
 *   thay `crypto.subtle` la undefined chu khong phai loi chu ky. Phai co https
 *   hoac tunnel.
 */

import {
  parseSpeechMarks,
  type VisemeFrame,
} from '../../shared/viseme.ts';
import type { PollyGrant, PollyEngine } from '../../shared/types.ts';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 'polly';
const SPEECH_PATH = '/v1/speech';

/** Mot khuc doc lau hon nguong nay thi bo — khong duoc de hang doi treo. */
const TIMEOUT_MS = 10_000;
/** Polly throttle theo TPS cua ca account, nen 429 la chuyen co that. */
const RETRY_MS = [200, 600];

const enc = new TextEncoder();

export class PollyError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// ------------------------------------------------------------------ ky

async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(data)));
}

/** kSigning = HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request") */
async function signingKey(secret: string, date: string, region: string): Promise<ArrayBuffer> {
  const kDate = await hmac(enc.encode(`AWS4${secret}`), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

/** `20130524T000000Z` va `20130524` */
function stamps(at: number): { amzDate: string; date: string } {
  const amzDate = new Date(at).toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, date: amzDate.slice(0, 8) };
}

const host = (region: string): string => `polly.${region}.amazonaws.com`;

async function signedHeaders(
  grant: PollyGrant,
  body: string,
  at: number
): Promise<Record<string, string>> {
  const { amzDate, date } = stamps(at);
  const scope = `${date}/${grant.region}/${SERVICE}/aws4_request`;

  // Credential tam cua STS LUON co session token, nen `x-amz-security-token`
  // bat buoc nam trong SignedHeaders. Thieu no la 403 khong noi ly do.
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: host(grant.region),
    'x-amz-date': amzDate,
    'x-amz-security-token': grant.sessionToken,
  };
  const names = Object.keys(headers).sort();
  const signedNames = names.join(';');

  const canonicalRequest = [
    'POST',
    SPEECH_PATH,
    '',
    names.map((n) => `${n}:${headers[n]}`).join('\n') + '\n',
    signedNames,
    await sha256Hex(body),
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const signature = toHex(
    await hmac(await signingKey(grant.secretAccessKey, date, grant.region), stringToSign)
  );

  return {
    'Content-Type': 'application/json',
    'X-Amz-Date': amzDate,
    'X-Amz-Security-Token': grant.sessionToken,
    Authorization:
      `${ALGORITHM} Credential=${grant.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedNames}, Signature=${signature}`,
  };
}

// ------------------------------------------------------------------ goi

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function callPolly(
  grant: PollyGrant,
  payload: Record<string, unknown>,
  signal: AbortSignal
): Promise<Response> {
  const body = JSON.stringify(payload);

  for (let attempt = 0; ; attempt++) {
    const headers = await signedHeaders(grant, body, Date.now());
    const res = await fetch(`https://${host(grant.region)}${SPEECH_PATH}`, {
      method: 'POST',
      headers,
      body,
      signal,
    });
    if (res.ok) return res;

    const detail = (await res.text()).slice(0, 300);
    // 429 la throttle theo TPS cua ca account — cho mot nhip roi thu lai.
    // Cac loi khac (403 het han, 400 sai tham so) thi thu lai chi ton them
    // thoi gian.
    if (res.status === 429 && attempt < RETRY_MS.length) {
      await sleep(RETRY_MS[attempt] ?? 0);
      continue;
    }
    throw new PollyError(`Polly tra ve ${res.status}: ${detail}`, res.status);
  }
}

export interface SynthesisResult {
  /** Blob URL cua mp3. Ben goi phai `URL.revokeObjectURL` khi xong. */
  url: string;
  blob: Blob;
  frames: VisemeFrame[];
}

export interface SynthesizeOptions {
  voiceId: string;
  engine: PollyEngine;
  signal?: AbortSignal;
}

/**
 * Doc mot khuc va lay ve ca audio lan timeline khau hinh.
 *
 * HAI request vi speech marks tra ve THAY CHO audio chu khong kem theo — day
 * la thiet ke cua Polly, khong gop duoc. Chay song song nen khong ton them do
 * tre, chi ton tien va TPS.
 */
export async function synthesize(
  grant: PollyGrant,
  text: string,
  opts: SynthesizeOptions
): Promise<SynthesisResult> {
  if (!globalThis.crypto?.subtle) {
    throw new PollyError(
      'Trinh duyet khong cho ky AWS: crypto.subtle chi co trong secure context. ' +
        'Mo bang https hoac http://localhost.',
      0
    );
  }

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  const common = { Text: text, VoiceId: opts.voiceId, Engine: opts.engine };
  const [audioRes, marksRes] = await Promise.all([
    callPolly(grant, { ...common, OutputFormat: 'mp3' }, signal),
    callPolly(grant, { ...common, OutputFormat: 'json', SpeechMarkTypes: ['viseme'] }, signal),
  ]);

  const blob = await audioRes.blob();
  return {
    url: URL.createObjectURL(blob),
    blob,
    frames: parseSpeechMarks(await marksRes.text()),
  };
}

/** Con han it hon nguong nay thi coi nhu sap chet, xin cai moi truoc. */
const EXPIRY_MARGIN_MS = 60_000;

export const grantUsable = (grant: PollyGrant | null): grant is PollyGrant =>
  Boolean(grant && grant.expiresAt - Date.now() > EXPIRY_MARGIN_MS);
