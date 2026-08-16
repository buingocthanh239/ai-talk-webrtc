/**
 *   node --test public/src/speech-queue.test.ts
 *
 * Test tich hop cua vong phat: nap text -> cat khuc -> Polly (gia) -> phat.
 * Cau hoi duy nhat o day: MOI khuc co duoc phat, va co duoc phat HET khong.
 *
 * Vung nay truoc gio khong co test nao, va da co hai loi lot qua: `emptied`
 * cua chinh minh bi hieu la "phat xong", va `Promise.all` lam speech marks hong
 * keo theo audio. Loi thu hai gio khong the tai dien — duong marks da bo han.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SpeechQueue } from './speech-queue.ts';
import type { PollyGrant } from '../../shared/types.ts';

const GRANT: PollyGrant = {
  region: 'ap-southeast-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  expiresAt: Date.now() + 3600_000,
  voiceId: 'Joanna',
  engine: 'neural',
};

/**
 * <audio> gia. Mo phong hai diem cua spec co that:
 *   - gan `src` khi da co nguon -> xep hang su kien `emptied`
 *   - `play()` bat dau phat; `ended` bay sau do mot nhip
 */
class FakeAudio {
  readonly #listeners = new Map<string, Set<() => void>>();
  #hasSource = false;
  #endTimer: ReturnType<typeof setTimeout> | null = null;

  preservesPitch = false;
  playbackRate = 1;

  /** Moi khuc thuc su phat den het, theo thu tu. */
  readonly played: string[] = [];
  /** Khuc bi ghi de src khi chua ket thuc — tuc la bi cat ngang. */
  readonly cutOff: string[] = [];

  #current: string | null = null;

  set src(value: string) {
    if (this.#current !== null) this.cutOff.push(this.#current);
    if (this.#hasSource) setTimeout(() => this.#emit('emptied'), 0);
    this.#hasSource = true;
    this.#current = value;
    if (this.#endTimer) clearTimeout(this.#endTimer);
    this.#endTimer = null;
  }

  async play(): Promise<void> {
    const url = this.#current;
    // "Phat" trong 20ms roi ban `ended`, giong mot khuc that.
    this.#endTimer = setTimeout(() => {
      if (this.#current !== url || url === null) return;
      this.played.push(url);
      this.#current = null;
      this.#emit('ended');
    }, 20);
  }

  pause(): void {}

  removeAttribute(_name: string): void {
    if (this.#endTimer) clearTimeout(this.#endTimer);
    this.#endTimer = null;
    this.#current = null;
  }

  load(): void {
    if (this.#hasSource) setTimeout(() => this.#emit('emptied'), 0);
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

  #emit(type: string): void {
    for (const fn of [...(this.#listeners.get(type) ?? [])]) fn();
  }
}

interface Env {
  restore: () => void;
  /** Text goc cua khuc dang nam sau mot blob URL. */
  textOf: (url: string) => Promise<string>;
  /** So request Polly da di. Mot khuc phai la dung mot. */
  calls: () => number;
}

function stubEnv(): Env {
  const origFetch = globalThis.fetch;
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  const blobs = new Map<string, Blob>();
  let n = 0;
  let calls = 0;

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls++;
    const payload = JSON.parse(String(init.body)) as { Text: string };
    // Than mp3 gia chinh la text — nho vay lan nguoc tu blob ve khuc duoc.
    return new Response(payload.Text, { status: 200 });
  }) as typeof globalThis.fetch;

  URL.createObjectURL = ((blob: Blob) => {
    const url = `blob:${n++}`;
    blobs.set(url, blob);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

  return {
    restore: () => {
      globalThis.fetch = origFetch;
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    },
    textOf: async (url) => (await blobs.get(url)?.text()) ?? '',
    calls: () => calls,
  };
}

interface Run {
  /** Text cua tung khuc da phat HET, dung thu tu. */
  played: string[];
  cutOff: string[];
  errors: string[];
  /** Do dai bao ra cho khau luu audio, theo tung khuc. */
  durations: number[];
  calls: number;
}

/** Nap text vao hang doi, doi `onDrain`, tra ve nhung gi da xay ra. */
async function run(text: string): Promise<Run> {
  const env = stubEnv();
  const audio = new FakeAudio();
  const errors: string[] = [];
  const durations: number[] = [];

  try {
    const drained = new Promise<void>((resolve) => {
      const queue = new SpeechQueue(audio as unknown as HTMLAudioElement, {
        onDrain: () => resolve(),
        onError: (m) => errors.push(m),
        refreshGrant: async () => GRANT,
        onAudio: (_blob, _text, durationMs) => durations.push(durationMs),
      });
      queue.setGrant(GRANT);
      queue.push(text);
      queue.end();
    });

    await Promise.race([
      drained,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('hang doi khong bao gio canh')), 5000)
      ),
    ]);
    const played = [];
    for (const url of audio.played) played.push(await env.textOf(url));
    return { played, cutOff: audio.cutOff, errors, durations, calls: env.calls() };
  } finally {
    env.restore();
  }
}

const TEXT =
  'Hello there! What can I get for you today? A medium latte is four dollars fifty. ' +
  'Would you like it hot or iced? And can I get a name for the order please?';

test('moi khuc deu duoc phat HET, khong khuc nao bi cat ngang', async () => {
  const r = await run(TEXT);

  assert.ok(r.played.length >= 3, `phai co nhieu khuc, co ${r.played.length}`);
  assert.deepEqual(r.cutOff, [], 'khong khuc nao duoc phep bi ghi de src khi chua xong');
  assert.deepEqual(r.errors, []);
});

test('khuc phat dung thu tu va khong sot chu', async () => {
  const r = await run(TEXT);

  // Than mp3 gia chinh la text cua khuc — noi lai phai ra dung cau goc.
  const spoken = r.played.join(' ');
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  assert.equal(norm(spoken), norm(TEXT));
});

test('ca luot chi ton dung mot request Polly moi khuc', async () => {
  // Cai gia thuc cua khau nhep mom nam o day chu khong o hoa don thang: moi
  // request thua la mot vong mang nua tren duong noi tiep (Polly chi cho mot
  // stream h2 mot luc), va khuc dau tien cua moi luot chinh la toan bo do tre
  // nguoi hoc cam thay.
  const r = await run(TEXT);
  assert.equal(r.calls, r.played.length, 'mot khuc phai la dung mot request');
});

test('moi khuc bao ra mot do dai uoc luong duong', async () => {
  // Con so nay tung doc tu moc viseme cuoi cua speech marks. Bo marks thi no
  // uoc tu do dai chu — sai vai tram ms thi khong sao, nhung ve 0 la man tong
  // ket hien "0:00" cho moi cau AI.
  const r = await run(TEXT);

  assert.equal(r.durations.length, r.played.length, 'khuc nao doc xong cung phai bao');
  for (const ms of r.durations) {
    assert.ok(ms > 0 && Number.isFinite(ms), `do dai vo nghia: ${ms}`);
  }
});
