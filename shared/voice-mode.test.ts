/**
 *   node --test shared/voice-mode.test.ts
 *
 * Cau hoi cua bo test nay: mot gia tri LA khong bao gio duoc phep bien thanh
 * mot mode. Chuoi mode di qua ba cua khong tin duoc — body cua POST, cot cu
 * trong SQLite, localStorage cua browser — va ca ba deu roi ve day.
 *
 * Tu luc co mode thu ba (`google`) thi co them mot cau hoi nua, va no la cho de
 * hong nhat: "AI tu phat tieng khong" va "client goi nha nao" la HAI cau hoi
 * khac nhau. Truoc day mot phep so sanh tra loi duoc ca hai vi chi co hai mode.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aiSpeaksItself,
  clientTtsProvider,
  effectiveVoiceMode,
  normalizeVoiceMode,
  VOICE_MODES,
  VOICE_MODE_DEFAULT,
} from './voice-mode.ts';

const BOTH = { polly: true, google: true };
const NEITHER = { polly: false, google: false };

test('nhan dung ba mode hop le', () => {
  assert.equal(normalizeVoiceMode('openai'), 'openai');
  assert.equal(normalizeVoiceMode('polly'), 'polly');
  assert.equal(normalizeVoiceMode('google'), 'google');
});

test('mac dinh la google — duong dang dung, Polly chi con de lui ve', () => {
  assert.equal(VOICE_MODE_DEFAULT, 'google');
  // Buoi hoc tao truoc khi co cot voice_mode doc ra chuoi rong. Chung roi ve
  // mac dinh MOI chu khong phai hanh vi cu: mot buoi da ket thuc thi cho duy
  // nhat con dung mode la nut "doc lai" o man tong ket, va nuoi mot duong Polly
  // song chi de phuc vu no thi khong dang.
  assert.equal(normalizeVoiceMode(''), 'google');
  assert.equal(normalizeVoiceMode(null), 'google');
  assert.equal(normalizeVoiceMode(undefined), 'google');
});

test('gia tri rac roi ve mac dinh chu khong nem loi', () => {
  for (const rac of ['OPENAI', 'gpt', 'GOOGLE', 42, {}, [], true]) {
    assert.equal(normalizeVoiceMode(rac), 'google');
  }
});

test('fallback de len duoc — buoi dang chay lay mode cua chinh no lam mac dinh', () => {
  assert.equal(normalizeVoiceMode('rac', 'openai'), 'openai');
  assert.equal(normalizeVoiceMode('polly', 'openai'), 'polly');
  // Buoi hoc dang chay bang Polly khong duoc bi mot lan reconnect am tham keo
  // sang Google: doi nha giua buoi la doi giong giua buoi.
  assert.equal(normalizeVoiceMode('rac', 'polly'), 'polly');
});

test('VOICE_MODES liet ke dung nhung gia tri ma normalize chap nhan', () => {
  assert.deepEqual([...VOICE_MODES], ['openai', 'polly', 'google']);
  for (const mode of VOICE_MODES) assert.equal(normalizeVoiceMode(mode), mode);
});

test('chi mode openai la AI tu phat tieng', () => {
  // Cho nay tung viet la `mode !== 'polly'`, va voi hai mode thi dung. Them
  // `google` vao la no lat nguoc y nghia: mode google se bi coi la AI tu noi,
  // Realtime duoc bat audio out, va nguoi hoc nghe HAI giong chong len nhau —
  // giong cua model lan giong cua Google doc cung mot cau.
  assert.equal(aiSpeaksItself('openai'), true);
  assert.equal(aiSpeaksItself('polly'), false);
  assert.equal(aiSpeaksItself('google'), false);
});

test('clientTtsProvider noi ro client phai goi nha nao', () => {
  assert.equal(clientTtsProvider('polly'), 'polly');
  assert.equal(clientTtsProvider('google'), 'google');
  // null chu khong phai mot chuoi nao: o mode openai client khong goi nha TTS
  // nao ca, va bat cu ai doc gia tri nay cung phai xu ly truong hop do.
  assert.equal(clientTtsProvider('openai'), null);
});

test('moi mode khong tu phat tieng deu phai co mot nha TTS', () => {
  // Rang buoc bat cau: them mode thu tu ma quen day vao clientTtsProvider thi
  // no se im lang khong co tieng, chu khong bao loi o dau.
  for (const mode of VOICE_MODES) {
    if (aiSpeaksItself(mode)) continue;
    assert.ok(clientTtsProvider(mode), `mode ${mode} khong co nha TTS nao`);
  }
});

// ------------------------------------------------- mode xin duoc vs mode chay duoc

test('nha da cau hinh thi lay dung mode duoc xin', () => {
  assert.equal(effectiveVoiceMode('google', BOTH), 'google');
  assert.equal(effectiveVoiceMode('polly', BOTH), 'polly');
  assert.equal(effectiveVoiceMode('openai', BOTH), 'openai');
});

test('mac dinh la google ma Google chua bat thi lui ve Polly, khong im lang', () => {
  // Day la cai bay ma viec doi mac dinh sang google mo ra: chi can quen
  // GOOGLE_TTS=on la MOI buoi hoc moi co chu ma khong co tieng, va khong cho nao
  // bao loi vi grant null la mot trang thai hop le ("chua cau hinh").
  assert.equal(effectiveVoiceMode('google', { polly: true, google: false }), 'polly');
});

test('Polly duoc xin ma chua bat thi lui sang Google', () => {
  assert.equal(effectiveVoiceMode('polly', { polly: false, google: true }), 'google');
});

test('khong nha nao bat thi de AI tu noi — con tieng la con buoi hoc', () => {
  // `openai` luon chay duoc: khong co no thi khong co ca buoi hoc, nen no khong
  // phai la thu can kiem tra. Dat hon nhung co tieng, va do la danh doi dung khi
  // lua chon con lai la im lang.
  assert.equal(effectiveVoiceMode('google', NEITHER), 'openai');
  assert.equal(effectiveVoiceMode('polly', NEITHER), 'openai');
});

test('mode openai khong bi hai nha TTS anh huong gi', () => {
  assert.equal(effectiveVoiceMode('openai', NEITHER), 'openai');
});
