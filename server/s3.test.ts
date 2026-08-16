/**
 * Doi chieu voi test vector chinh thuc cua AWS.
 *
 * Chu ky sai thi S3 chi tra ve "SignatureDoesNotMatch" — khong noi sai o dau,
 * va loi chi lo ra luc chay that. Nen phan nay phai co test vector, khong the
 * kiem tra bang mat.
 *
 *   node --test server/s3.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalPath, presignGet, presignPost, signingKey, type S3Config } from './s3.ts';

// AWS docs — "Examples of how to derive a signing key for Signature Version 4"
test('signingKey khop test vector cua AWS', () => {
  const key = signingKey(
    'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    '20120215',
    'us-east-1',
    'iam'
  );
  assert.equal(
    key.toString('hex'),
    'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d'
  );
});

// AWS docs — "Authenticating Requests: Using Query Parameters (AWS Signature
// Version 4)", vi du GET presigned cho examplebucket/test.txt.
test('presignGet khop test vector cua AWS', () => {
  const cfg: S3Config = {
    region: 'us-east-1',
    bucket: 'examplebucket',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };

  const at = Date.UTC(2013, 4, 24, 0, 0, 0);
  const url = presignGet(cfg, 'test.txt', 86400, at, 'examplebucket.s3.amazonaws.com');
  const signature = new URL(url).searchParams.get('X-Amz-Signature');

  assert.equal(signature, 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});

test('presignGet ma hoa key theo RFC 3986, khong dong dau / cua duong dan', () => {
  const cfg: S3Config = {
    region: 'ap-southeast-1',
    bucket: 'b',
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
  };
  const url = presignGet(cfg, 'audio/sess-1/003-user.wav', 300, 0);
  assert.ok(url.startsWith('https://b.s3.ap-southeast-1.amazonaws.com/audio/sess-1/003-user.wav?'));
  assert.match(url, /X-Amz-Expires=300/);
});

test('presignGet dung path-style khi co S3_ENDPOINT (MinIO)', () => {
  const cfg: S3Config = {
    region: 'us-east-1',
    bucket: 'audio',
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
    endpoint: 'http://localhost:9000',
  };
  const url = presignGet(cfg, 'audio/s/001-user.wav', 300, 0);
  assert.ok(url.startsWith('http://localhost:9000/audio/audio/s/001-user.wav?'));
});

/**
 * Regression: truoc day path-style noi thieu dau `/` nen ky nham
 * `/audioaudio/s/...`. URL tra ve van dung, chi co chu ky la sai — nen unit
 * test cu (chi kiem tra tien to URL) van xanh, va S3 thi tra 403 khong noi ly
 * do. Ghim thang duong dan duoc ky o day.
 */
test('canonicalPath giu dung dau / giua bucket va key', () => {
  const base = { region: 'us-east-1', accessKeyId: 'AKID', secretAccessKey: 'secret' };

  assert.equal(
    canonicalPath({ ...base, bucket: 'audio', endpoint: 'http://localhost:9000' }, 'audio/s/1.wav'),
    '/audio/audio/s/1.wav'
  );
  assert.equal(
    canonicalPath({ ...base, bucket: 'audio' }, 'audio/s/1.wav'),
    '/audio/s/1.wav'
  );
  // Duong dan da co dau / o dau khong duoc thanh `//`
  assert.equal(canonicalPath({ ...base, bucket: 'b' }, '/a.wav'), '/a.wav');
});

test('presignPost rang buoc prefix key va kich thuoc file', () => {
  const cfg: S3Config = {
    region: 'ap-southeast-1',
    bucket: 'ai-learn-audio',
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
  };

  const at = Date.UTC(2026, 7, 15, 3, 0, 0);
  const grant = presignPost(
    cfg,
    {
      keyPrefix: 'audio/sess-1/',
      contentType: 'audio/wav',
      minBytes: 45,
      maxBytes: 5_000_000,
      expiresIn: 7200,
    },
    at
  );

  assert.equal(grant.url, 'https://ai-learn-audio.s3.ap-southeast-1.amazonaws.com');
  assert.equal(grant.expiresAt, at + 7200_000);
  assert.match(grant.fields['x-amz-signature'] ?? '', /^[0-9a-f]{64}$/);
  assert.equal(grant.fields['x-amz-date'], '20260815T030000Z');
  assert.equal(
    grant.fields['x-amz-credential'],
    'AKID/20260815/ap-southeast-1/s3/aws4_request'
  );

  const policy = JSON.parse(
    Buffer.from(grant.fields['policy'] ?? '', 'base64').toString('utf8')
  );
  assert.equal(policy.expiration, new Date(at + 7200_000).toISOString());
  assert.deepEqual(policy.conditions[1], ['starts-with', '$key', 'audio/sess-1/']);
  assert.deepEqual(policy.conditions[3], ['content-length-range', 45, 5_000_000]);
  assert.deepEqual(policy.conditions[0], { bucket: 'ai-learn-audio' });
});

test('presignPost ky chinh chuoi policy da base64', () => {
  const cfg: S3Config = {
    region: 'us-east-1',
    bucket: 'b',
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
  };
  const a = presignPost(
    cfg,
    { keyPrefix: 'audio/x/', contentType: 'audio/wav', minBytes: 1, maxBytes: 2, expiresIn: 60 },
    0
  );
  const b = presignPost(
    cfg,
    { keyPrefix: 'audio/y/', contentType: 'audio/wav', minBytes: 1, maxBytes: 2, expiresIn: 60 },
    0
  );
  // Doi prefix la doi policy la doi chu ky — neu khong thi rang buoc prefix
  // chi la trang tri, client sua key nao cung ghi duoc.
  assert.notEqual(a.fields['x-amz-signature'], b.fields['x-amz-signature']);
});
