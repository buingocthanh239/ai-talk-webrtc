/**
 *   node --test public/src/polly-client.test.ts
 *
 * Chay duoc trong Node vi polly-client chi dung Web API co san o day:
 * crypto.subtle, fetch, Blob, URL.createObjectURL. Khong can trinh duyet.
 *
 * Trong tam: mot khuc MAT AUDIO khi nao.
 *
 * Bo test nay tung co mot nua noi ve speech marks — request thu hai cua moi
 * khuc — va ve chuyen mot ben hong khong duoc keo ben kia chet theo. Duong marks
 * da bo (avatar nhep fake tu bien do audio), nen gio moi khuc chi con MOT
 * request va cau hoi don gian han: no ve hay khong ve.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PollyError, synthesize } from './polly-client.ts';
import type { PollyGrant } from '../../shared/types.ts';

const GRANT: PollyGrant = {
  provider: 'polly',
  region: 'ap-southeast-1',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  expiresAt: Date.now() + 3600_000,
  voiceId: 'Joanna',
  engine: 'neural',
};

const OPTS = { voiceId: 'Joanna', engine: 'neural' as const };

type Reply = { status: number; body: string };
type Route = (attempt: number) => Reply;

interface Stub {
  restore: () => void;
  calls: () => number;
  /** Signal truyen vao `synthesize`. Huy o `finally` de request mo coi cua test
   * nay khong chay lan sang test sau. */
  signal: AbortSignal;
}

/** Thay `fetch` bang mot bo dinh tuyen. */
function stubFetch(route: Route): Stub {
  const original = globalThis.fetch;
  const abort = new AbortController();
  let calls = 0;

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    // `fetch` that tu choi ngay khi signal da huy. Khong mo phong cho nay thi
    // request mo coi cua test truoc van dem vao so lan goi cua test sau.
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const { status, body } = route(calls++);
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

test('mot khuc = MOT request Polly, va tra ve mp3', async () => {
  // Truoc day la hai: mp3 va speech marks tra ve THAY CHO nhau nen khong gop
  // duoc. Con mot nghia la moi ky tu chi bi tinh tien mot lan, va khuc dau tien
  // cua moi luot bot duoc mot vong mang — Polly chi cho mot stream h2 mot luc
  // nen hai request cua cung mot khuc phai noi tiep.
  const stub = stubFetch(() => ({ status: 200, body: 'MP3BYTES' }));
  try {
    const r = await synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal });
    assert.ok(r.url.length > 0);
    assert.equal(await r.blob.text(), 'MP3BYTES');
    assert.equal(stub.calls(), 1, 'khong duoc goi Polly them lan nao nua');
  } finally {
    stub.restore();
  }
});

test('khong xin speech marks nua', async () => {
  // Mot request `OutputFormat: "json"` lot lai vao day la hoa don am tham nhan
  // doi: AWS tinh tien speech marks Y HET synthesize.
  const formats: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    formats.push(payload['OutputFormat'], payload['SpeechMarkTypes']);
    return new Response('MP3BYTES', { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    await synthesize(GRANT, 'Hello there.', OPTS);
    assert.deepEqual(formats, ['mp3', undefined]);
  } finally {
    globalThis.fetch = original;
  }
});

test('audio hong thi nem — khuc do that su khong doc duoc', async () => {
  const stub = stubFetch(() => ({ status: 400, body: 'ValidationException' }));
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
  const stub = stubFetch((attempt) => {
    if (attempt === 0) throw new TypeError('Failed to fetch');
    return { status: 200, body: 'MP3BYTES' };
  });
  try {
    const r = await synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal });
    assert.equal(await r.blob.text(), 'MP3BYTES');
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

  globalThis.fetch = (async () => {
    live++;
    peak = Math.max(peak, live);
    // Co do tre thi cho chong nhau moi lo ra; tra ve ngay thi test luon xanh.
    await new Promise((r) => setTimeout(r, 10));
    live--;
    return new Response('MP3BYTES', { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    // Ba khuc cung luc — dung tran MAX_IN_FLIGHT cua SpeechQueue. Bo speech
    // marks lam so request tut tu sau xuong ba, nhung rang buoc thi khong doi:
    // mot stream mot luc, ba khuc van phai xep hang.
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
  const stub = stubFetch((attempt) => {
    if (attempt === 0) return { status: 429, body: 'Rate exceeded' };
    return { status: 200, body: 'MP3BYTES' };
  });
  try {
    const r = await synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal });
    assert.equal(await r.blob.text(), 'MP3BYTES');
    assert.equal(stub.calls(), 2, 'mot lan hong + mot lan lai');
  } finally {
    stub.restore();
  }
});
