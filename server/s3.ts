/**
 * Ky AWS Signature V4 bang node:crypto — khong dung @aws-sdk.
 *
 * Server chi can dung hai thu cua S3: cap quyen GHI cho client (presigned POST
 * policy) va tu DOC lai luc cham diem (presigned GET roi fetch). Ca hai deu la
 * HMAC-SHA256 thuan, nen keo ca AWS SDK ve chi de lam hai viec nay la khong
 * dang — du an nay khong co dependency nao.
 *
 * Cac ham ky deu nhan `at` (epoch ms) thay vi tu goi Date.now(), de test doi
 * chieu duoc voi test vector chinh thuc cua AWS.
 */

import { createHash, createHmac } from 'node:crypto';

export interface S3Config {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Tro toi MinIO khi dev. Co gia tri => dung path-style URL. */
  endpoint?: string;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';

// ------------------------------------------------------------------ config

/**
 * Doc cau hinh tu env. Tra ve null khi khong bat S3 — goi phai tu roi ve disk.
 * Bat S3 ma thieu bien thi nga ra ngay luc khoi dong, khong de den luc user
 * noi xong cau dau tien moi phat hien khong luu duoc audio.
 */
export function s3ConfigFromEnv(env = process.env): S3Config | null {
  if ((env.AUDIO_STORE ?? 'disk') !== 's3') return null;

  const cfg: S3Config = {
    region: env.S3_REGION ?? '',
    bucket: env.S3_BUCKET ?? '',
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
    ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT.replace(/\/+$/, '') } : {}),
  };

  const missing = (['region', 'bucket', 'accessKeyId', 'secretAccessKey'] as const).filter(
    (k) => !cfg[k]
  );
  if (missing.length) {
    throw new Error(
      `AUDIO_STORE=s3 nhung thieu: ${missing.join(', ')}. Xem .env.example.`
    );
  }
  return cfg;
}

// ------------------------------------------------------------------ ky co ban

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

const sha256Hex = (data: string): string =>
  createHash('sha256').update(data, 'utf8').digest('hex');

/** kSigning = HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request") */
export function signingKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service = SERVICE
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * encodeURIComponent bo sot `!'()*` so voi RFC 3986. S3 ky theo RFC 3986 nen
 * thieu mot ky tu la sai chu ky, va loi tra ve chi la "SignatureDoesNotMatch".
 */
const encodeRfc3986 = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );

/** Ma hoa key thanh duong dan: tung doan mot, dau `/` giu nguyen. */
const encodeKeyPath = (key: string): string => key.split('/').map(encodeRfc3986).join('/');

/** `20130524T000000Z` va `20130524` */
function stamps(at: number): { amzDate: string; date: string } {
  const amzDate = new Date(at).toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, date: amzDate.slice(0, 8) };
}

const credentialScope = (date: string, region: string): string =>
  `${date}/${region}/${SERVICE}/aws4_request`;

// ------------------------------------------------------------------ endpoint

/** URL goc de POST len, va host dung khi ky. Co endpoint => path-style. */
export function bucketEndpoint(cfg: S3Config): { url: string; host: string; pathPrefix: string } {
  if (cfg.endpoint) {
    const { host } = new URL(cfg.endpoint);
    return { url: `${cfg.endpoint}/${cfg.bucket}`, host, pathPrefix: `/${cfg.bucket}` };
  }
  const host = `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
  return { url: `https://${host}`, host, pathPrefix: '' };
}

/**
 * Duong dan dung khi ky. Path-style co them ten bucket o dau, virtual-hosted
 * thi khong — lech mot ky tu o day la S3 tra 403 ma khong noi vi sao.
 */
export function canonicalPath(cfg: S3Config, key: string): string {
  const { pathPrefix } = bucketEndpoint(cfg);
  return `${pathPrefix}/${encodeKeyPath(key.replace(/^\/+/, ''))}`;
}

// ------------------------------------------------------------------ presign GET

/**
 * URL GET co chu ky trong query string. Dung cho grader doc lai file WAV:
 * khong can ky header, chi fetch thang.
 */
export function presignGet(
  cfg: S3Config,
  key: string,
  expiresIn = 300,
  at: number = Date.now(),
  hostOverride?: string
): string {
  const { amzDate, date } = stamps(at);
  const { host } = bucketEndpoint(cfg);
  const signHost = hostOverride ?? host;
  const scope = credentialScope(date, cfg.region);

  const params: [string, string][] = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${cfg.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresIn)],
    ...(cfg.sessionToken
      ? ([['X-Amz-Security-Token', cfg.sessionToken]] as [string, string][])
      : []),
    ['X-Amz-SignedHeaders', 'host'],
  ];

  const canonicalQuery = params
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    'GET',
    canonicalPath(cfg, key),
    canonicalQuery,
    `host:${signHost}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(
    signingKey(cfg.secretAccessKey, date, cfg.region),
    stringToSign
  ).toString('hex');

  const base = cfg.endpoint
    ? `${cfg.endpoint}/${cfg.bucket}/${key}`
    : `https://${host}/${key}`;
  return `${base}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ------------------------------------------------------------------ presign POST

export interface PostPolicyOptions {
  /** Client duoc ghi bat cu key nao bat dau bang chuoi nay, khong ra ngoai. */
  keyPrefix: string;
  contentType: string;
  minBytes: number;
  maxBytes: number;
  expiresIn: number;
}

export interface UploadGrant {
  url: string;
  fields: Record<string, string>;
  keyPrefix: string;
  expiresAt: number;
}

/**
 * Cap quyen ghi MOT LAN cho ca buoi hoc thay vi ky lai tung file.
 *
 * Presigned PUT khong lam duoc viec nay: chu ky cua PUT gan chet vao mot key
 * cu the, nen moi luot noi phai hoi server xin URL moi — them mot vong round
 * trip ngay tren duong nong sau moi cau, va URL ngan han thi background upload
 * task cua mobile gan nhu khong kip dung. POST policy ky theo DIEU KIEN
 * (`starts-with $key`), nen mot chu ky phu het ca buoi.
 */
export function presignPost(
  cfg: S3Config,
  opts: PostPolicyOptions,
  at: number = Date.now()
): UploadGrant {
  const { amzDate, date } = stamps(at);
  const { url } = bucketEndpoint(cfg);
  const scope = credentialScope(date, cfg.region);
  const credential = `${cfg.accessKeyId}/${scope}`;
  const expiresAt = at + opts.expiresIn * 1000;

  const fields: Record<string, string> = {
    'Content-Type': opts.contentType,
    'x-amz-algorithm': ALGORITHM,
    'x-amz-credential': credential,
    'x-amz-date': amzDate,
    ...(cfg.sessionToken ? { 'x-amz-security-token': cfg.sessionToken } : {}),
  };

  const policy = {
    expiration: new Date(expiresAt).toISOString(),
    conditions: [
      { bucket: cfg.bucket },
      ['starts-with', '$key', opts.keyPrefix],
      { 'Content-Type': opts.contentType },
      ['content-length-range', opts.minBytes, opts.maxBytes],
      { 'x-amz-algorithm': ALGORITHM },
      { 'x-amz-credential': credential },
      { 'x-amz-date': amzDate },
      ...(cfg.sessionToken ? [{ 'x-amz-security-token': cfg.sessionToken }] : []),
    ],
  };

  const encodedPolicy = Buffer.from(JSON.stringify(policy), 'utf8').toString('base64');
  fields['policy'] = encodedPolicy;
  fields['x-amz-signature'] = hmac(
    signingKey(cfg.secretAccessKey, date, cfg.region),
    encodedPolicy
  ).toString('hex');

  return { url, fields, keyPrefix: opts.keyPrefix, expiresAt };
}
