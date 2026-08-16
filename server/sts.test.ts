/**
 *   node --test server/sts.test.ts
 *
 * Trong tam: RE NHANH giua hai duong cap credential. Duong THANG dua chinh
 * credential cua backend xuong browser, nen "khi nao no duoc chon" phai la thu
 * co test giu, khong phai thu suy ra tu doc code.
 *
 * Khong test duoc o day: AWS co CHAP NHAN chu ky hay khong. Can credential that.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bindableIp, pollyCredsFromEnv, pollyGrant, usesSts } from './sts.ts';
import type { PollyConfig } from './polly.ts';

const polly: PollyConfig = { region: 'ap-southeast-1', voiceId: 'Joanna', engine: 'neural' };

const KEYS = { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret' };
const ROLE = 'arn:aws:iam::123456789012:role/ai-learn-polly-client';

// ------------------------------------------------------------- doc cau hinh

test('khong credential, khong role = tat han', () => {
  assert.equal(pollyCredsFromEnv(polly, {}), null);
});

test('co role nhung thieu credential de dong vai = loi cau hinh, khong phai tat', () => {
  assert.throws(
    () => pollyCredsFromEnv(polly, { POLLY_STS_ROLE_ARN: ROLE }),
    /POLLY_STS_ROLE_ARN da dat nhung thieu/
  );
});

test('co credential va co role = duong STS', () => {
  const cfg = pollyCredsFromEnv(polly, { ...KEYS, POLLY_STS_ROLE_ARN: ROLE });
  assert.ok(cfg && usesSts(cfg));
  assert.equal(cfg.roleArn, ROLE);
});

test('co credential, khong role = duong THANG', () => {
  const cfg = pollyCredsFromEnv(polly, KEYS);
  assert.ok(cfg);
  assert.equal(usesSts(cfg), false);
  assert.equal(cfg.roleArn, undefined);
});

test('region lay tu PollyConfig, khong doc lai env', () => {
  // polly.ts da chot region roi; doc lai POLLY_REGION o day thi hai cho co the
  // le nhau.
  const cfg = pollyCredsFromEnv(polly, { ...KEYS, POLLY_REGION: 'us-east-1' });
  assert.equal(cfg?.region, 'ap-southeast-1');
});

test('POLLY_STS_TTL_SEC bi kep vao 900..3600', () => {
  const ttl = (v: string): number | undefined =>
    pollyCredsFromEnv(polly, { ...KEYS, POLLY_STS_TTL_SEC: v })?.ttlSec;
  assert.equal(ttl('60'), 900);
  assert.equal(ttl('99999'), 3600);
  assert.equal(ttl('1800'), 1800);
  assert.equal(ttl('rac'), 3600);
});

test('POLLY_STS_BIND_IP mac dinh la on', () => {
  assert.equal(pollyCredsFromEnv(polly, KEYS)?.bindIp, true);
  assert.equal(pollyCredsFromEnv(polly, { ...KEYS, POLLY_STS_BIND_IP: 'off' })?.bindIp, false);
});

// ----------------------------------------------------------- duong THANG

test('duong THANG dua dung credential cua backend xuong, khong sinh gi moi', async () => {
  const cfg = pollyCredsFromEnv(polly, KEYS);
  assert.ok(cfg);

  const at = Date.UTC(2026, 7, 16, 3, 0, 0);
  const grant = await pollyGrant(polly, cfg, { sessionName: 'dev-1', sourceIp: null }, at);

  assert.equal(grant.accessKeyId, KEYS.AWS_ACCESS_KEY_ID);
  assert.equal(grant.secretAccessKey, KEYS.AWS_SECRET_ACCESS_KEY);
  assert.equal(grant.region, 'ap-southeast-1');
  assert.equal(grant.voiceId, 'Joanna');
  assert.equal(grant.engine, 'neural');
});

test('duong THANG khong co sessionToken — phai VANG MAT chu khong phai chuoi rong', async () => {
  // Client dua vao chinh cho nay de quyet dinh co dua x-amz-security-token vao
  // SignedHeaders hay khong. Mot chuoi rong se lot qua kiem tra do va sinh ra
  // 403 khong noi ly do.
  const cfg = pollyCredsFromEnv(polly, KEYS);
  assert.ok(cfg);
  const grant = await pollyGrant(polly, cfg, { sessionName: 'dev-1', sourceIp: null });
  assert.equal('sessionToken' in grant, false);
});

test('duong THANG van chuyen tiep AWS_SESSION_TOKEN khi chay bang IAM role', async () => {
  const cfg = pollyCredsFromEnv(polly, { ...KEYS, AWS_SESSION_TOKEN: 'tok-123' });
  assert.ok(cfg);
  const grant = await pollyGrant(polly, cfg, { sessionName: 'dev-1', sourceIp: null });
  assert.equal(grant.sessionToken, 'tok-123');
});

test('han cua duong THANG la han bia, tinh tu ttlSec', async () => {
  const cfg = pollyCredsFromEnv(polly, { ...KEYS, POLLY_STS_TTL_SEC: '1800' });
  assert.ok(cfg);
  const at = Date.UTC(2026, 7, 16, 3, 0, 0);
  const grant = await pollyGrant(polly, cfg, { sessionName: 'dev-1', sourceIp: null }, at);
  assert.equal(grant.expiresAt, at + 1800_000);
});

test('giong cua nhan vat de len mac dinh trong env', async () => {
  const cfg = pollyCredsFromEnv(polly, KEYS);
  assert.ok(cfg);
  const grant = await pollyGrant(
    { ...polly, voiceId: 'Matthew' },
    cfg,
    { sessionName: 'dev-1', sourceIp: null }
  );
  assert.equal(grant.voiceId, 'Matthew');
});

// ------------------------------------------------------------------- IP

test('bindableIp bo qua loopback va dai private', () => {
  for (const ip of ['127.0.0.1', '::1', '10.0.0.4', '192.168.1.7', '172.16.0.1', 'fd00::1']) {
    assert.equal(bindableIp(ip), null, ip);
  }
  assert.equal(bindableIp(null), null);
});

test('bindableIp tra ve CIDR cho IP that', () => {
  assert.equal(bindableIp('203.0.113.5'), '203.0.113.5/32');
  assert.equal(bindableIp('::ffff:203.0.113.5'), '203.0.113.5/32');
  assert.equal(bindableIp('2001:db8::1'), '2001:db8::1/128');
});
