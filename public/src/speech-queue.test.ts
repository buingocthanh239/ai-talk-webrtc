/**
 *   node --test public/src/speech-queue.test.ts
 *
 * Test tich hop cua vong phat: nap text -> cat khuc -> Polly (gia) -> phat.
 * Cau hoi duy nhat o day: MOI khuc co duoc phat, va co duoc phat HET khong.
 *
 * Vung nay truoc gio khong co test nao, va da co hai loi lot qua: `emptied`
 * cua chinh minh bi hieu la "phat xong", va `Promise.all` lam marks hong keo
 * theo audio.
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

const MARKS = '{"time":0,"type":"viseme","value":"p"}\n{"time":90,"type":"viseme","value":"a"}';

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
}

function stubEnv(marksStatus = 200): Env {
  const origFetch = globalThis.fetch;
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  const blobs = new Map<string, Blob>();
  let n = 0;

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as { OutputFormat: string; Text: string };
    if (payload.OutputFormat === 'json') {
      return new Response(marksStatus === 200 ? MARKS : 'Rate exceeded', { status: marksStatus });
    }
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
  };
}

interface Run {
  /** Text cua tung khuc da phat HET, dung thu tu. */
  played: string[];
  cutOff: string[];
  errors: string[];
  chunks: number;
}

/** Nap text vao hang doi, doi `onDrain`, tra ve nhung gi da xay ra. */
async function run(text: string, marksStatus = 200): Promise<Run> {
  const env = stubEnv(marksStatus);
  const audio = new FakeAudio();
  const errors: string[] = [];
  let chunks = 0;

  try {
    const drained = new Promise<void>((resolve) => {
      const queue = new SpeechQueue(audio as unknown as HTMLAudioElement, {
        onChunk: () => {
          chunks++;
        },
        onDrain: () => resolve(),
        onError: (m) => errors.push(m),
        refreshGrant: async () => GRANT,
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
    return { played, cutOff: audio.cutOff, errors, chunks };
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
  assert.equal(r.chunks, r.played.length, 'so khuc nap timeline phai khop so khuc phat');
});

test('khuc phat dung thu tu va khong sot chu', async () => {
  const r = await run(TEXT);

  // Than mp3 gia chinh la text cua khuc — noi lai phai ra dung cau goc.
  const spoken = r.played.join(' ');
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  assert.equal(norm(spoken), norm(TEXT));
});

test('speech marks hong: van doc du moi khuc, chi mat khau hinh', async () => {
  const r = await run(TEXT, 429);

  assert.ok(r.played.length >= 3, 'marks hong khong duoc lam mat khuc nao');
  assert.deepEqual(r.cutOff, []);
});
