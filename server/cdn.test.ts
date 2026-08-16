/**
 *   node --test server/cdn.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';

import { cdnUrl, signedCookies, signedUrl, type CdnConfig } from './cdn.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const cfg: CdnConfig = { domain: 'media.example.com', keyPairId: 'K123EXAMPLE', privateKey };

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
