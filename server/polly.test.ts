import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drillId, parseSpeechMarks, pollyConfigFromEnv, signedHeaders } from './polly.ts';
import { drillTargets } from './drill.ts';
import type { Lesson } from '../shared/types.ts';

const cfg = {
  region: 'ap-southeast-1',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  voiceId: 'Joanna',
  engine: 'neural' as const,
};

// ------------------------------------------------------------ speech marks

test('parseSpeechMarks doc JSON phan cach bang dong', () => {
  const raw = [
    '{"time":0,"type":"viseme","value":"sil"}',
    '{"time":6,"type":"viseme","value":"m"}', // "m" khong phai viseme cua Polly
    '{"time":126,"type":"viseme","value":"p"}',
    '{"time":200,"type":"viseme","value":"@"}',
  ].join('\n');

  assert.deepEqual(parseSpeechMarks(raw), [
    { tMs: 0, viseme: 'sil', weight: 1 },
    { tMs: 126, viseme: 'PP', weight: 1 },
    { tMs: 200, viseme: 'E', weight: 0.55 },
  ]);
});

test('parseSpeechMarks loai mark khong phai viseme', () => {
  const raw = [
    '{"time":0,"type":"sentence","start":0,"end":5,"value":"Hello"}',
    '{"time":373,"type":"word","start":5,"end":8,"value":"had"}',
    '{"time":10,"type":"viseme","value":"a"}',
  ].join('\n');

  assert.deepEqual(parseSpeechMarks(raw), [{ tMs: 10, viseme: 'aa', weight: 1 }]);
});

test('parseSpeechMarks bo qua dong hong thay vi mat ca cau', () => {
  const raw = '{"time":0,"type":"viseme","value":"sil"}\n{khong phai json\n\n{"time":5,"type":"viseme","value":"t"}';
  assert.deepEqual(parseSpeechMarks(raw), [
    { tMs: 0, viseme: 'sil', weight: 1 },
    { tMs: 5, viseme: 'DD', weight: 1 },
  ]);
});

// ------------------------------------------------------------------- ky

test('signedHeaders sinh Authorization dung dinh dang SigV4', () => {
  const headers = signedHeaders(cfg, '/v1/speech', '{"Text":"hi"}', Date.UTC(2026, 7, 16));

  assert.equal(headers['X-Amz-Date'], '20260816T000000Z');
  assert.match(
    headers['Authorization']!,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260816\/ap-southeast-1\/polly\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/
  );
});

test('signedHeaders on dinh, va doi khi body doi', () => {
  const at = Date.UTC(2026, 7, 16);
  const a = signedHeaders(cfg, '/v1/speech', '{"Text":"hi"}', at);
  const b = signedHeaders(cfg, '/v1/speech', '{"Text":"hi"}', at);
  const c = signedHeaders(cfg, '/v1/speech', '{"Text":"ho"}', at);

  assert.equal(a['Authorization'], b['Authorization']);
  assert.notEqual(a['Authorization'], c['Authorization']);
});

test('signedHeaders dua session token vao phan da ky', () => {
  const headers = signedHeaders(
    { ...cfg, sessionToken: 'tok' },
    '/v1/speech',
    '{}',
    Date.UTC(2026, 7, 16)
  );
  assert.equal(headers['X-Amz-Security-Token'], 'tok');
  assert.match(headers['Authorization']!, /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token/);
});

// ---------------------------------------------------------------- cau hinh

test('pollyConfigFromEnv tra null khi chua bat', () => {
  assert.equal(pollyConfigFromEnv({}), null);
  assert.equal(pollyConfigFromEnv({ POLLY: 'off' }), null);
});

test('pollyConfigFromEnv tu choi engine generative', () => {
  assert.throws(
    () =>
      pollyConfigFromEnv({
        POLLY: 'on',
        POLLY_ENGINE: 'generative',
        S3_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'a',
        AWS_SECRET_ACCESS_KEY: 'b',
      }),
    /generative/
  );
});

test('pollyConfigFromEnv nga ra khi thieu credential', () => {
  assert.throws(() => pollyConfigFromEnv({ POLLY: 'on', S3_REGION: 'us-east-1' }), /thieu/);
});

test('pollyConfigFromEnv lay region tu S3_REGION khi khong khai rieng', () => {
  const got = pollyConfigFromEnv({
    POLLY: 'on',
    S3_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'a',
    AWS_SECRET_ACCESS_KEY: 'b',
  });
  assert.equal(got?.region, 'us-east-1');
  assert.equal(got?.engine, 'neural');
  assert.equal(got?.voiceId, 'Joanna');
});

// ------------------------------------------------------------------ drill

test('drillId doi khi doi giong hoac engine', () => {
  const text = 'a latte please';
  assert.equal(drillId(cfg, text), drillId(cfg, text));
  assert.notEqual(drillId(cfg, text), drillId({ ...cfg, voiceId: 'Matthew' }, text));
  assert.notEqual(drillId(cfg, text), drillId({ ...cfg, engine: 'standard' }, text));
});

test('drillTargets gom tu vung va vi du, bo trung', () => {
  const lesson = {
    id: 'x',
    vocabulary: [{ term: 'latte', meaning: '' }, { term: '  ', meaning: '' }],
    objectives: [
      { id: 'o1', text: '', required: true, examples: ['Can I get a latte?', 'LATTE'] },
      { id: 'o2', text: '', required: false, examples: [] },
    ],
  } as unknown as Lesson;

  assert.deepEqual(drillTargets(lesson), [
    { text: 'latte', source: 'vocabulary' },
    { text: 'Can I get a latte?', source: 'example' },
  ]);
});
