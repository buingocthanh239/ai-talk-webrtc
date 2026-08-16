/**
 *   node --test shared/speed.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clampSpeed, SPEED_MAX, SPEED_MIN } from './speed.ts';

test('chan trong gioi han cua Realtime API', () => {
  assert.equal(clampSpeed(0.85), 0.85);
  assert.equal(clampSpeed(0.1), SPEED_MIN);
  assert.equal(clampSpeed(3), SPEED_MAX);
  assert.equal(clampSpeed(SPEED_MIN), SPEED_MIN);
  assert.equal(clampSpeed(SPEED_MAX), SPEED_MAX);
});

test('gia tri rac trong lesson JSON roi ve mac dinh, khong lam hong token', () => {
  // Mot bai hoc go nham `"speed": "cham"` khong duoc phep lam ca route /token
  // tra 400 — sai mot file JSON thi chi bai do chay o toc do mac dinh.
  assert.equal(clampSpeed('cham'), 1);
  assert.equal(clampSpeed(undefined), 1);
  assert.equal(clampSpeed(NaN), 1);
});

/**
 * `Number(null)`, `Number('')` va `Number(false)` deu ra 0 — chan tho thi ra
 * 0.25 chu khong ra mac dinh. Nghia la `REALTIME_SPEED=` bo trong trong .env
 * se lam AI bo ra noi, va khong ai doc file .env ma doan duoc dieu do.
 */
test('rong / null / boolean duoc coi la KHONG co, khong phai so 0', () => {
  assert.equal(clampSpeed(''), 1);
  assert.equal(clampSpeed('   '), 1);
  assert.equal(clampSpeed(null), 1);
  assert.equal(clampSpeed(false), 1);
  assert.equal(clampSpeed('', 0.9), 0.9);
});

test('fallback truyen vao duoc dung khi gia tri khong hop le', () => {
  // Server: lesson.speed khong co -> lay REALTIME_SPEED; client: slider nhap
  // nham -> giu nguyen toc do dang chay.
  assert.equal(clampSpeed(undefined, 0.9), 0.9);
  assert.equal(clampSpeed('xxx', 0.7), 0.7);
  // Fallback cung bi chan — khong tin nguoc len phia goi
  assert.equal(clampSpeed(undefined, 9), SPEED_MAX);
  assert.equal(clampSpeed(undefined, NaN), 1);
});

test('chuoi so hop le van doc duoc (slider tra ve string)', () => {
  assert.equal(clampSpeed('0.75'), 0.75);
});
