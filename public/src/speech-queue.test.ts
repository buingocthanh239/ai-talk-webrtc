/**
 *   node --test public/src/speech-queue.test.ts
 *
 * Test tich hop cua vong phat: nap text -> cat khuc -> nha TTS (gia) -> phat.
 * Cau hoi duy nhat o day: MOI khuc co duoc phat, va co duoc phat HET khong.
 *
 * Vung nay truoc gio khong co test nao, va da co hai loi lot qua: `emptied`
 * cua chinh minh bi hieu la "phat xong", va `Promise.all` lam speech marks hong
 * keo theo audio. Loi thu hai gio khong the tai dien — duong marks da bo han.
 *
 * MOI BO TEST CHAY QUA CA HAI NHA. Hang doi khong duoc biet no dang noi voi ai,
 * va cach duy nhat de chung minh dieu do la bat no lam viec voi ca hai bang cung
 * mot bo assert. Cai nay se do ngay khi co ai lai nhet mot `grant.provider ===`
 * vao trong hang doi.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SpeechQueue } from './speech-queue.ts';
import type { GoogleTtsGrant, PollyGrant, TtsGrant } from '../../shared/types.ts';

const GOOGLE: GoogleTtsGrant = {
  provider: 'google',
  accessToken: 'ya29.TOKEN',
  expiresAt: Date.now() + 3600_000,
  voice: { name: 'en-US-Chirp3-HD-Achird', languageCode: 'en-US' },
};

const POLLY: PollyGrant = {
  provider: 'polly',
  region: 'ap-southeast-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  expiresAt: Date.now() + 3600_000,
  voiceId: 'Joanna',
  engine: 'neural',
};

/**
 * Hai nha dong goi than request/response khac nhau. Day la CHO DUY NHAT trong bo
 * test biet cai khac biet do — dung nhu hang doi.
 */
interface Wire {
  grant: TtsGrant;
  /** Text cua khuc, doc ra tu than request. */
  textOfRequest: (body: string) => string;
  /** Than response mang mp3 gia (chinh la text cua khuc). */
  reply: (text: string) => string;
  /** Status ma nha nay dung de bao "token het han". */
  expiredStatus: number;
}

const WIRES: Record<string, Wire> = {
  google: {
    grant: GOOGLE,
    textOfRequest: (body) => (JSON.parse(body) as { input: { text: string } }).input.text,
    reply: (text) => JSON.stringify({ audioContent: Buffer.from(text, 'utf8').toString('base64') }),
    expiredStatus: 401,
  },
  polly: {
    grant: POLLY,
    textOfRequest: (body) => (JSON.parse(body) as { Text: string }).Text,
    reply: (text) => text,
    expiredStatus: 403,
  },
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
  /** So request tong hop da di. Mot khuc phai la dung mot. */
  calls: () => number;
}

/** `route` tra ve status; undefined nghia la 200 kem mp3 gia. */
function stubEnv(wire: Wire, route?: (attempt: number) => number | undefined): Env {
  const origFetch = globalThis.fetch;
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  const blobs = new Map<string, Blob>();
  let n = 0;
  let calls = 0;

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const attempt = calls++;
    const status = route?.(attempt);
    if (status !== undefined && status !== 200) {
      return new Response('{"error":{"message":"nope"}}', { status });
    }
    // Than mp3 gia chinh la text — nho vay lan nguoc tu blob ve khuc duoc.
    return new Response(wire.reply(wire.textOfRequest(String(init.body))), { status: 200 });
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
  /** So lan hang doi phai di xin grant moi. */
  refreshes: number;
}

interface RunOptions {
  route?: (attempt: number) => number | undefined;
  /** Grant ban dau. Bo trong = dung grant cua wire. */
  initial?: TtsGrant | null;
}

/** Nap text vao hang doi, doi `onDrain`, tra ve nhung gi da xay ra. */
async function run(wire: Wire, text: string, opts: RunOptions = {}): Promise<Run> {
  const env = stubEnv(wire, opts.route);
  const audio = new FakeAudio();
  const errors: string[] = [];
  const durations: number[] = [];
  let refreshes = 0;

  try {
    const drained = new Promise<void>((resolve) => {
      const queue = new SpeechQueue(audio as unknown as HTMLAudioElement, {
        onDrain: () => resolve(),
        onError: (m) => errors.push(m),
        refreshGrant: async () => {
          refreshes++;
          return wire.grant;
        },
        onAudio: (_blob, _text, durationMs) => durations.push(durationMs),
      });
      queue.setGrant(opts.initial === undefined ? wire.grant : opts.initial);
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
    return { played, cutOff: audio.cutOff, errors, durations, calls: env.calls(), refreshes };
  } finally {
    env.restore();
  }
}

const TEXT =
  'Hello there! What can I get for you today? A medium latte is four dollars fifty. ' +
  'Would you like it hot or iced? And can I get a name for the order please?';

for (const [name, wire] of Object.entries(WIRES)) {
  test(`[${name}] moi khuc deu duoc phat HET, khong khuc nao bi cat ngang`, async () => {
    const r = await run(wire, TEXT);

    assert.ok(r.played.length >= 3, `phai co nhieu khuc, co ${r.played.length}`);
    assert.deepEqual(r.cutOff, [], 'khong khuc nao duoc phep bi ghi de src khi chua xong');
    assert.deepEqual(r.errors, []);
  });

  test(`[${name}] khuc phat dung thu tu va khong sot chu`, async () => {
    const r = await run(wire, TEXT);

    // Than mp3 gia chinh la text cua khuc — noi lai phai ra dung cau goc.
    const spoken = r.played.join(' ');
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
    assert.equal(norm(spoken), norm(TEXT));
  });

  test(`[${name}] ca luot chi ton dung mot request moi khuc`, async () => {
    // Moi request thua la mot lan tra tien nua, va voi Polly con la mot vong mang
    // nua tren duong noi tiep. Khuc dau tien cua moi luot chinh la toan bo do tre
    // nguoi hoc cam thay.
    const r = await run(wire, TEXT);
    assert.equal(r.calls, r.played.length, 'mot khuc phai la dung mot request');
  });

  test(`[${name}] moi khuc bao ra mot do dai uoc luong duong`, async () => {
    // Con so nay tung doc tu moc viseme cuoi cua speech marks. Bo marks thi no
    // uoc tu do dai chu — sai vai tram ms thi khong sao, nhung ve 0 la man tong
    // ket hien "0:00" cho moi cau AI.
    const r = await run(wire, TEXT);

    assert.equal(r.durations.length, r.played.length, 'khuc nao doc xong cung phai bao');
    for (const ms of r.durations) {
      assert.ok(ms > 0 && Number.isFinite(ms), `do dai vo nghia: ${ms}`);
    }
  });

  test(`[${name}] token het han giua luot: xin lai va doc lai khuc do`, async () => {
    // Status bao het han cua hai nha khac nhau (403 vs 401). Hang doi khong duoc
    // biet cai khac biet do — no chi hoi `isAuthError`. Neu cho do bi viet cung
    // theo mot nha thi nha kia mat KHUC DAU TIEN cua moi buoi hoc, dung luc
    // credential cu vua het han.
    const r = await run(wire, 'Hello there.', {
      route: (attempt) => (attempt === 0 ? wire.expiredStatus : undefined),
    });

    assert.equal(r.refreshes, 1, 'phai xin grant moi dung mot lan');
    assert.deepEqual(r.played, ['Hello there.'], 'khuc do phai duoc doc lai, khong duoc bo');
    assert.deepEqual(r.errors, []);
  });

  test(`[${name}] chua co grant thi xin truoc khi ban request dau tien`, async () => {
    // Vao buoi hoc bang duong resume thi hang doi co the chay truoc khi grant ve.
    // Khong hoi thi khuc dau tien di voi grant null va chet.
    const r = await run(wire, 'Hello there.', { initial: null });

    assert.equal(r.refreshes, 1);
    assert.deepEqual(r.played, ['Hello there.']);
  });
}
