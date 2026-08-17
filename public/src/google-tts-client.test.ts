/**
 *   node --test public/src/google-tts-client.test.ts
 *
 * Chay duoc trong Node vi client nay chi dung Web API co san o day: fetch, atob,
 * Blob, URL.createObjectURL. Va khac han duong Polly — KHONG can crypto.subtle,
 * tuc la khong can secure context. Doi nha xong thi mo tren `http://192.168.x.x`
 * cung doc duoc, cho ma duong Polly khong bao gio chay noi.
 *
 * Trong tam: mot khuc MAT AUDIO khi nao, va hai cho khac Polly de quen nhat —
 * than tra ve la JSON base64 chu khong phai bytes mp3, va khong con ai bat xep
 * hang mot request mot luc.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GoogleTtsError, synthesize } from './google-tts-client.ts';
import type { GoogleTtsGrant } from '../../shared/types.ts';

const VOICE = { name: 'en-US-Chirp3-HD-Achird', languageCode: 'en-US' };

const GRANT: GoogleTtsGrant = {
  provider: 'google',
  accessToken: 'ya29.TOKEN',
  expiresAt: Date.now() + 3600_000,
  voice: VOICE,
};

const OPTS = { voice: VOICE };

/** Than mp3 gia, dong goi dung cach Google dong goi: base64 trong JSON. */
const reply = (mp3: string): string =>
  JSON.stringify({ audioContent: Buffer.from(mp3, 'utf8').toString('base64') });

type Route = (attempt: number) => { status: number; body: string };

interface Stub {
  restore: () => void;
  calls: () => number;
  urls: () => string[];
  headers: () => Record<string, string>[];
  payloads: () => Record<string, never>[];
  signal: AbortSignal;
}

function stubFetch(route: Route): Stub {
  const original = globalThis.fetch;
  const abort = new AbortController();
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const payloads: Record<string, never>[] = [];
  let calls = 0;

  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    urls.push(String(url));
    headers.push((init.headers ?? {}) as Record<string, string>);
    if (init.body) payloads.push(JSON.parse(String(init.body)) as Record<string, never>);
    const { status, body } = route(calls++);
    return new Response(body, { status });
  }) as typeof globalThis.fetch;

  return {
    restore: () => {
      abort.abort();
      globalThis.fetch = original;
    },
    calls: () => calls,
    urls: () => urls,
    headers: () => headers,
    payloads: () => payloads,
    signal: abort.signal,
  };
}

test('mot khuc = MOT request, va tra ve mp3 da giai base64', async () => {
  // Cho de quen nhat cua ca cuoc doi nha: Polly tra bytes mp3 thang, Google tra
  // JSON co truong `audioContent` la base64. Quen giai ma thi the <audio> nhan
  // duoc mot chuoi chu cai va im lang khong phat gi.
  const stub = stubFetch(() => ({ status: 200, body: reply('MP3BYTES') }));
  try {
    const r = await synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal });
    assert.equal(await r.blob.text(), 'MP3BYTES');
    assert.equal(r.blob.type, 'audio/mpeg');
    assert.ok(r.url.length > 0);
    assert.equal(stub.calls(), 1);
  } finally {
    stub.restore();
  }
});

test('token di trong header Bearer, khong phai query string', async () => {
  // `?key=` hay `?access_token=` deu nam trong URL, tuc la nam trong log cua moi
  // proxy tren duong di.
  const stub = stubFetch(() => ({ status: 200, body: reply('MP3BYTES') }));
  try {
    await synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal });
    assert.equal(stub.headers()[0]?.['Authorization'], 'Bearer ya29.TOKEN');
    assert.ok(!stub.urls()[0]?.includes('ya29'), 'token khong duoc lot vao URL');
    assert.match(stub.urls()[0] ?? '', /texttospeech\.googleapis\.com\/v1\/text:synthesize/);
  } finally {
    stub.restore();
  }
});

test('body dung hinh dang Google doi', async () => {
  const stub = stubFetch(() => ({ status: 200, body: reply('MP3BYTES') }));
  try {
    await synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal });
    assert.deepEqual(stub.payloads()[0], {
      input: { text: 'Hello there.' },
      voice: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Achird' },
      audioConfig: { audioEncoding: 'MP3' },
    });
  } finally {
    stub.restore();
  }
});

test('khong gui speakingRate — toc do doc thuoc ve playbackRate', async () => {
  // `speakingRate` nam trong REQUEST, nen no chi doi duoc tu khuc ke tiep.
  // `playbackRate` cua the <audio> doi duoc GIUA CHUNG mot cau, va do la ca ly do
  // duong nay dung <audio> chu khong phai Web Audio. Gui ca hai la co mot duong
  // im lang de nguoi hoc keo slider ma khuc dang phat khong doi.
  const stub = stubFetch(() => ({ status: 200, body: reply('MP3BYTES') }));
  try {
    await synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal });
    const cfg = stub.payloads()[0]?.['audioConfig'] as Record<string, unknown>;
    assert.equal(cfg['speakingRate'], undefined);
    assert.equal(cfg['pitch'], undefined);
  } finally {
    stub.restore();
  }
});

test('nhieu khuc duoc di CUNG LUC — khong con cua xep hang nhu Polly', async () => {
  // Polly bat noi tiep vi endpoint h2 cua no bao MAX_CONCURRENT_STREAMS = 1. Google
  // khong co rang buoc do, va do la mot trong hai cai thang cua viec doi nha:
  // khuc N+1 duoc tong hop that su song song voi khuc N.
  //
  // Test nay se do khi nao co ai vo tinh mang cua `serial` cua Polly sang day.
  const original = globalThis.fetch;
  let live = 0;
  let peak = 0;

  globalThis.fetch = (async () => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 10));
    live--;
    return new Response(reply('MP3BYTES'), { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    await Promise.all([
      synthesize(GRANT, 'One.', OPTS),
      synthesize(GRANT, 'Two.', OPTS),
      synthesize(GRANT, 'Three.', OPTS),
    ]);
    assert.equal(peak, 3, `chi co ${peak} request chay song song — co ai xep hang lai roi`);
  } finally {
    globalThis.fetch = original;
  }
});

test('401 mang status ra ngoai de hang doi biet ma xin token moi', async () => {
  // Google tra 401 cho token het han (Polly tra 403). Hang doi re theo status nay
  // de xin lai grant, nen no phai ra toi duoc ben ngoai.
  const stub = stubFetch(() => ({ status: 401, body: '{"error":{"message":"invalid"}}' }));
  try {
    await assert.rejects(
      () => synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal }),
      (err: unknown) => err instanceof GoogleTtsError && err.status === 401
    );
  } finally {
    stub.restore();
  }
});

test('400 thi nem luon, thu lai chi ton them thoi gian', async () => {
  const stub = stubFetch(() => ({ status: 400, body: '{"error":{"message":"bad voice"}}' }));
  try {
    await assert.rejects(
      () => synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal }),
      (err: unknown) => err instanceof GoogleTtsError && err.status === 400
    );
    assert.equal(stub.calls(), 1, 'khong duoc thu lai loi tham so');
  } finally {
    stub.restore();
  }
});

test('429 roi thanh cong: co retry, khong bo khuc', async () => {
  const stub = stubFetch((attempt) =>
    attempt === 0
      ? { status: 429, body: 'RESOURCE_EXHAUSTED' }
      : { status: 200, body: reply('MP3BYTES') }
  );
  try {
    const r = await synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal });
    assert.equal(await r.blob.text(), 'MP3BYTES');
    assert.equal(stub.calls(), 2);
  } finally {
    stub.restore();
  }
});

test('loi TANG MANG duoc thu lai', async () => {
  // `fetch` nem thang, khong co status nao — duong retry theo 429 khong cham toi.
  // Chrome khong tu thu lai POST, nen phai tu lam.
  const stub = stubFetch((attempt) => {
    if (attempt === 0) throw new TypeError('Failed to fetch');
    return { status: 200, body: reply('MP3BYTES') };
  });
  try {
    const r = await synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal });
    assert.equal(await r.blob.text(), 'MP3BYTES');
  } finally {
    stub.restore();
  }
});

test('200 nhung khong co audioContent la hong, khong phai khuc im lang', async () => {
  // Tra ve mot blob rong thi the <audio> ban `ended` ngay va ca luot chay tiep
  // nhu khong co gi — cau AI bien mat ma khong ai bao loi.
  const stub = stubFetch(() => ({ status: 200, body: '{}' }));
  try {
    await assert.rejects(
      () => synthesize(GRANT, 'Hello there.', { ...OPTS, signal: stub.signal }),
      /audioContent/
    );
  } finally {
    stub.restore();
  }
});
