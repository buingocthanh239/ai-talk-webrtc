import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pollyConfigFromEnv } from './polly.ts';

test('pollyConfigFromEnv tra null khi chua bat', () => {
  assert.equal(pollyConfigFromEnv({}), null);
  assert.equal(pollyConfigFromEnv({ POLLY: 'off' }), null);
});

test('pollyConfigFromEnv tu choi engine generative', () => {
  assert.throws(
    () => pollyConfigFromEnv({ POLLY: 'on', S3_REGION: 'us-east-1', POLLY_ENGINE: 'generative' }),
    /generative/
  );
});

test('pollyConfigFromEnv nga ra khi khong biet region nao', () => {
  assert.throws(() => pollyConfigFromEnv({ POLLY: 'on' }), /POLLY_REGION/);
});

test('pollyConfigFromEnv lay region tu S3_REGION khi khong khai rieng', () => {
  const got = pollyConfigFromEnv({ POLLY: 'on', S3_REGION: 'us-east-1' });
  assert.equal(got?.region, 'us-east-1');
  assert.equal(got?.voiceId, 'Joanna');
  assert.equal(got?.engine, 'neural');
});

test('POLLY_REGION de len S3_REGION', () => {
  const got = pollyConfigFromEnv({
    POLLY: 'on',
    S3_REGION: 'us-east-1',
    POLLY_REGION: 'ap-southeast-1',
  });
  assert.equal(got?.region, 'ap-southeast-1');
});
