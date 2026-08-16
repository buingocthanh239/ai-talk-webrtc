import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  POLLY_TO_VISEME,
  SCHWA_WEIGHT,
  UNREACHABLE_BY_POLLY,
  VISEME_HINT_VI,
  VISEME_IDS,
  frameAt,
  frameFromPolly,
  parseSpeechMarks,
  visemeAnimation,
  type VisemeFrame,
} from './viseme.ts';

test('rig co dung 22 khau hinh, moi cai co ten animation va goi y tieng Viet', () => {
  assert.equal(VISEME_IDS.length, 22);
  for (const id of VISEME_IDS) {
    assert.equal(visemeAnimation(id), `viseme_${id}`);
    assert.ok(VISEME_HINT_VI[id], `thieu goi y cho ${id}`);
  }
});

test('bang map phu het bo viseme en-US cua Polly', () => {
  // Doi chieu voi bang phoneme/viseme en-US trong tai lieu Polly. Thieu mot
  // gia tri o day nghia la co am bi bo qua im lang giua cau.
  const pollyValues = 'sil p t S T f k l r s i u @ a e E o O'.split(' ');
  for (const value of pollyValues) {
    assert.notEqual(POLLY_TO_VISEME[value], undefined, `chua map gia tri Polly "${value}"`);
  }
  assert.equal(Object.keys(POLLY_TO_VISEME).length, pollyValues.length);
});

test('moi ID map ra deu nam trong bo cua rig', () => {
  for (const id of Object.values(POLLY_TO_VISEME)) {
    assert.ok(VISEME_IDS.includes(id), `ID ${id} khong co animation tuong ung`);
  }
});

test('nam khau hinh Polly khong voi toi duoc dung la nam cai da khai', () => {
  // Neu bang map doi ma danh sach nay khong doi theo thi thanh do debug se
  // lam mo nham — nguoi doc se di tim loi o cho khong co loi.
  const reachable = new Set(Object.values(POLLY_TO_VISEME));
  const missing = VISEME_IDS.filter((id) => !reachable.has(id));
  assert.deepEqual(missing, [...UNREACHABLE_BY_POLLY]);
});

test('map dung cac cho gop co y', () => {
  // Polly khong tach /eɪ/ voi /ɛ/, cung khong tach cac nguyen am doi.
  assert.equal(POLLY_TO_VISEME['e'], POLLY_TO_VISEME['E']);
  // T (θ, ð) cho ve 17 chu khong phai 19: hinh luoi giua hai rang la thu
  // nguoi hoc can nhin thay, quan trong hon viec khop bang cua Azure.
  assert.equal(POLLY_TO_VISEME['T'], 17);
  assert.equal(POLLY_TO_VISEME['t'], 19);
  // l (14) phai tach khoi d/t/n (19) — rig nay co luoi nen tach duoc.
  assert.equal(POLLY_TO_VISEME['l'], 14);
});

test('frameFromPolly ha trong so cho schwa', () => {
  assert.deepEqual(frameFromPolly(120, '@'), { tMs: 120, viseme: 1, weight: SCHWA_WEIGHT });
  assert.deepEqual(frameFromPolly(120, 'E'), { tMs: 120, viseme: 4, weight: 1 });
});

test('frameFromPolly bo qua gia tri la thay vi nem', () => {
  assert.equal(frameFromPolly(0, 'khong-ton-tai'), null);
});

const frames: VisemeFrame[] = [
  { tMs: 0, viseme: 0, weight: 1 },
  { tMs: 100, viseme: 21, weight: 1 },
  { tMs: 250, viseme: 2, weight: 1 },
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
    { tMs: 0, viseme: 0, weight: 1 },
    { tMs: 126, viseme: 21, weight: 1 },
    { tMs: 200, viseme: 1, weight: 0.55 },
  ]);
});

test('parseSpeechMarks loai mark khong phai viseme', () => {
  const raw = [
    '{"time":0,"type":"sentence","start":0,"end":5,"value":"Hello"}',
    '{"time":373,"type":"word","start":5,"end":8,"value":"had"}',
    '{"time":10,"type":"viseme","value":"a"}',
  ].join('\n');

  assert.deepEqual(parseSpeechMarks(raw), [{ tMs: 10, viseme: 2, weight: 1 }]);
});

test('parseSpeechMarks bo qua dong hong thay vi mat ca cau', () => {
  const raw =
    '{"time":0,"type":"viseme","value":"sil"}\n{khong phai json\n\n{"time":5,"type":"viseme","value":"t"}';
  assert.deepEqual(parseSpeechMarks(raw), [
    { tMs: 0, viseme: 0, weight: 1 },
    { tMs: 5, viseme: 19, weight: 1 },
  ]);
});
