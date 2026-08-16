/**
 * Chay tron vong grant -> POST -> presigned GET tren mot S3 that.
 *
 * Test vector chi chung minh minh ky ra dung chuoi do; no khong chung minh S3
 * CHAP NHAN chu ky. Hai loi hay gap nhat — thu tu field trong FormData va
 * dieu kien policy sai — chi lo ra o day.
 *
 *   docker compose --profile dev up -d minio minio-init
 *   S3_ENDPOINT=http://localhost:9000 node --test server/s3.integration.test.ts
 *
 * Khong dat S3_ENDPOINT thi test tu skip.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { presignGet, presignPost, type S3Config } from './s3.ts';

const endpoint = process.env.S3_ENDPOINT;
const skip = endpoint ? false : 'can S3_ENDPOINT (vd MinIO o http://localhost:9000)';

const cfg: S3Config = {
  region: process.env.S3_REGION ?? 'us-east-1',
  bucket: process.env.S3_BUCKET ?? 'ai-learn-audio',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'minioadmin',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'minioadmin',
  ...(endpoint ? { endpoint } : {}),
};

const SESSION_ID = 'itest-session';
const grantFor = (sessionId: string) =>
  presignPost(cfg, {
    keyPrefix: `audio/${sessionId}/`,
    contentType: 'audio/wav',
    minBytes: 45,
    maxBytes: 5 * 1024 * 1024,
    expiresIn: 7200,
  });

/** WAV 16kHz mono rong — chi can du 45 byte header de qua content-length-range. */
function wavBlob(samples = 400): Blob {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples * 2, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples * 2, 40);
  return new Blob([header, Buffer.alloc(samples * 2)], { type: 'audio/wav' });
}

/** Dung dung thu tu ma client that su dung — day la thu dang duoc kiem tra. */
async function upload(grant: ReturnType<typeof grantFor>, key: string, blob: Blob) {
  const form = new FormData();
  form.append('key', key);
  for (const [name, value] of Object.entries(grant.fields)) form.append(name, value);
  form.append('file', blob);
  return fetch(grant.url, { method: 'POST', body: form });
}

before(async () => {
  if (skip) return;
  const res = await fetch(`${endpoint}/`).catch(() => null);
  assert.ok(res, `Khong ket noi duoc toi ${endpoint} — da chay docker compose chua?`);
});

test('grant cua session cho phep ghi trong prefix cua chinh no', { skip }, async () => {
  const key = `audio/${SESSION_ID}/003-user.wav`;
  const res = await upload(grantFor(SESSION_ID), key, wavBlob());
  assert.equal(res.status, 204, await res.text());
});

test('doc lai bang presigned GET ra dung so byte da ghi', { skip }, async () => {
  const key = `audio/${SESSION_ID}/004-user.wav`;
  const blob = wavBlob(800);
  assert.equal((await upload(grantFor(SESSION_ID), key, blob)).status, 204);

  const res = await fetch(presignGet(cfg, key, 300));
  assert.equal(res.status, 200);
  assert.equal((await res.arrayBuffer()).byteLength, blob.size);
});

test('grant cua session nay KHONG ghi duoc sang session khac', { skip }, async () => {
  // Day la rang buoc duy nhat chan mot client sua vai dong ghi de len audio
  // cua buoi hoc nguoi khac. Neu no chi la trang tri thi phai biet ngay.
  const res = await upload(grantFor(SESSION_ID), 'audio/nan-nhan/003-user.wav', wavBlob());
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
});

test('file vuot content-length-range bi tu choi', { skip }, async () => {
  const tooBig = new Blob([Buffer.alloc(6 * 1024 * 1024)], { type: 'audio/wav' });
  const res = await upload(grantFor(SESSION_ID), `audio/${SESSION_ID}/005-user.wav`, tooBig);
  assert.equal(res.ok, false);
});

test('presigned GET het han thi khong doc duoc', { skip }, async () => {
  const key = `audio/${SESSION_ID}/006-user.wav`;
  assert.equal((await upload(grantFor(SESSION_ID), key, wavBlob())).status, 204);

  const expired = presignGet(cfg, key, 1, Date.now() - 60_000);
  const res = await fetch(expired);
  assert.equal(res.ok, false);
});
