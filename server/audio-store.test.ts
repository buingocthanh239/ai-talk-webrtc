/**
 * Chay `audio-store` o che do s3 that (MinIO), tu cap quyen den doc lai.
 *
 *   docker compose --profile dev up -d minio minio-init
 *   S3_ENDPOINT=http://localhost:9000 node --test server/audio-store.test.ts
 *
 * Khong dat S3_ENDPOINT thi test tu skip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const endpoint = process.env.S3_ENDPOINT;
const skip = endpoint ? false : 'can S3_ENDPOINT (vd MinIO o http://localhost:9000)';

// audio-store doc env luc nap module, nen phai dat truoc khi import.
process.env.AUDIO_STORE = 's3';
process.env.S3_REGION ??= 'us-east-1';
process.env.S3_BUCKET ??= 'ai-learn-audio';
process.env.AWS_ACCESS_KEY_ID ??= 'minioadmin';
process.env.AWS_SECRET_ACCESS_KEY ??= 'minioadmin';

const audio = skip ? null : await import('./audio-store.ts');

const SESSION = 'store-test-session';

test('key tren S3 giu cung hinh dang voi duong dan tren dia', { skip }, () => {
  assert.equal(audio!.audioKey(SESSION, 3, 'user'), `audio/${SESSION}/003-user.wav`);
  assert.equal(audio!.diskPath(SESSION, 3, 'user'), `${SESSION}/003-user.wav`);
  assert.equal(audio!.audioKey(SESSION, 12, 'assistant'), `audio/${SESSION}/012-assistant.wav`);
});

test('verifyKey tu choi key khong khop (sessionId, seq, role)', { skip }, () => {
  assert.equal(
    audio!.verifyKey(SESSION, 3, 'user', `audio/${SESSION}/003-user.wav`),
    `audio/${SESSION}/003-user.wav`
  );

  // Doi seq, doi role, hoac tro sang session khac deu phai bi chan — day la
  // cho duy nhat chan viec gan file cua minh vao message cua nguoi khac.
  assert.throws(() => audio!.verifyKey(SESSION, 3, 'user', `audio/${SESSION}/004-user.wav`));
  assert.throws(() => audio!.verifyKey(SESSION, 3, 'user', `audio/${SESSION}/003-assistant.wav`));
  assert.throws(() => audio!.verifyKey(SESSION, 3, 'user', 'audio/nan-nhan/003-user.wav'));
});

test('vong day len roi doc lai qua audio-store', { skip }, async () => {
  const grant = audio!.uploadGrant(SESSION);
  assert.ok(grant, 'AUDIO_STORE=s3 thi phai co grant');

  const key = audio!.audioKey(SESSION, 7, 'user');
  const bytes = Buffer.concat([Buffer.alloc(44), Buffer.from('xin chao')]);

  const form = new FormData();
  form.append('key', key);
  for (const [name, value] of Object.entries(grant.fields)) form.append(name, value);
  form.append('file', new Blob([bytes], { type: 'audio/wav' }));

  const res = await fetch(grant.url, { method: 'POST', body: form });
  assert.equal(res.status, 204, await res.text());

  const back = await audio!.readAudio('s3', key);
  assert.equal(back.length, bytes.length);
  assert.equal(back.subarray(44).toString(), 'xin chao');
});

test('readAudio nem loi ro rang khi khong co file', { skip }, async () => {
  await assert.rejects(
    () => audio!.readAudio('s3', audio!.audioKey(SESSION, 999, 'user')),
    /S3 tra ve 404/
  );
});

test('khong co CDN thi playbackUrl la presigned GET dung duoc', { skip }, async () => {
  const key = audio!.audioKey(SESSION, 7, 'user');
  const url = audio!.playbackUrl('s3', key);
  assert.match(url, /X-Amz-Signature=/);
  assert.equal((await fetch(url)).status, 200);
});

test('message cu tren dia van ra URL cua route static', { skip }, () => {
  assert.equal(audio!.playbackUrl('disk', 'sess-cu/003-user.wav'), '/audio/sess-cu/003-user.wav');
});
