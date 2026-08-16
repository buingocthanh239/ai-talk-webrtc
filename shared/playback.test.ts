/**
 *   node --test shared/playback.test.ts
 *
 * Test o day ton tai vi mot loi cu the: lan cho ket thuc som mot cach im lang
 * lam AI bo mat vai doan. Xem dau `shared/playback.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { waitForPlayback, type PlaybackTarget } from './playback.ts';

/**
 * <audio> gia, mo phong DUNG mot diem cua HTML spec:
 *
 *   Gan `src` khi element da co nguon -> "media element load algorithm" xep
 *   hang mot task ban ra `emptied`.
 *
 * Diem mau chot khong phai microtask hay macrotask, ma la: su kien do bay SAU
 * khoi dong bo dang chay — tuc la sau khi listener kip gan vao.
 */
class FakeAudio implements PlaybackTarget {
  readonly #listeners = new Map<string, Set<() => void>>();
  #hasSource = false;

  setSrc(): void {
    if (this.#hasSource) setTimeout(() => this.emit('emptied'), 0);
    this.#hasSource = true;
  }

  clearSrc(): void {
    if (this.#hasSource) setTimeout(() => this.emit('emptied'), 0);
    this.#hasSource = false;
  }

  addEventListener(type: string, listener: () => void): void {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const fn of [...(this.#listeners.get(type) ?? [])]) fn();
  }

  count(type: string): number {
    return this.#listeners.get(type)?.size ?? 0;
  }
}

/**
 * Nhuong vai vong event loop roi hoi: promise da xong chua?
 *
 * Khong dung Promise.race voi mot promise da resolve san — cai do luon thang,
 * ke ca khi `p` cung da xong, vi `p.then()` sinh ra mot promise moi cham hon
 * mot microtask.
 */
async function settled(p: Promise<void>): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  return done;
}

test('phat xong (`ended`) thi ket thuc lan cho', async () => {
  const audio = new FakeAudio();
  const wait = waitForPlayback(audio);
  audio.emit('ended');
  assert.equal(await settled(wait.done), true);
});

test('loi phat (`error`) cung ket thuc — khong duoc treo hang doi', async () => {
  const audio = new FakeAudio();
  const wait = waitForPlayback(audio);
  audio.emit('error');
  assert.equal(await settled(wait.done), true);
});

test('`emptied` do CHINH viec gan src khong duoc ket thuc lan cho', async () => {
  // Day la loi that: khuc thu hai tro di, `audio.src = url` ban ra `emptied`,
  // listener gan ngay sau do trong cung khoi dong bo bat duoc no, lan cho ket
  // thuc ngay va vong phat ghi de src — cat ngang khuc dang doc.
  const audio = new FakeAudio();
  audio.setSrc(); // khuc 1: element chua co nguon, khong ban emptied

  audio.setSrc(); // khuc 2: co nguon roi -> emptied duoc xep hang
  const wait = waitForPlayback(audio);

  assert.equal(
    await settled(wait.done),
    false,
    'lan cho ket thuc som — khuc dang doc se bi cat ngang'
  );

  // Van phai ket thuc binh thuong khi audio that su phat xong.
  audio.emit('ended');
  assert.equal(await settled(wait.done), true);
});

test('finish() go treo cho duong cancel()', async () => {
  // `cancel()` go src ra khoi <audio>; thao tac do khong ban ra `ended`, nen
  // khong co duong nay thi vong phat treo vinh vien.
  const audio = new FakeAudio();
  const wait = waitForPlayback(audio);

  wait.finish();
  assert.equal(await settled(wait.done), true);
});

test('ket thuc roi thi go het listener, khong ro ri qua cac khuc', async () => {
  const audio = new FakeAudio();
  const wait = waitForPlayback(audio);
  assert.equal(audio.count('ended'), 1);

  audio.emit('ended');
  await wait.done;

  assert.equal(audio.count('ended'), 0);
  assert.equal(audio.count('error'), 0);
});

test('goi finish() nhieu lan la vo hai', async () => {
  const audio = new FakeAudio();
  const wait = waitForPlayback(audio);
  wait.finish();
  wait.finish();
  audio.emit('ended');
  assert.equal(await settled(wait.done), true);
});
