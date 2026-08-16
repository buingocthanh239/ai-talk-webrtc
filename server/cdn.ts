/**
 * Ky signed cookie / signed URL cua CloudFront bang node:crypto.
 *
 * Bucket dong public hoan toan, CloudFront doc qua OAC. Nguoi nghe lai o man
 * tong ket phai cam chu ky do server cap, va chu ky do gioi han theo DUNG mot
 * session — lo URL cua buoi nay khong mo duoc buoi khac.
 *
 * Hai co che cho hai loai client, dung chung mot key pair:
 *
 *   - Web   -> signed cookie. Trinh duyet tu dinh kem, `<audio src>` khong
 *              phai biet gi ca.
 *   - Mobile -> signed URL. Native khong co cookie jar tu nhien, ma
 *              AVPlayer/ExoPlayer thi nuot URL co query string thoai mai.
 *
 * DISTRIBUTION PUBLIC thi khong co gi de ky: behavior khong gan trusted key
 * group, moi URL tran deu mo duoc. Luc do key pair thanh thua, va bat khai no
 * chi la bat go mot thu khong dung den. Xem `canSign` ben duoi.
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface CdnConfig {
  /** Vd: media.example.com */
  domain: string;
  /** Vang mat = distribution public, phat bang URL tran. */
  keyPairId?: string;
  privateKey?: string;
}

/** CdnConfig da du key pair. Kieu nay la dieu kien de goi signedUrl/signedCookies. */
export type SigningCdnConfig = Required<CdnConfig>;

export function canSign(cfg: CdnConfig): cfg is SigningCdnConfig {
  return Boolean(cfg.keyPairId && cfg.privateKey);
}

export function cdnConfigFromEnv(env = process.env): CdnConfig | null {
  if (!env.CDN_DOMAIN) return null;
  const domain = bareDomain(env.CDN_DOMAIN);

  const privateKey = env.CF_PRIVATE_KEY ?? readKeyFile(env.CF_PRIVATE_KEY_PATH);

  // Khong khai gi ca = co y de public. Day la mot lua chon hop le, khong phai
  // thieu sot: file da mo cho ai cung doc duoc thi ky vao chi ton CPU.
  if (!env.CF_KEY_PAIR_ID && !privateKey) return { domain };

  // Chi co MOT nua thi gan nhu chac chan la cau hinh do dang — go nham ten
  // bien, secret chua mount kip. Tut ve URL tran o day nghia la mot
  // distribution CO ky lai im lang phat URL khong ky, va trieu chung se la 403
  // o tan trinh duyet cua nguoi hoc chu khong phai mot dong log luc khoi dong.
  if (!env.CF_KEY_PAIR_ID || !privateKey) {
    throw new Error(
      'Co CDN_DOMAIN va mot nua key pair. Dat ca CF_KEY_PAIR_ID lan ' +
        'CF_PRIVATE_KEY(_PATH) de ky, hoac bo trong CA HAI neu distribution ' +
        'la public. Xem .env.example.'
    );
  }
  return { domain, keyPairId: env.CF_KEY_PAIR_ID, privateKey };
}

/**
 * Chi lay phan HOST cua CDN_DOMAIN.
 *
 * Cho nay ghep `https://${domain}/${key}`, nen dan ca URL tu console CloudFront
 * vao se ra `https://https://d111.cloudfront.net/...`. Do la thao tac tu nhien
 * nhat cua nguoi cau hinh, va trieu chung thi lai hien o tan the <audio> khong
 * phat duoc. Cat o day re hon nhieu so voi di lan nguoc lai. Cung tinh than voi
 * `S3_ENDPOINT` bi cat dau `/` thua trong s3.ts.
 */
function bareDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/+$/, '');
}

function readKeyFile(path?: string): string | null {
  if (!path) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Khong doc duoc CF_PRIVATE_KEY_PATH=${path}: ${(err as Error).message}`);
  }
}

/**
 * Base64 cua CloudFront khong phai base64 chuan: `+/=` doi thanh `-_~` de
 * nhet vua vao cookie va query string.
 */
const cfBase64 = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');

/** Custom policy: mot resource (co the co `*`) kem han dung. */
function policyFor(resource: string, expiresAt: number): string {
  return JSON.stringify({
    Statement: [
      {
        Resource: resource,
        Condition: { DateLessThan: { 'AWS:EpochTime': Math.floor(expiresAt / 1000) } },
      },
    ],
  });
}

function sign(cfg: SigningCdnConfig, policy: string): string {
  // RSA-SHA1 la thuat toan CloudFront quy dinh cho trusted key group; khong
  // phai lua chon cua minh.
  return cfBase64(createSign('RSA-SHA1').update(policy).sign(cfg.privateKey));
}

export interface CdnCookie {
  name: string;
  value: string;
}

/**
 * Ba cookie cho phep nghe MOI file cua dung mot session.
 *
 * `Path` bo hep theo session luon: cookie cua buoi nay khong bi gui kem khi
 * phat buoi khac, nen mot chu ky ro ri cung chi mo duoc dung buoi do.
 */
export function signedCookies(
  cfg: SigningCdnConfig,
  sessionId: string,
  expiresAt: number
): { cookies: CdnCookie[]; path: string } {
  const path = `/audio/${sessionId}/`;
  const policy = policyFor(`https://${cfg.domain}${path}*`, expiresAt);
  return {
    path,
    cookies: [
      { name: 'CloudFront-Policy', value: cfBase64(Buffer.from(policy, 'utf8')) },
      { name: 'CloudFront-Signature', value: sign(cfg, policy) },
      { name: 'CloudFront-Key-Pair-Id', value: cfg.keyPairId },
    ],
  };
}

/** URL day du kem chu ky, cho client khong dung cookie duoc (mobile). */
export function signedUrl(cfg: SigningCdnConfig, key: string, expiresAt: number): string {
  const url = `https://${cfg.domain}/${key}`;
  const policy = policyFor(url, expiresAt);
  const params = new URLSearchParams({
    Policy: cfBase64(Buffer.from(policy, 'utf8')),
    Signature: sign(cfg, policy),
    'Key-Pair-Id': cfg.keyPairId,
  });
  return `${url}?${params}`;
}

/** URL tran, chi mo duoc khi kem signed cookie. */
export const cdnUrl = (cfg: CdnConfig, key: string): string => `https://${cfg.domain}/${key}`;
