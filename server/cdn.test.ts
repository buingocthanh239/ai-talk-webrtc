/**
 *   node --test server/cdn.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';

import {
  canSign,
  cdnConfigFromEnv,
  cdnUrl,
  signedCookies,
  signedUrl,
  type SigningCdnConfig,
} from './cdn.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const cfg: SigningCdnConfig = {
  domain: 'media.example.com',
  keyPairId: 'K123EXAMPLE',
  privateKey,
};

/** Doi nguoc base64 kieu CloudFront ve base64 chuan. */
const unCfBase64 = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64');

test('signedCookies: chu ky verify duoc bang public key, policy dung session', () => {
  const expiresAt = Date.UTC(2026, 7, 15, 4, 0, 0);
  const { cookies, path } = signedCookies(cfg, 'sess-1', expiresAt);

  assert.equal(path, '/audio/sess-1/');
  const byName = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
  assert.equal(byName['CloudFront-Key-Pair-Id'], 'K123EXAMPLE');

  const policyRaw = unCfBase64(byName['CloudFront-Policy'] ?? '').toString('utf8');
  const policy = JSON.parse(policyRaw);
  assert.equal(policy.Statement[0].Resource, 'https://media.example.com/audio/sess-1/*');
  assert.equal(
    policy.Statement[0].Condition.DateLessThan['AWS:EpochTime'],
    Math.floor(expiresAt / 1000)
  );

  const ok = createVerify('RSA-SHA1')
    .update(policyRaw)
    .verify(publicKey, unCfBase64(byName['CloudFront-Signature'] ?? ''));
  assert.equal(ok, true);
});

test('signedCookies cua session nay khong mo duoc session khac', () => {
  const expiresAt = Date.now() + 3600_000;
  const a = signedCookies(cfg, 'sess-a', expiresAt);
  const b = signedCookies(cfg, 'sess-b', expiresAt);
  const sig = (x: typeof a): string =>
    x.cookies.find((c) => c.name === 'CloudFront-Signature')?.value ?? '';
  assert.notEqual(sig(a), sig(b));
});

test('signedUrl gan chu ky vao query, verify duoc', () => {
  const expiresAt = Date.now() + 600_000;
  const url = signedUrl(cfg, 'audio/sess-1/003-user.wav', expiresAt);
  const parsed = new URL(url);

  assert.equal(parsed.origin + parsed.pathname, 'https://media.example.com/audio/sess-1/003-user.wav');
  assert.equal(parsed.searchParams.get('Key-Pair-Id'), 'K123EXAMPLE');

  const policyRaw = unCfBase64(parsed.searchParams.get('Policy') ?? '').toString('utf8');
  assert.equal(
    JSON.parse(policyRaw).Statement[0].Resource,
    'https://media.example.com/audio/sess-1/003-user.wav'
  );
  const ok = createVerify('RSA-SHA1')
    .update(policyRaw)
    .verify(publicKey, unCfBase64(parsed.searchParams.get('Signature') ?? ''));
  assert.equal(ok, true);
});

test('cdnUrl la URL tran, khong kem chu ky', () => {
  assert.equal(
    cdnUrl(cfg, 'audio/sess-1/003-user.wav'),
    'https://media.example.com/audio/sess-1/003-user.wav'
  );
});

// ------------------------------------------------------------ doc cau hinh

test('khong co CDN_DOMAIN = khong dung CDN', () => {
  assert.equal(cdnConfigFromEnv({}), null);
  assert.equal(cdnConfigFromEnv({ CF_KEY_PAIR_ID: 'K1', CF_PRIVATE_KEY: privateKey }), null);
});

test('du ca key pair thi ky duoc', () => {
  const c = cdnConfigFromEnv({
    CDN_DOMAIN: 'media.example.com',
    CF_KEY_PAIR_ID: 'K123EXAMPLE',
    CF_PRIVATE_KEY: privateKey,
  });
  assert.ok(c && canSign(c));
  assert.equal(c.domain, 'media.example.com');
});

test('CDN_DOMAIN dan ca URL vao thi cat lay host', () => {
  // Dan thang tu console CloudFront la thao tac tu nhien nhat; khong cat thi
  // URL ra `https://https://d111.cloudfront.net/...`.
  for (const raw of [
    'https://d111.cloudfront.net',
    'http://d111.cloudfront.net/',
    ' d111.cloudfront.net ',
    'd111.cloudfront.net',
  ]) {
    assert.equal(cdnConfigFromEnv({ CDN_DOMAIN: raw })?.domain, 'd111.cloudfront.net', raw);
  }
});

test('chi CDN_DOMAIN = distribution public, khong ky', () => {
  const c = cdnConfigFromEnv({ CDN_DOMAIN: 'media.example.com' });
  assert.ok(c);
  assert.equal(canSign(c), false);
  assert.equal(c.keyPairId, undefined);
  assert.equal(c.privateKey, undefined);
});

test('mot nua key pair thi nga ra, khong am tham tut ve URL tran', () => {
  // Go nham ten bien hoac secret chua mount kip deu roi vao day. Tut ve URL
  // tran thi trieu chung se la 403 o trinh duyet nguoi hoc, cach xa nguyen nhan.
  assert.throws(
    () => cdnConfigFromEnv({ CDN_DOMAIN: 'media.example.com', CF_KEY_PAIR_ID: 'K1' }),
    /mot nua key pair/
  );
  assert.throws(
    () => cdnConfigFromEnv({ CDN_DOMAIN: 'media.example.com', CF_PRIVATE_KEY: privateKey }),
    /mot nua key pair/
  );
});

test('CF_PRIVATE_KEY duoc uu tien hon CF_PRIVATE_KEY_PATH', () => {
  // Path tro vao file khong ton tai: doc toi la throw. Khong throw nghia la
  // CF_PRIVATE_KEY da thang truoc khi ai do dung toi path.
  const c = cdnConfigFromEnv({
    CDN_DOMAIN: 'media.example.com',
    CF_KEY_PAIR_ID: 'K1',
    CF_PRIVATE_KEY: privateKey,
    CF_PRIVATE_KEY_PATH: '/khong/co/that.pem',
  });
  assert.equal(c?.privateKey, privateKey);
});

test('CF_PRIVATE_KEY_PATH hong thi bao ro la hong o day', () => {
  assert.throws(
    () =>
      cdnConfigFromEnv({
        CDN_DOMAIN: 'media.example.com',
        CF_KEY_PAIR_ID: 'K1',
        CF_PRIVATE_KEY_PATH: '/khong/co/that.pem',
      }),
    /CF_PRIVATE_KEY_PATH=\/khong\/co\/that\.pem/
  );
});
