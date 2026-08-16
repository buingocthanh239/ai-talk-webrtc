/**
 * Amazon Polly — sinh audio va viseme timeline cho che do luyen khau hinh.
 *
 * Vi sao la Polly chu khong phai suy viseme tu audio cua Realtime API: suy tu
 * pho am thanh cho ra chuyen dong dung NHIP nhung sai AM VI (phu am bat gan
 * nhu khong tach duoc khoi khoang lang). Day la app day phat am, nhep sai la
 * day sai. Polly tra thang viseme kem moc ms, chinh xac theo dinh nghia.
 *
 * Ky SigV4 bang chinh signingKey cua `s3.ts` — chi khac `service` va la ky
 * header thay vi ky query string. Van khong keo @aws-sdk ve.
 *
 * HAI dieu de vap:
 *   1. Speech marks tra ve THAY CHO audio, khong kem theo. Phai goi hai lan.
 *      Cung Text + VoiceId + Engine thi moc thoi gian khop nhau.
 *   2. Engine `generative` KHONG ho tro speech marks (ValidationException).
 *      Chi `standard`, `neural`, `long-form` co. Mac dinh o day la neural.
 */

import { createHash, createHmac } from 'node:crypto';

import { signingKey, stamps, sha256Hex } from './s3.ts';
import { parseSpeechMarks, type VisemeFrame } from '../shared/viseme.ts';
import type { PollyEngine } from '../shared/types.ts';

// Client goi Polly thang nen phai parse cung mot kieu — luat doc speech marks
// nam o shared/viseme.ts. Giu export o day cho cac cho da import tu `polly.ts`.
export { parseSpeechMarks };

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 'polly';

// Engine di ca sang client (trong PollyGrant) nen kieu nam o shared.
export type { PollyEngine };

export interface PollyConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  voiceId: string;
  engine: PollyEngine;
}

const ENGINES: readonly string[] = ['standard', 'neural', 'long-form'];

/**
 * Doc cau hinh tu env. null = chua bat Polly, che do luyen khau hinh se an di
 * thay vi lam sap server — day la tinh nang phu, khong phai duong song.
 *
 * Dung lai AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY cua S3: cung mot tai
 * khoan AWS, khong co ly do bat nguoi cau hinh khai hai lan. Region thi tach
 * rieng vi bucket va Polly khong bat buoc cung vung.
 */
export function pollyConfigFromEnv(env = process.env): PollyConfig | null {
  if ((env.POLLY ?? 'off') !== 'on') return null;

  const engine = env.POLLY_ENGINE ?? 'neural';
  if (!ENGINES.includes(engine)) {
    throw new Error(
      `POLLY_ENGINE="${engine}" khong hop le. Chi ${ENGINES.join(', ')} — ` +
        'engine generative khong tra speech marks nen khong dung duoc o day.'
    );
  }

  const cfg: PollyConfig = {
    region: env.POLLY_REGION ?? env.S3_REGION ?? '',
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
    ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    voiceId: env.POLLY_VOICE ?? 'Joanna',
    engine: engine as PollyEngine,
  };

  const missing = (['region', 'accessKeyId', 'secretAccessKey'] as const).filter((k) => !cfg[k]);
  if (missing.length) {
    throw new Error(`POLLY=on nhung thieu: ${missing.join(', ')}. Xem .env.example.`);
  }
  return cfg;
}

// ------------------------------------------------------------------ ky

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

const host = (region: string): string => `polly.${region}.amazonaws.com`;

/**
 * Header da ky cho mot POST toi Polly.
 *
 * Tach rieng khoi `synthesize` de test doi chieu duoc voi test vector: ham
 * nhan `at` thay vi tu goi Date.now(), giong cach `s3.ts` lam.
 */
export function signedHeaders(
  cfg: PollyConfig,
  path: string,
  body: string,
  at: number = Date.now()
): Record<string, string> {
  const { amzDate, date } = stamps(at);
  const scope = `${date}/${cfg.region}/${SERVICE}/aws4_request`;
  const payloadHash = sha256Hex(body);

  // Header duoc ky phai sap xep theo ten va viet thuong. Them mot header vao
  // request ma quen dua vao signedHeaders thi AWS tra 403 khong noi ly do.
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: host(cfg.region),
    'x-amz-date': amzDate,
    ...(cfg.sessionToken ? { 'x-amz-security-token': cfg.sessionToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const signedNames = names.join(';');

  const canonicalRequest = [
    'POST',
    path,
    '', // Polly khong dung query string cho SynthesizeSpeech
    names.map((n) => `${n}:${headers[n]}`).join('\n') + '\n',
    signedNames,
    payloadHash,
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(
    signingKey(cfg.secretAccessKey, date, cfg.region, SERVICE),
    stringToSign
  ).toString('hex');

  return {
    'Content-Type': 'application/json',
    'X-Amz-Date': amzDate,
    ...(cfg.sessionToken ? { 'X-Amz-Security-Token': cfg.sessionToken } : {}),
    Authorization:
      `${ALGORITHM} Credential=${cfg.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedNames}, Signature=${signature}`,
  };
}

// ------------------------------------------------------------------ goi

const SPEECH_PATH = '/v1/speech';

async function callPolly(cfg: PollyConfig, payload: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(payload);
  const res = await fetch(`https://${host(cfg.region)}${SPEECH_PATH}`, {
    method: 'POST',
    headers: signedHeaders(cfg, SPEECH_PATH, body),
    body,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Polly tra ve ${res.status}: ${detail}`);
  }
  return res;
}

export interface Synthesis {
  audio: Buffer;
  frames: VisemeFrame[];
}

/**
 * Doc mot cau va lay ve ca audio lan timeline khau hinh.
 *
 * Hai request chay SONG SONG: chung doc lap nhau va deu la round trip toi
 * AWS, noi tiep thi cho gap doi ma khong duoc gi.
 */
export async function synthesize(cfg: PollyConfig, text: string): Promise<Synthesis> {
  const common = { Text: text, VoiceId: cfg.voiceId, Engine: cfg.engine };

  const [audioRes, marksRes] = await Promise.all([
    callPolly(cfg, { ...common, OutputFormat: 'mp3' }),
    callPolly(cfg, { ...common, OutputFormat: 'json', SpeechMarkTypes: ['viseme'] }),
  ]);

  return {
    audio: Buffer.from(await audioRes.arrayBuffer()),
    frames: parseSpeechMarks(await marksRes.text()),
  };
}

/**
 * Id on dinh cho mot cau da doc. Doi giong hay doi engine la doi id, nen
 * cache cu khong bi phat nham bang timeline cua giong khac.
 */
export function drillId(cfg: PollyConfig, text: string): string {
  return createHash('sha256')
    .update(`${cfg.voiceId}|${cfg.engine}|${text}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}
