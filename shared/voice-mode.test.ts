/**
 *   node --test shared/voice-mode.test.ts
 *
 * Cau hoi cua bo test nay: mot gia tri LA khong bao gio duoc phep bien thanh
 * mot mode. Chuoi mode di qua ba cua khong tin duoc — body cua POST, cot cu
 * trong SQLite, localStorage cua browser — va ca ba deu roi ve day.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aiSpeaksItself,
  normalizeVoiceMode,
  VOICE_MODES,
  VOICE_MODE_DEFAULT,
} from './voice-mode.ts';

test('nhan dung hai mode hop le', () => {
  assert.equal(normalizeVoiceMode('openai'), 'openai');
  assert.equal(normalizeVoiceMode('polly'), 'polly');
});

test('mac dinh la polly — duong re hon, va la duong cua moi buoi hoc cu', () => {
  assert.equal(VOICE_MODE_DEFAULT, 'polly');
  // Buoi hoc tao truoc khi co cot voice_mode doc ra chuoi rong.
  assert.equal(normalizeVoiceMode(''), 'polly');
  assert.equal(normalizeVoiceMode(null), 'polly');
  assert.equal(normalizeVoiceMode(undefined), 'polly');
});

test('gia tri rac roi ve mac dinh chu khong nem loi', () => {
  for (const rac of ['OPENAI', 'gpt', 42, {}, [], true]) {
    assert.equal(normalizeVoiceMode(rac), 'polly');
  }
});

test('fallback de len duoc — buoi dang chay lay mode cua chinh no lam mac dinh', () => {
  assert.equal(normalizeVoiceMode('rac', 'openai'), 'openai');
  assert.equal(normalizeVoiceMode('polly', 'openai'), 'polly');
});

test('VOICE_MODES liet ke dung nhung gia tri ma normalize chap nhan', () => {
  assert.deepEqual([...VOICE_MODES], ['openai', 'polly']);
  for (const mode of VOICE_MODES) assert.equal(normalizeVoiceMode(mode), mode);
});

test('chi mode openai la AI tu phat tieng', () => {
  assert.equal(aiSpeaksItself('openai'), true);
  assert.equal(aiSpeaksItself('polly'), false);
});
