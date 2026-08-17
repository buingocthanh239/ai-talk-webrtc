/**
 * Access token cho CLIENT tu goi Google Cloud TTS.
 *
 * Vi sao khong de server doc ho: moi cau AI noi deu phai tong hop, va khuc DAU
 * TIEN cua moi luot la toan bo do tre nguoi dung cam thay. Mot vong round trip
 * qua backend nam dung tren duong nong do. Client cam token thi goi thang Google,
 * va cat khuc nho tuy y ma khong ton them vong nao.
 *
 * DE DANG HON POLLY MOT BAC. Polly doi client tu ky SigV4 — vai tram dong
 * WebCrypto, va chi chay duoc trong secure context. Google chi doi mot header
 * `Authorization: Bearer <token>`. Toan bo module ky ben client bien mat.
 *
 * NHUNG SIET LAI THI KHO HON MOT BAC, va day la doi doi that su cua viec doi nha:
 *
 *   STS cua AWS cho gan session policy + `DateLessThan` + `aws:SourceIp`, nen
 *   credential Polly roi ra ngoai chi dung duoc tu dung may do, trong dung vai
 *   phut, va chi goi duoc `polly:SynthesizeSpeech`.
 *
 *   Access token cua service account KHONG CO CAI NAO trong ba thu do. No la
 *   bearer token cho ca SA, song 1 tieng, goi duoc moi API ma SA duoc phep.
 *   Credential Access Boundary — co che downscope duy nhat cua GCP — chi ap dung
 *   cho Cloud Storage, khong ap duoc o day.
 *
 * Nen bon viec sau day khong phai "nen lam" ma la DIEU KIEN de duong nay an
 * toan, va ba trong bon nam ngoai code:
 *
 *   1. GCP project rieng chi chua TTS.
 *   2. SA khong co quyen gi khac ngoai TTS.
 *   3. Quota cap + budget alert o cap project. Day la cai chan thiet hai THAT,
 *      khong phai IAM.
 *   4. Rate limit cap token theo userId — cai duy nhat nam trong code, xem
 *      `server/index.ts`.
 *
 * Vi sao ky JWT bang SA key chu khong dung `generateAccessToken` de impersonate
 * (nhu `docs/webrtc-migration.md` muc B4 de xuat): `generateAccessToken` doi
 * backend tu xac thuc duoc voi GCP ma khong can key tren dia — dung tren GCE/GKE
 * nho metadata server, khong dung o day. Repo nay chay `node` tren may thuong,
 * khong co metadata server nao, nen key phai nam tren dia dang nao. Da co key
 * roi thi them mot vong impersonate chi them mot hop network chu khong bo duoc
 * cai key. Duong impersonate van dung o production, va no cam vao dung cho nay.
 */

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

/**
 * Cloud TTS KHONG CO scope nao hep hon cai nay.
 *
 * Da kiem: khong ton tai `.../auth/cloud-platform.texttospeech` hay tuong tu.
 * Day la ly do goc cua toan bo phan canh bao o dau file — token nay khong the
 * bi thu hep xuong "chi doc chu", nen phan thu hep phai lam bang IAM cua SA.
 */
export const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** Han toi da cua mot JWT tu ky theo Google: 1 tieng. */
const JWT_TTL_SEC = 3600;

/**
 * Con han it hon nguong nay thi mint lai.
 *
 * Rong hon nhieu so voi cai margin 60 giay ben client, va co y: client con phai
 * GIU token nay mot luc roi ban nhieu khuc bang no. Tra ve mot token con 10 giay
 * la dung ky thuat ma vo dung tren thuc te.
 */
const REFRESH_MARGIN_MS = 300_000;

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

export interface GoogleToken {
  accessToken: string;
  expiresAt: number;
}

// ------------------------------------------------------------------ doc env

/**
 * Doc service account tu env. null = chua khai gi.
 *
 * Hai duong: `GOOGLE_TTS_SA_FILE` tro toi file JSON tai ve tu GCP console, hoac
 * `GOOGLE_TTS_SA_JSON` dan thang noi dung vao (tien cho container va CI, cho
 * mount mot file la them viec).
 *
 * Khai sai thi NEM chu khong tra null: null nghia la "chua bat", con day la "da
 * noi ro y dinh nhung khai sai" — hai chuyen khac nhau.
 */
export function serviceAccountFromEnv(env = process.env): ServiceAccount | null {
  const file = env.GOOGLE_TTS_SA_FILE?.trim();
  const inline = env.GOOGLE_TTS_SA_JSON?.trim();
  if (!file && !inline) return null;

  let raw: string;
  let source: string;
  if (inline) {
    raw = inline;
    source = 'GOOGLE_TTS_SA_JSON';
  } else {
    source = `GOOGLE_TTS_SA_FILE (${file})`;
    try {
      raw = readFileSync(file as string, 'utf8');
    } catch (err) {
      throw new Error(`Khong doc duoc ${source}: ${err instanceof Error ? err.message : err}`);
    }
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${source} khong phai JSON hop le.`);
  }

  const clientEmail = typeof parsed['client_email'] === 'string' ? parsed['client_email'] : '';
  const privateKey = typeof parsed['private_key'] === 'string' ? parsed['private_key'] : '';
  if (!clientEmail) throw new Error(`${source} thieu client_email.`);
  if (!privateKey) throw new Error(`${source} thieu private_key.`);

  const tokenUri =
    typeof parsed['token_uri'] === 'string' && parsed['token_uri']
      ? parsed['token_uri']
      : DEFAULT_TOKEN_URI;

  return { clientEmail, privateKey, tokenUri };
}

// ------------------------------------------------------------------ ky JWT

const b64url = (data: string | Buffer): string =>
  Buffer.from(data as never).toString('base64url');

const segment = (obj: Record<string, unknown>): string => b64url(JSON.stringify(obj));

/**
 * JWT tu ky de doi lay access token.
 *
 * `aud` PHAI la token_uri chu khong phai endpoint TTS — day la cho hay sai nhat,
 * va Google tra ve 400 `invalid_grant` khong noi them gi.
 *
 * Nhan `at` thay vi tu goi Date.now() de doi chieu duoc voi test vector, giong
 * cach `s3.ts` / `sts.ts` lam.
 */
export function signedJwt(sa: ServiceAccount, at: number = Date.now()): string {
  const iat = Math.floor(at / 1000);
  const body =
    `${segment({ alg: 'RS256', typ: 'JWT' })}.` +
    `${segment({
      iss: sa.clientEmail,
      scope: SCOPE,
      aud: sa.tokenUri,
      iat,
      exp: iat + JWT_TTL_SEC,
    })}`;

  const signature = createSign('RSA-SHA256').update(body).sign(sa.privateKey);
  return `${body}.${b64url(signature)}`;
}

// ------------------------------------------------------------------ doi token

async function exchange(sa: ServiceAccount, at: number): Promise<GoogleToken> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: signedJwt(sa, at),
  }).toString();

  const res = await fetch(sa.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google tra ve ${res.status} khi doi token: ${text.slice(0, 300)}`);
  }

  let parsed: { access_token?: unknown; expires_in?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error(`Google tra ve 200 nhung khong phai JSON: ${text.slice(0, 300)}`);
  }

  const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token : '';
  if (!accessToken) {
    throw new Error(`Google tra ve 200 nhung khong co access_token: ${text.slice(0, 300)}`);
  }

  const expiresIn = Number(parsed.expires_in) || JWT_TTL_SEC;
  return { accessToken, expiresAt: at + expiresIn * 1000 };
}

export interface GoogleTokenSource {
  /** Token dung duoc. Tra ve ban trong cache khi con han. */
  token: (at?: number) => Promise<GoogleToken>;
}

/**
 * Nguon token co cache.
 *
 * MOT TOKEN DUNG CHO NHIEU NGUOI, va do la lua chon co y thuc: token cua Google
 * khong rang duoc vao ai ca (khong co `aws:SourceIp`, khong co session policy),
 * nen mint rieng cho tung nguoi cung khong lam no thanh cua rieng cua ai. Mint
 * rieng chi ton them request. Cai thuc su gioi han thiet hai la quota cap o cap
 * project cong rate limit theo userId — xem dau file.
 *
 * Cache giu GIA TRI da giai quyet chu khong giu promise cua lan hong: nho vay
 * mot lan Google 500 khong dong bang duong tieng cho toi luc restart server.
 * Nhung `inFlight` thi VAN la promise — nhieu buoi hoc mo cung luc luc cache con
 * rong phai gop lai thanh mot request, khong phai moi cai mot.
 */
export function googleTokenSource(sa: ServiceAccount): GoogleTokenSource {
  let cached: GoogleToken | null = null;
  let inFlight: Promise<GoogleToken> | null = null;

  return {
    token: async (at: number = Date.now()): Promise<GoogleToken> => {
      if (cached && cached.expiresAt - at > REFRESH_MARGIN_MS) return cached;
      if (inFlight) return inFlight;

      const run = exchange(sa, at)
        .then((fresh) => {
          cached = fresh;
          return fresh;
        })
        .finally(() => {
          inFlight = null;
        });

      inFlight = run;
      return run;
    },
  };
}
