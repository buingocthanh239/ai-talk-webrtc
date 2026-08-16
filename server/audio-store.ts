/**
 * Noi duy nhat biet audio nam o dau.
 *
 * `index.ts` va `grader.ts` chi noi chuyen qua day, nen doi disk <-> S3 khong
 * lan ra cho khac. Hai backend song chung duoc vi moi message ghi kem cot
 * `audio_store`: buoi hoc cu ghi tren dia van nghe lai duoc sau khi bat S3.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AUDIO_DIR } from './db.ts';
import type { Role } from '../shared/types.ts';
import { presignGet, presignPost, s3ConfigFromEnv, type UploadGrant } from './s3.ts';
import { canSign, cdnConfigFromEnv, cdnUrl, signedCookies, signedUrl } from './cdn.ts';

export type AudioStore = 'disk' | 's3';

/** Nga ra ngay luc khoi dong neu cau hinh thieu, khong doi den luc upload. */
const s3 = s3ConfigFromEnv();
const cdn = cdnConfigFromEnv();

export const activeStore: AudioStore = s3 ? 's3' : 'disk';

/** WAV rong nhat co the la 45 byte header; 5MB la thua cho mot luot noi. */
const MIN_BYTES = 45;
const MAX_BYTES = 5 * 1024 * 1024;

/** Quyen ghi song 2 tieng — du cho ca buoi hoc lan background upload cua mobile. */
const GRANT_TTL_SEC = 2 * 60 * 60;

/** Quyen nghe lai song 1 tieng — du de xem het man tong ket. */
const PLAYBACK_TTL_MS = 60 * 60 * 1000;

if (s3 && !cdn) {
  console.warn(
    '  [audio] AUDIO_STORE=s3 nhung khong co CDN_DOMAIN — se phat lai bang presigned GET.'
  );
}

// Che do public khong sai, nhung no la thu duy nhat o day khong co han su dung:
// URL phat ra song mai. Mot dong log de no la mot lua chon nhin thay duoc chu
// khong phai mot mac dinh am tham.
if (cdn && !canSign(cdn)) {
  console.warn(
    '  [audio] CDN_DOMAIN khong kem key pair — phat lai bang URL tran, khong han.\n' +
      '          Distribution phai dang public thi nguoi hoc moi nghe duoc.'
  );
}

// ------------------------------------------------------------------- key

/**
 * Duoi file theo vai, khong phai theo lua chon.
 *
 * Doan cua nguoi hoc la WAV cat ra tu ring buffer PCM. Cau cua AI la MP3 lay
 * nguyen tu Polly — giai ma roi ma hoa lai thanh WAV chi de dong duoi file thi
 * vua ton CPU vua lam file to len nhieu lan.
 */
const fileExt = (role: Role): string => (role === 'assistant' ? 'mp3' : 'wav');

const fileName = (seq: number, role: Role): string =>
  `${String(seq).padStart(3, '0')}-${role}.${fileExt(role)}`;

/**
 * Key tren S3 va duong dan tuong doi tren dia co y giu cung hinh dang, chi
 * khac tien to `audio/`. Nho vay URL phat lai cua ca hai deu la
 * `/audio/<sessionId>/<seq>-<role>.wav` — man tong ket khong phai biet gi.
 */
export const audioKeyPrefix = (sessionId: string): string => `audio/${sessionId}/`;

export const audioKey = (sessionId: string, seq: number, role: Role): string =>
  `${audioKeyPrefix(sessionId)}${fileName(seq, role)}`;

export const diskPath = (sessionId: string, seq: number, role: Role): string =>
  join(sessionId, fileName(seq, role));

// ------------------------------------------------------------------- ghi

/** Quyen ghi thang len S3 cho ca buoi hoc. null khi dang chay bang disk. */
export function uploadGrant(sessionId: string, at: number = Date.now()): UploadGrant | null {
  if (!s3) return null;
  return presignPost(
    s3,
    {
      keyPrefix: audioKeyPrefix(sessionId),
      contentType: 'audio/wav',
      // Mot chu ky phai phu ca WAV cua nguoi hoc lan MP3 cua Polly.
      contentTypePrefix: 'audio/',
      minBytes: MIN_BYTES,
      maxBytes: MAX_BYTES,
      expiresIn: GRANT_TTL_SEC,
    },
    at
  );
}

/**
 * Client bao da day xong. Khong tin key client gui: dung lai key tu
 * (sessionId, seq, role) roi doi chieu, neu khong thi mot client sua vai dong
 * co the gan file cua no vao message cua buoi khac.
 */
export function verifyKey(sessionId: string, seq: number, role: Role, claimed: string): string {
  const expected = audioKey(sessionId, seq, role);
  if (claimed !== expected) {
    throw new Error(`Key khong hop le: doi "${expected}", nhan "${claimed}"`);
  }
  return expected;
}

// ------------------------------------------------------------------- doc

/** Doc lai file de cham phat am. Grader khong can biet no nam o dau. */
export async function readAudio(store: AudioStore, path: string): Promise<Buffer> {
  if (store === 'disk') return readFile(join(AUDIO_DIR, path));
  if (!s3) throw new Error(`Message tro toi S3 nhung AUDIO_STORE khong phai s3: ${path}`);

  const res = await fetch(presignGet(s3, path, 300));
  if (!res.ok) throw new Error(`S3 tra ve ${res.status} cho ${path}`);
  return Buffer.from(await res.arrayBuffer());
}

// -------------------------------------------------------------- phat lai

/**
 * URL nghe lai.
 *
 * `signed = true` (client khong dung cookie duoc, vd mobile) thi ky thang vao
 * URL; con lai tra URL tran va dua chu ky qua cookie o `playbackCookies`.
 *
 * Distribution public thi ca hai duong ve chung mot cho: URL tran. Mobile xin
 * `signed` cung nhan URL tran chu khong phai loi — voi no thi day van la mot
 * URL phat duoc, va do moi la thu no can.
 */
export function playbackUrl(
  store: AudioStore,
  path: string,
  signed = false,
  at: number = Date.now()
): string {
  if (store === 'disk') return `/audio/${path}`;
  if (cdn) {
    return signed && canSign(cdn) ? signedUrl(cdn, path, at + PLAYBACK_TTL_MS) : cdnUrl(cdn, path);
  }
  // Khong dung CDN thi van phat duoc, chi la moi URL mot chu ky rieng.
  if (!s3) throw new Error(`Message tro toi S3 nhung AUDIO_STORE khong phai s3: ${path}`);
  return presignGet(s3, path, Math.floor(PLAYBACK_TTL_MS / 1000), at);
}

/**
 * Header Set-Cookie cho quyen nghe lai ca buoi. Rong khi khong dung CDN, dang
 * chay bang disk, hoac distribution public — cai cuoi khong co gi de ky, va
 * gui ba cookie vo nghia sang trinh duyet thi chi to them nhieu.
 */
export function playbackCookies(sessionId: string, at: number = Date.now()): string[] {
  if (!cdn || !canSign(cdn) || activeStore !== 's3') return [];
  const { cookies, path } = signedCookies(cdn, sessionId, at + PLAYBACK_TTL_MS);
  const maxAge = Math.floor(PLAYBACK_TTL_MS / 1000);
  return cookies.map(
    (c) =>
      `${c.name}=${c.value}; Domain=${cookieDomain(cdn.domain)}; Path=${path}; ` +
      `Max-Age=${maxAge}; Secure; HttpOnly; SameSite=None`
  );
}

/**
 * Cookie phai gui duoc sang subdomain cua CDN, nen bo bot mot cap: media.x.com
 * -> .x.com. Day la ly do CDN phai nam cung site voi app.
 */
function cookieDomain(domain: string): string {
  const parts = domain.split('.');
  return parts.length > 2 ? `.${parts.slice(1).join('.')}` : `.${domain}`;
}
