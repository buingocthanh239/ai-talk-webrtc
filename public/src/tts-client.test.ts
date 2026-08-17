/**
 *   node --test public/src/tts-client.test.ts
 *
 * Cua duy nhat ma hang doi di qua de doc mot khuc. Ba cau hoi:
 *
 *   1. Grant nao thi goi nha nao. Goi nham nha la 100% khuc hong.
 *   2. Grant con dung duoc khong — hoi TRUOC khi ban, chu khong doi 401 roi moi
 *      biet.
 *   3. Loi nao dang de xin token moi. Cho nay hai nha KHAC NHAU, va do dung la
 *      thu ma mot cua chung nen che di.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { grantUsable, isAuthError, synthesize } from './tts-client.ts';
import { GoogleTtsError } from './google-tts-client.ts';
import { PollyError } from './polly-client.ts';
import type { GoogleTtsGrant, PollyGrant } from '../../shared/types.ts';

const GOOGLE: GoogleTtsGrant = {
  provider: 'google',
  accessToken: 'ya29.TOKEN',
  expiresAt: Date.now() + 3600_000,
  voice: { name: 'en-US-Chirp3-HD-Achird', languageCode: 'en-US' },
};

const POLLY: PollyGrant = {
  provider: 'polly',
  region: 'ap-southeast-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  expiresAt: Date.now() + 3600_000,
  voiceId: 'Joanna',
  engine: 'neural',
};

interface Stub {
  restore: () => void;
  urls: () => string[];
}

function stubFetch(body: string): Stub {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return new Response(body, { status: 200 });
  }) as typeof globalThis.fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    urls: () => urls,
  };
}

// ------------------------------------------------------------------ dinh tuyen

test('grant google di toi Google', async () => {
  const stub = stubFetch(JSON.stringify({ audioContent: Buffer.from('MP3').toString('base64') }));
  try {
    const r = await synthesize(GOOGLE, 'Hello there.', {});
    assert.match(stub.urls()[0] ?? '', /texttospeech\.googleapis\.com/);
    assert.equal(await r.blob.text(), 'MP3');
  } finally {
    stub.restore();
  }
});

test('grant polly di toi Polly', async () => {
  // Duong Polly con song de lui ve duoc. Neu mot ngay no khong con thi test nay
  // la cho dau tien noi ra.
  const stub = stubFetch('MP3BYTES');
  try {
    const r = await synthesize(POLLY, 'Hello there.', {});
    assert.match(stub.urls()[0] ?? '', /polly\.ap-southeast-1\.amazonaws\.com/);
    assert.equal(await r.blob.text(), 'MP3BYTES');
  } finally {
    stub.restore();
  }
});

test('giong di theo GRANT chu khong phai mot bien rieng', async () => {
  // Truoc day hang doi giu `voiceId`/`engine` rieng, khoi tao tu grant roi de
  // nguoi hoc doi. Khong co cho nao goi `setVoice` ca, nen hai nguon su that do
  // chi tao ra mot duong lech: grant moi (reconnect, het han) am tham keo giong
  // ve mac dinh. Gio chi con MOT nguon.
  const stub = stubFetch(JSON.stringify({ audioContent: Buffer.from('MP3').toString('base64') }));
  const original = globalThis.fetch;
  const payloads: Record<string, never>[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    payloads.push(JSON.parse(String(init.body)) as Record<string, never>);
    return new Response(JSON.stringify({ audioContent: Buffer.from('MP3').toString('base64') }), {
      status: 200,
    });
  }) as typeof globalThis.fetch;
  try {
    await synthesize({ ...GOOGLE, voice: { name: 'en-US-Chirp3-HD-Leda', languageCode: 'en-US' } }, 'Hi.', {});
    assert.equal((payloads[0]?.['voice'] as Record<string, unknown>)['name'], 'en-US-Chirp3-HD-Leda');
  } finally {
    globalThis.fetch = original;
    stub.restore();
  }
});

// ------------------------------------------------------------------ con han

test('grant null thi khong dung duoc', () => {
  assert.equal(grantUsable(null), false);
});

test('grant con nhieu han thi dung duoc — ca hai nha', () => {
  assert.equal(grantUsable(GOOGLE), true);
  assert.equal(grantUsable(POLLY), true);
});

test('grant gan het han bi coi nhu da chet, xin cai moi truoc', () => {
  // Ban mot khuc bang token con 5 giay la mat khuc do. Hoi truoc thi chi mat mot
  // vong xin lai, va vong do bi che sau khuc dang phat.
  assert.equal(grantUsable({ ...GOOGLE, expiresAt: Date.now() + 5_000 }), false);
  assert.equal(grantUsable({ ...POLLY, expiresAt: Date.now() + 5_000 }), false);
});

// ------------------------------------------------------------------ loi nao

test('401 cua Google la het han — xin token moi', () => {
  assert.equal(isAuthError(new GoogleTtsError('nope', 401)), true);
});

test('403 cua Polly la het han — xin credential moi', () => {
  // Hai nha bao het han bang hai status khac nhau, va day la ly do cua ham nay:
  // hang doi khong nen biet cai khac biet do.
  assert.equal(isAuthError(new PollyError('nope', 403)), true);
});

test('403 cua Google KHONG phai het han — xin lai cung the', () => {
  // Google tra 403 PERMISSION_DENIED khi API chua bat hoac SA thieu quyen. Coi no
  // la het han thi moi khuc lai xin mot token moi, token moi lai 403 — mot vong
  // xin token khong loi thoat, va o cap project thi no dot dung cai quota dang
  // duoc dung de chan thiet hai.
  assert.equal(isAuthError(new GoogleTtsError('permission denied', 403)), false);
});

test('cac loi khac khong dang xin lai', () => {
  assert.equal(isAuthError(new GoogleTtsError('bad voice', 400)), false);
  assert.equal(isAuthError(new GoogleTtsError('quota', 429)), false);
  assert.equal(isAuthError(new PollyError('validation', 400)), false);
  assert.equal(isAuthError(new TypeError('Failed to fetch')), false);
  assert.equal(isAuthError('khong phai Error'), false);
});
