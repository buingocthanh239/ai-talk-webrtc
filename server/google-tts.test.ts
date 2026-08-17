/**
 *   node --test server/google-tts.test.ts
 *
 * Cau hinh Google TTS doc tu env. Cau hoi o day giong `polly.test.ts`: chua bat
 * thi im lang tra null, con bat ma khai sai thi phai nga ra NGAY luc khoi dong.
 *
 * Ly do doi voi Google gap hon Polly mot bac: request tong hop do CLIENT ban, va
 * moi khuc mot request. Mot ten giong sai khong lam server hong — no lam moi
 * khuc cua moi buoi hoc tra 400 trong browser cua nguoi hoc, va cho duy nhat
 * thay duoc la console cua may ho.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { googleTtsConfigFromEnv } from './google-tts.ts';

test('googleTtsConfigFromEnv tra null khi chua bat', () => {
  assert.equal(googleTtsConfigFromEnv({}), null);
  assert.equal(googleTtsConfigFromEnv({ GOOGLE_TTS: 'off' }), null);
});

test('bat len ma khong khai gi thi co giong mac dinh dung duoc', () => {
  const got = googleTtsConfigFromEnv({ GOOGLE_TTS: 'on' });
  assert.ok(got);
  assert.match(got.voice.name, /^en-US-/);
  assert.equal(got.voice.languageCode, 'en-US');
});

test('GOOGLE_TTS_VOICE de len giong mac dinh', () => {
  const got = googleTtsConfigFromEnv({
    GOOGLE_TTS: 'on',
    GOOGLE_TTS_VOICE: 'en-US-Chirp3-HD-Leda',
  });
  assert.equal(got?.voice.name, 'en-US-Chirp3-HD-Leda');
});

test('languageCode suy ra tu ten giong, khong phai khai rieng', () => {
  // Google doi CA HAI truong trong moi request, va neu chung khong khop thi tra
  // 400. Bat nguoi cau hinh khai hai thu bat buoc phai khop nhau la dat mot cai
  // bay — suy ra duoc thi suy ra.
  const got = googleTtsConfigFromEnv({
    GOOGLE_TTS: 'on',
    GOOGLE_TTS_VOICE: 'vi-VN-Chirp3-HD-Achird',
  });
  assert.equal(got?.voice.languageCode, 'vi-VN');
});

test('GOOGLE_TTS_LANGUAGE de len duoc phan suy ra', () => {
  // Cua thoat cho giong nao khong theo quy tac dat ten `xx-YY-...`.
  const got = googleTtsConfigFromEnv({
    GOOGLE_TTS: 'on',
    GOOGLE_TTS_VOICE: 'en-US-Chirp3-HD-Achird',
    GOOGLE_TTS_LANGUAGE: 'en-GB',
  });
  assert.equal(got?.voice.languageCode, 'en-GB');
});

test('ten giong khong suy ra duoc ngon ngu thi nga ra luc khoi dong', () => {
  // Khong nga o day thi cho bao loi ke tiep la browser cua nguoi hoc, sau khi
  // buoi hoc da bat dau.
  assert.throws(
    () => googleTtsConfigFromEnv({ GOOGLE_TTS: 'on', GOOGLE_TTS_VOICE: 'Joanna' }),
    /GOOGLE_TTS_LANGUAGE|Joanna/
  );
});

test('ten giong rong bi coi la khai sai chu khong am tham lay mac dinh', () => {
  assert.throws(
    () => googleTtsConfigFromEnv({ GOOGLE_TTS: 'on', GOOGLE_TTS_VOICE: '   ' }),
    /GOOGLE_TTS_VOICE/
  );
});
