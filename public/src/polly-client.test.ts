/**
 *   node --test public/src/polly-client.test.ts
 *
 * Chay duoc trong Node vi polly-client chi dung Web API co san o day:
 * crypto.subtle, fetch, Blob, URL.createObjectURL. Khong can trinh duyet.
 *
 * Trong tam: mot khuc MAT AUDIO khi nao. Audio la thu nguoi hoc nghe; speech
 * marks chi de avatar nhep. Hai thu do khong duoc chet cung nhau.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PollyError, synthesize } from './polly-client.ts';
import type { PollyGrant } from '../../shared/types.ts';

const GRANT: PollyGrant = {
  region: 'ap-southeast-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  expiresAt: Date.now() + 3600_000,
  voiceId: 'Joanna',
  engine: 'neural',
};

const OPTS = { voiceId: 'Joanna', engine: 'neural' as const };

/** Mot dong speech mark hop le cho viseme. */
const MARKS = '{"time":0,"type":"viseme","value":"p"}\n{"time":80,"type":"viseme","value":"a"}';

type Reply = { status: number; body: string };
type Route = (isMarks: boolean, attempt: number) => Reply;

interface Stub {
  restore: () => void;
  calls: () => number;
  /**
   * Signal truyen vao `synthesize`. Huy o `finally` de request mo coi khong
   * chay lan sang test sau — mot ben hong KHONG huy ben kia, do la hanh vi
   * that cua Promise.all va cung la mot phan cua bug nay.
   */
  signal: AbortSignal;
}

/** Thay `fetch` bang mot bo dinh tuyen. */
function stubFetch(route: Route): Stub {
  const original = globalThis.fetch;
  const abort = new AbortController();
  let calls = 0;
  const perKind = new Map<boolean, number>();

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    // `fetch` that tu choi ngay khi signal da huy. Khong mo phong cho nay thi
    // request mo coi cua test truoc van dem vao so lan goi cua test sau.
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    calls++;
    const payload = JSON.parse(String(init.body)) as { OutputFormat: string };
    const isMarks = payload.OutputFormat === 'json';
    const attempt = perKind.get(isMarks) ?? 0;
    perKind.set(isMarks, attempt + 1);

    const { status, body } = route(isMarks, attempt);
    return new Response(body, { status });
  }) as typeof globalThis.fetch;

  return {
    restore: () => {
      abort.abort();
      globalThis.fetch = original;
    },
    calls: () => calls,
    signal: abort.signal,
  };
}

test('ca hai request OK: co audio va co khau hinh', async () => {
  const stub = stubFetch((isMarks) => ({ status: 200, body: isMarks ? MARKS : 'MP3BYTES' }));
  try {
    const r = await synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal });
    assert.ok(r.url.length > 0);
    assert.equal(await r.blob.text(), 'MP3BYTES');
    assert.equal(r.frames.length, 2);
  } finally {
    stub.restore();
  }
});

test('speech marks hong nhung audio OK: VAN phai co audio', async () => {
  // Day la loi that: `Promise.all` buoc hai request song lam chet lam. Polly
  // tinh TPS theo ca account va moi khuc ban HAI request, nen request marks bi
  // throttle la chuyen binh thuong — va khi do khuc do mat tieng hoan toan,
  // du file mp3 da tai ve thanh cong.
  const stub = stubFetch((isMarks) =>
    isMarks ? { status: 429, body: 'Rate exceeded' } : { status: 200, body: 'MP3BYTES' }
  );
  try {
    const r = await synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal });
    assert.equal(await r.blob.text(), 'MP3BYTES', 'audio phai con nguyen');
    assert.deepEqual(r.frames, [], 'khong co khau hinh thi thoi, avatar dung im');
  } finally {
    stub.restore();
  }
});

test('audio hong thi nem — khuc do that su khong doc duoc', async () => {
  const stub = stubFetch((isMarks) =>
    isMarks ? { status: 200, body: MARKS } : { status: 400, body: 'ValidationException' }
  );
  try {
    await assert.rejects(
      () => synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal }),
      (err: unknown) => err instanceof PollyError && err.status === 400
    );
  } finally {
    stub.restore();
  }
});

test('loi TANG MANG (socket bi dong) phai duoc thu lai', async () => {
  // `fetch` nem thang chu khong tra ve status, nen duong retry theo 429 khong
  // he cham toi truong hop nay.
  //
  // Nguyen nhan hay gap nhat da duoc chan o cho khac — xem `serial` trong
  // polly-client.ts. Con lai la mang that: doi Wi-Fi, may vua ngu day, socket
  // dut giua chung. Chrome KHONG tu thu lai POST (chi thu lai cac method
  // idempotent) nen phai tu lam o day.
  const stub = stubFetch((isMarks, attempt) => {
    if (attempt === 0) throw new TypeError('Failed to fetch');
    return { status: 200, body: isMarks ? MARKS : 'MP3BYTES' };
  });
  try {
    const r = await synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal });
    assert.equal(await r.blob.text(), 'MP3BYTES');
    assert.equal(r.frames.length, 2);
  } finally {
    stub.restore();
  }
});

test('loi mang lien tuc thi cuoi cung van nem, khong thu mai', async () => {
  const stub = stubFetch(() => {
    throw new TypeError('Failed to fetch');
  });
  try {
    await assert.rejects(() =>
      synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal })
    );
  } finally {
    stub.restore();
  }
});

test('khong bao gio co hai request Polly chong nhau', async () => {
  // Endpoint HTTP/2 cua Polly bao SETTINGS_MAX_CONCURRENT_STREAMS = 1, ma
  // Chrome thi gom ca origin vao MOT ket noi h2. Ban hai request cung luc la
  // AWS giet ca ket noi, keo theo MOI request dang di tren do:
  // net::ERR_SOCKET_NOT_CONNECTED / net::ERR_CONNECTION_CLOSED.
  //
  // Do that trong Chrome: 6 request song song hong 41/48, cung 6 request do
  // ma noi tiep nhau thi hong 0/48.
  const original = globalThis.fetch;
  let live = 0;
  let peak = 0;

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    live++;
    peak = Math.max(peak, live);
    // Co do tre thi cho chong nhau moi lo ra; tra ve ngay thi test luon xanh.
    await new Promise((r) => setTimeout(r, 10));
    live--;
    const payload = JSON.parse(String(init.body)) as { OutputFormat: string };
    return new Response(payload.OutputFormat === 'json' ? MARKS : 'MP3BYTES', { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    // Ba khuc cung luc — dung tran MAX_IN_FLIGHT cua SpeechQueue, va moi khuc
    // la hai request (audio + speech marks). Tong cong sau.
    await Promise.all([
      synthesize(GRANT, 'One.', OPTS),
      synthesize(GRANT, 'Two.', OPTS),
      synthesize(GRANT, 'Three.', OPTS),
    ]);
    assert.equal(peak, 1, `co luc ${peak} request Polly chong nhau — AWS chi cho 1`);
  } finally {
    globalThis.fetch = original;
  }
});

test('429 roi thanh cong: co retry, khong bo khuc', async () => {
  const stub = stubFetch((isMarks, attempt) => {
    if (attempt === 0) return { status: 429, body: 'Rate exceeded' };
    return { status: 200, body: isMarks ? MARKS : 'MP3BYTES' };
  });
  try {
    const r = await synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal });
    assert.equal(await r.blob.text(), 'MP3BYTES');
    assert.equal(r.frames.length, 2);
    assert.equal(stub.calls(), 4, 'moi ben mot lan hong + mot lan lai');
  } finally {
    stub.restore();
  }
});
