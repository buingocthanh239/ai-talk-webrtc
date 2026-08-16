import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  POLLY_TO_VISEME,
  SCHWA_WEIGHT,
  VISEMES,
  VISEME_HINT_VI,
  frameAt,
  frameFromPolly,
  morphName,
  parseSpeechMarks,
  type VisemeFrame,
} from './viseme.ts';

test('moi viseme deu co ten morph target va goi y tieng Viet', () => {
  for (const v of VISEMES) {
    assert.equal(morphName(v), `viseme_${v}`);
    assert.ok(VISEME_HINT_VI[v], `thieu goi y cho ${v}`);
  }
});

test('bang map phu het bo viseme en-US cua Polly', () => {
  // Doi chieu voi bang phoneme/viseme en-US trong tai lieu Polly. Thieu mot
  // gia tri o day nghia la co am bi bo qua im lang giua cau.
  const pollyValues = 'sil p t S T f k l r s i u @ a e E o O'.split(' ');
  for (const value of pollyValues) {
    assert.ok(POLLY_TO_VISEME[value], `chua map gia tri Polly "${value}"`);
  }
  assert.equal(Object.keys(POLLY_TO_VISEME).length, pollyValues.length);
});

test('map dung cac cho gop co y', () => {
  // Rig Oculus khong tach /eɪ/ voi /ɛ/, cung khong tach /oʊ/ voi /ɔ/.
  assert.equal(POLLY_TO_VISEME['e'], POLLY_TO_VISEME['E']);
  assert.equal(POLLY_TO_VISEME['o'], POLLY_TO_VISEME['O']);
  // l phai ra nn (luoi cham loi), khong duoc lan sang DD.
  assert.equal(POLLY_TO_VISEME['l'], 'nn');
  assert.equal(POLLY_TO_VISEME['t'], 'DD');
});

test('frameFromPolly ha trong so cho schwa', () => {
  assert.deepEqual(frameFromPolly(120, '@'), { tMs: 120, viseme: 'E', weight: SCHWA_WEIGHT });
  assert.deepEqual(frameFromPolly(120, 'E'), { tMs: 120, viseme: 'E', weight: 1 });
});

test('frameFromPolly bo qua gia tri la thay vi nem', () => {
  assert.equal(frameFromPolly(0, 'khong-ton-tai'), null);
});

const frames: VisemeFrame[] = [
  { tMs: 0, viseme: 'sil', weight: 1 },
  { tMs: 100, viseme: 'PP', weight: 1 },
  { tMs: 250, viseme: 'aa', weight: 1 },
];

test('frameAt tra ve khau hinh dang giu va moc het han', () => {
  assert.deepEqual(frameAt(frames, 0), { index: 0, frame: frames[0], endMs: 100 });
  assert.deepEqual(frameAt(frames, 99), { index: 0, frame: frames[0], endMs: 100 });
  assert.deepEqual(frameAt(frames, 100), { index: 1, frame: frames[1], endMs: 250 });
  // Frame cuoi khong co moc het han: giu cho toi khi het audio.
  assert.deepEqual(frameAt(frames, 9999), { index: 2, frame: frames[2], endMs: null });
});

test('frameAt tra null truoc frame dau va tren timeline rong', () => {
  assert.equal(frameAt(frames, -1), null);
  assert.equal(frameAt([], 500), null);
});

// ------------------------------------------------------------ speech marks
//
// Truoc day cac test nay nam o server/polly.test.ts. Chuyen sang day cung luc
// `parseSpeechMarks` chuyen ve shared: gio ca hai phia deu goi Polly nen luat
// doc phai la MOT, hai ban parse la hai bo loi khac nhau.

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
  const raw =
    '{"time":0,"type":"viseme","value":"sil"}\n{khong phai json\n\n{"time":5,"type":"viseme","value":"t"}';
  assert.deepEqual(parseSpeechMarks(raw), [
    { tMs: 0, viseme: 'sil', weight: 1 },
    { tMs: 5, viseme: 'DD', weight: 1 },
  ]);
});
