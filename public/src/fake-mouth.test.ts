/**
 *   node --test public/src/fake-mouth.test.ts
 *
 * Chi test phan THUAN: bien do -> khau hinh. Phan WebAudio (`FakeMouthPlayer`)
 * khong test duoc o Node va cung khong nen — no chi la mot cai voi cam vao the
 * <audio>, khong co quyet dinh nao trong do.
 *
 * Cau hoi cua bo test nay khong phai "nhep co dung am vi khong" — nhep FAKE thi
 * chac chan sai am vi, do la thoa thuan tu dau. Cau hoi la: **mom co dong dung
 * luc co tieng va dong dung luc im khong**, tren moi muc am luong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FakeMouth,
  shapeStep,
  MOUTH_CLOSED,
  MOUTH_PRESSED,
  FAKE_VISEME_IDS,
} from './fake-mouth.ts';
import { VISEME_IDS, visemeAnimation } from '../../shared/viseme.ts';

/** Mot nhip 60fps. */
const DT = 16;

/** Bom `count` nhip cung mot bien do, tra ve ket qua cua nhip cuoi. */
function feed(
  mouth: FakeMouth,
  rms: number,
  count: number,
  dt = DT
): ReturnType<FakeMouth['step']> {
  let last = mouth.step(rms, dt);
  for (let i = 1; i < count; i++) last = mouth.step(rms, dt);
  return last;
}

/** Bao nhieu lan bac DOI khi cho `shapeStep` an mot chuoi muc. */
function stepChanges(series: readonly number[], from = 0): number {
  let changes = 0;
  let step = from;
  for (const level of series) {
    const next = shapeStep(level, step);
    if (next !== step) changes++;
    step = next;
  }
  return changes;
}

test('moi khau hinh fake deu co animation that tren rig', () => {
  // Rig co 22 animation `viseme_0`..`viseme_21`. Chon nham mot so nam ngoai bo
  // do thi `setAnimation` khong tim thay ten, Spine khong nem, va mom chi don
  // gian dung im — mot loi khong he bao ra cho nao.
  for (const id of FAKE_VISEME_IDS) {
    assert.ok(VISEME_IDS.includes(id), `${visemeAnimation(id)} khong co tren rig`);
  }
  assert.equal(new Set(FAKE_VISEME_IDS).size, FAKE_VISEME_IDS.length, 'co ID trung');
});

test('im lang thi mom dong', () => {
  const mouth = new FakeMouth();
  const out = feed(mouth, 0, 30);
  assert.equal(out.id, MOUTH_CLOSED);
  assert.equal(out.level, 0);
});

test('co tieng thi mom mo', () => {
  const mouth = new FakeMouth();
  const out = feed(mouth, 0.3, 30);
  assert.notEqual(out.id, MOUTH_CLOSED);
  assert.ok(out.level > 0.5, `level phai cao, duoc ${out.level}`);
});

test('ban thu NHO TIENG van mo mom — day la ly do phai chuan hoa', () => {
  // Polly khong chuan hoa loudness giua cac giong, va nguoi hoc con keo duoc
  // volume. Neu doc thang bien do tuyet doi thi giong nho tieng se nhep hoi hot
  // suot buoi, con giong to tieng thi ha ham het co moi am tiet.
  const quiet = new FakeMouth();
  const loud = new FakeMouth();

  const q = feed(quiet, 0.02, 60);
  const l = feed(loud, 0.4, 60);

  assert.notEqual(q.id, MOUTH_CLOSED, 'giong nho tieng cung phai nhep');
  assert.equal(q.id, l.id, 'cung mot dang song thi ra cung mot khau hinh');
});

test('nhieu nen cuc nho KHONG duoc khuech dai thanh loi noi', () => {
  // Mat trai cua chuan hoa: chia cho mot dinh be ti thi tieng u u cua may lanh
  // cung thanh "dang noi". `PEAK_FLOOR` la cai chan do lai.
  const mouth = new FakeMouth();
  const out = feed(mouth, 0.0004, 60);
  assert.equal(out.id, MOUTH_CLOSED, 'duoi san nhieu thi coi nhu im');
});

test('im NGAN giua cau cho moi chum, khong ve mieng nghi', () => {
  // Chinh la phu am bat (p, b, m): mot khoang lang roi bung ra. `lip-sync.md`
  // muc 1 noi dung — phan tich pho khong tach duoc no khoi im lang. Fake thi
  // khong can tach: im ngan GIUA luc dang noi gan nhu luon la phu am bat.
  const mouth = new FakeMouth();
  feed(mouth, 0.3, 40); // dang noi
  const out = feed(mouth, 0, 5); // im 80ms
  assert.equal(out.id, MOUTH_PRESSED);
});

test('im DAI thi ve mieng nghi chu khong ngam moi mai', () => {
  const mouth = new FakeMouth();
  feed(mouth, 0.3, 40);
  const out = feed(mouth, 0, 40); // im 640ms
  assert.equal(out.id, MOUTH_CLOSED);
});

test('muc dao dong quanh nguong khong lam mom rung', () => {
  // Khong co tre nguong thi moi frame lai doi hinh mot lan — Spine bi tua lai
  // animation 60 lan/giay va mom nhin nhu giat dien.
  //
  // Test tren `shapeStep` chu khong qua `FakeMouth`: o day ta hoi rieng mot cau
  // "nguong co tre khong", va di qua ca duong chuan hoa thi dinh truot se keo
  // muc dich chuyen, lam cau tra loi lan sang mot chuyen khac.
  for (const edge of [0.14, 0.35, 0.62]) {
    const series = Array.from({ length: 60 }, (_, i) => edge + (i % 2 ? 0.01 : -0.01));
    const changes = stepChanges(series);
    assert.ok(changes <= 1, `nguong ${edge}: doi bac ${changes} lan — dang rung`);
  }
});

test('vuot han nguong thi van doi bac — tre nguong khong duoc lam mom liet', () => {
  assert.equal(shapeStep(0.9, 0), 3, 'to het co ma van dong mom');
  assert.equal(shapeStep(0, 3), 0, 'im hoan toan ma van ha ham');
});

test('to hon thi mo rong hon, va trong so tang theo', () => {
  const soft = new FakeMouth();
  const hard = new FakeMouth();

  // Cung mot dinh tham chieu cho hai ben, roi mot ben noi nho han.
  feed(soft, 0.5, 20);
  feed(hard, 0.5, 20);
  const s = feed(soft, 0.1, 20);
  const h = feed(hard, 0.5, 20);

  assert.ok(h.level > s.level);
  assert.ok(h.weight > s.weight, 'trong so la alpha cua track — phai mo theo do to');
  assert.ok(FAKE_VISEME_IDS.includes(s.id) && FAKE_VISEME_IDS.includes(h.id));
});

test('chi dung dung bo khau hinh da khai bao', () => {
  // `talk-avatar.ts` chi ve thanh do cho nhung ID trong FAKE_VISEME_IDS. Neu
  // `step()` tra ve mot ID ngoai bo do thi mom nhep ma thanh do dung im — dung
  // cai bay ma UNREACHABLE_BY_POLLY ngay xua duoc sinh ra de tranh.
  const mouth = new FakeMouth();
  const seen = new Set<number>();
  // Mot chuoi rang cua di qua het cac muc, ke ca cac khoang im dai ngan.
  for (let i = 0; i < 400; i++) {
    const phase = i % 50;
    const rms = phase < 30 ? (phase / 30) * 0.5 : phase < 36 ? 0 : 0.25;
    seen.add(mouth.step(rms, DT).id);
  }
  for (const id of seen) {
    assert.ok(FAKE_VISEME_IDS.includes(id), `ID ${id} khong nam trong FAKE_VISEME_IDS`);
  }
  assert.ok(seen.size >= 3, `chi thay ${seen.size} khau hinh — nhep se nhin nhu ban le`);
});

test('tab chay nen (dt rat lon) khong lam vo trang thai', () => {
  // requestAnimationFrame bi bop lai khi tab an di; luc quay ra co the la mot
  // buoc nhay vai tram ms.
  const mouth = new FakeMouth();
  feed(mouth, 0.3, 20);
  const out = mouth.step(0, 5000);
  assert.equal(out.id, MOUTH_CLOSED, 'nhay mot buoc dai qua im lang thi phai dong mom');
  assert.ok(Number.isFinite(out.level) && Number.isFinite(out.weight));
});

test('bien do vo nghia khong lam ra NaN', () => {
  // getByteTimeDomainData tren mot context vua bi suspend co the tra ve toan 0,
  // va mot phep chia khong canh se nem NaN vao thang alpha cua Spine.
  const mouth = new FakeMouth();
  for (const bad of [0, Number.NaN, -1, Infinity]) {
    const out = mouth.step(bad, DT);
    assert.ok(Number.isFinite(out.level), `level NaN voi rms=${bad}`);
    assert.ok(Number.isFinite(out.weight), `weight NaN voi rms=${bad}`);
    assert.ok(FAKE_VISEME_IDS.includes(out.id));
  }
});
