/**
 * Credential cho CLIENT tu goi Polly.
 *
 * Vi sao khong de server goi Polly ho: moi cau AI noi deu phai tong hop, va
 * khuc DAU TIEN cua moi luot la toan bo do tre nguoi dung cam thay. Mot vong
 * round trip qua backend nam dung tren duong nong do. Client cam credential
 * thi goi thang AWS, va cat khuc nho tuy y ma khong ton them vong nao.
 *
 * Dieu do co nghia credential phai xuong toi browser. Co HAI duong, chon bang
 * viec co dat POLLY_STS_ROLE_ARN hay khong:
 *
 *   STS (co role ARN) — AssumeRole ra credential tam. Hai thu keo rui ro xuong:
 *
 *     1. Session policy rang vao IP cua chinh client (`aws:SourceIp`).
 *        Credential bi lay di chi dung duoc tu dung may do.
 *     2. `DateLessThan` cat han su dung xuong duoi SAN 900 giay cua AssumeRole
 *        — AWS khong cho DurationSeconds ngan hon 15 phut, nhung session policy
 *        thi cat tuy y.
 *
 *     Session policy GIAO voi policy cua role chu khong cong vao: role phai da
 *     cho `polly:SynthesizeSpeech` san, cho nay chi thu hep them.
 *
 *   THANG (khong co role ARN) — dua chinh credential cua backend xuong browser.
 *     Khong dung duoc mot rao nao o tren: khong han that, khong rang IP, va
 *     mang du quyen cua IAM user do chu khong rieng Polly. Duong nay chi danh
 *     cho demo, va no tu bao ra log moi lan khoi dong.
 *
 * Ky SigV4 bang chinh signingKey cua `s3.ts`, chi khac `service` — giong het
 * cach `polly.ts` lam. Van khong keo @aws-sdk ve.
 */

import { createHmac } from 'node:crypto';

import { signingKey, stamps, sha256Hex } from './s3.ts';
import type { PollyConfig, PollyEngine } from './polly.ts';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 'sts';
const API_VERSION = '2011-06-15';
const FORM_TYPE = 'application/x-www-form-urlencoded; charset=utf-8';

/** San cua AssumeRole. Xin ngan hon thi AWS tu choi thang. */
const MIN_TTL_SEC = 900;
/** Tran mac dinh cua MaxSessionDuration tren mot IAM role moi tao. */
const MAX_TTL_SEC = 3600;

export interface CredsConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Vang mat = duong THANG: credential cua backend di thang xuong browser. */
  roleArn?: string;
  ttlSec: number;
  bindIp: boolean;
}

/** CredsConfig da co role. Kieu nay la dieu kien de goi assumeRole. */
export type StsConfig = CredsConfig & { roleArn: string };

export const usesSts = (cfg: CredsConfig): cfg is StsConfig => Boolean(cfg.roleArn);

/**
 * Quyen goi Polly cap cho client, mot lan cho ca buoi hoc.
 *
 * Trung hinh dang voi `PollyGrant` o shared/types.ts — day la thu di qua ranh
 * gioi HTTP nen kieu that su nam ben do.
 */
export interface TempCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Vang mat o duong THANG — credential dai han khong co token nao. */
  sessionToken?: string;
  expiresAt: number;
}

/**
 * Doc cau hinh tu env. null = khong co credential nao, hoi thoai se khong co
 * tieng noi cua AI (client bao ra man hinh, giong cach drill bao `enabled:false`).
 *
 * Nhan `PollyConfig` thay vi tu doc lai POLLY_REGION/S3_REGION: goi duoc ham
 * nay nghia la POLLY=on va region da duoc `polly.ts` chot, khong co ly do giai
 * lai cung mot bai toan o hai cho roi cho chung le nhau.
 *
 * Dung lai credential AWS cua S3: van mot tai khoan, khong co ly do bat nguoi
 * cau hinh khai lan thu ba.
 */
export function pollyCredsFromEnv(polly: PollyConfig, env = process.env): CredsConfig | null {
  const roleArn = env.POLLY_STS_ROLE_ARN ?? '';
  const accessKeyId = env.AWS_ACCESS_KEY_ID ?? '';
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY ?? '';

  if (!accessKeyId || !secretAccessKey) {
    // Dat role ARN la da noi ro y dinh, nen thieu credential de dong vai la
    // loi cau hinh chu khong phai "thoi khong bat nua".
    if (roleArn) {
      throw new Error(
        'POLLY_STS_ROLE_ARN da dat nhung thieu AWS_ACCESS_KEY_ID / ' +
          'AWS_SECRET_ACCESS_KEY. Xem .env.example.'
      );
    }
    return null;
  }

  return {
    region: polly.region,
    accessKeyId,
    secretAccessKey,
    ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    ...(roleArn ? { roleArn } : {}),
    ttlSec: Math.min(
      MAX_TTL_SEC,
      Math.max(MIN_TTL_SEC, Number(env.POLLY_STS_TTL_SEC) || MAX_TTL_SEC)
    ),
    bindIp: (env.POLLY_STS_BIND_IP ?? 'on') === 'on',
  };
}

// ------------------------------------------------------------------ policy

/**
 * IP nao dang rang buoc duoc.
 *
 * Loopback va dai private thi rang vao vo nghia: luc dev thi ai cung la
 * 127.0.0.1, con sau NAT/reverse proxy khong cau hinh X-Forwarded-For thi moi
 * nguoi deu chung mot IP noi bo. Rang vao nhung dia chi do vua khong chan duoc
 * ai, vua lam credential chet oan khi topology doi.
 */
export function bindableIp(ip: string | null): string | null {
  if (!ip) return null;

  // ::ffff:203.0.113.5 — IPv4 nhin qua ong kinh IPv6, rat pho bien tren Node.
  const plain = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;

  if (plain === '::1' || plain === 'localhost') return null;
  if (/^127\./.test(plain)) return null;
  if (/^10\./.test(plain)) return null;
  if (/^192\.168\./.test(plain)) return null;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(plain)) return null;
  // fc00::/7 — unique local address cua IPv6
  if (/^f[cd]/i.test(plain) && plain.includes(':')) return null;

  return plain.includes(':') ? `${plain}/128` : `${plain}/32`;
}

function sessionPolicy(expiresAt: number, cidr: string | null): string {
  const condition: Record<string, Record<string, string>> = {
    DateLessThan: { 'aws:CurrentTime': new Date(expiresAt).toISOString() },
  };
  if (cidr) condition['IpAddress'] = { 'aws:SourceIp': cidr };

  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: 'polly:SynthesizeSpeech',
        Resource: '*',
        Condition: condition,
      },
    ],
  });
}

/**
 * RoleSessionName phai khop [\w+=,.@-]{2,64}.
 *
 * Day la thu duy nhat cho phep truy nguoc trong CloudTrail xem thiet bi nao
 * dot Polly, nen dung bo di cho gon.
 */
export function sessionName(raw: string): string {
  const cleaned = (raw || '').replace(/[^\w+=,.@-]/g, '-').slice(0, 64);
  return cleaned.length >= 2 ? cleaned : 'ai-learn';
}

// ------------------------------------------------------------------ ky

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

const host = (region: string): string => `sts.${region}.amazonaws.com`;

/**
 * Header da ky cho mot POST form-encoded toi STS.
 *
 * Nhan `at` thay vi tu goi Date.now() de doi chieu duoc voi test vector, giong
 * cach `s3.ts` va `polly.ts` lam.
 */
export function signedHeaders(
  cfg: StsConfig,
  body: string,
  at: number = Date.now()
): Record<string, string> {
  const { amzDate, date } = stamps(at);
  const scope = `${date}/${cfg.region}/${SERVICE}/aws4_request`;

  // Header duoc ky phai sap xep theo ten va viet thuong. Them mot header vao
  // request ma quen dua vao SignedHeaders thi AWS tra 403 khong noi ly do.
  const headers: Record<string, string> = {
    'content-type': FORM_TYPE,
    host: host(cfg.region),
    'x-amz-date': amzDate,
    ...(cfg.sessionToken ? { 'x-amz-security-token': cfg.sessionToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const signedNames = names.join(';');

  const canonicalRequest = [
    'POST',
    '/',
    '', // STS nhan tham so trong body, khong dung query string
    names.map((n) => `${n}:${headers[n]}`).join('\n') + '\n',
    signedNames,
    sha256Hex(body),
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(
    signingKey(cfg.secretAccessKey, date, cfg.region, SERVICE),
    stringToSign
  ).toString('hex');

  return {
    'Content-Type': FORM_TYPE,
    'X-Amz-Date': amzDate,
    ...(cfg.sessionToken ? { 'X-Amz-Security-Token': cfg.sessionToken } : {}),
    Authorization:
      `${ALGORITHM} Credential=${cfg.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedNames}, Signature=${signature}`,
  };
}

// ------------------------------------------------------------------ goi

/**
 * Boc mot the ra khoi XML.
 *
 * STS tra ve XML nhung ta chi can bon truong phang, khong long nhau, khong
 * lap lai. Keo mot parser XML ve cho bon regex la khong dang.
 */
function pick(xml: string, tag: string): string {
  return new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? '';
}

export async function assumeRole(
  cfg: StsConfig,
  opts: { sessionName: string; sourceIp: string | null },
  at: number = Date.now()
): Promise<TempCredentials> {
  const expiresAt = at + cfg.ttlSec * 1000;
  const cidr = cfg.bindIp ? bindableIp(opts.sourceIp) : null;

  const body = new URLSearchParams({
    Action: 'AssumeRole',
    Version: API_VERSION,
    RoleArn: cfg.roleArn,
    RoleSessionName: sessionName(opts.sessionName),
    DurationSeconds: String(cfg.ttlSec),
    Policy: sessionPolicy(expiresAt, cidr),
  }).toString();

  const res = await fetch(`https://${host(cfg.region)}/`, {
    method: 'POST',
    headers: signedHeaders(cfg, body, at),
    body,
  });

  const xml = await res.text();
  if (!res.ok) {
    throw new Error(`STS tra ve ${res.status}: ${xml.slice(0, 300)}`);
  }

  const accessKeyId = pick(xml, 'AccessKeyId');
  const secretAccessKey = pick(xml, 'SecretAccessKey');
  const sessionToken = pick(xml, 'SessionToken');
  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    throw new Error(`STS tra ve 200 nhung khong co credential: ${xml.slice(0, 300)}`);
  }

  // Han cua chinh credential co the ngan hon han ta xin. Lay so nho hon giua
  // no va moc DateLessThan trong session policy — het cai nao truoc thi cai do
  // moi la han that.
  const stsExpiry = Date.parse(pick(xml, 'Expiration'));
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken,
    expiresAt: Number.isFinite(stsExpiry) ? Math.min(stsExpiry, expiresAt) : expiresAt,
  };
}

// ------------------------------------------------------------------ grant

export interface PollyGrantShape {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAt: number;
  voiceId: string;
  engine: PollyEngine;
}

/**
 * Credential cua chinh backend, khong qua STS.
 *
 * `expiresAt` o day la mot han BIA: credential dai han khong het han bao gio.
 * Van dat no de client giu nguyen vong xin lai theo `grantUsable()` — xin lai
 * chi nhan ve dung cai cu, khong hong gi. Noi that ra thi giu nguyen vong do
 * re hon la mo mot nhanh rieng trong client cho mot che do chi dung de demo.
 */
function directCreds(cfg: CredsConfig, at: number): TempCredentials {
  return {
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    ...(cfg.sessionToken ? { sessionToken: cfg.sessionToken } : {}),
    expiresAt: at + cfg.ttlSec * 1000,
  };
}

/**
 * Quyen goi Polly hoan chinh cho client: credential cong voi giong/engine mac
 * dinh. Nguoi hoc doi giong duoc o phia client, nen day chi la diem xuat phat
 * chu khong phai rang buoc.
 */
export async function pollyGrant(
  polly: PollyConfig,
  cfg: CredsConfig,
  opts: { sessionName: string; sourceIp: string | null },
  at: number = Date.now()
): Promise<PollyGrantShape> {
  const creds = usesSts(cfg) ? await assumeRole(cfg, opts, at) : directCreds(cfg, at);
  return {
    region: polly.region,
    ...creds,
    voiceId: polly.voiceId,
    engine: polly.engine,
  };
}
