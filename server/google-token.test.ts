/**
 *   node --test server/google-token.test.ts
 *
 * Cap access token cua Google cho client. Ba cau hoi, theo thu tu quan trong:
 *
 *   1. Token co duoc TAI DUNG khong. Token cua Google song 1 tieng; mint mot cai
 *      moi cho tung khuc doc la vua cham vua tu di xin rate limit cua chinh minh.
 *   2. JWT co dung hinh dang Google doi khong. Sai la 400 `invalid_grant`, va
 *      thong bao cua Google o day noi tieng la khong noi gi.
 *   3. Het han co duoc lam moi truoc khi client cam mot token da chet khong.
 *
 * Khoa RSA trong bo test nay la khoa THAT, sinh tai cho — nho vay chu ky duoc
 * kiem bang `crypto.verify` chu khong phai bang mot cai mock tu xac nhan minh.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify as verifySignature } from 'node:crypto';

import {
  googleTokenSource,
  serviceAccountFromEnv,
  signedJwt,
  SCOPE,
  type ServiceAccount,
} from './google-token.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const SA: ServiceAccount = {
  clientEmail: 'tts@example.iam.gserviceaccount.com',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  tokenUri: 'https://oauth2.googleapis.com/token',
};

const AT = 1_700_000_000_000;

const decodeSegment = (seg: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as Record<string, unknown>;

// ------------------------------------------------------------------ doc env

test('serviceAccountFromEnv tra null khi chua khai gi', () => {
  assert.equal(serviceAccountFromEnv({}), null);
});

test('doc duoc service account dang JSON thang trong env', () => {
  const got = serviceAccountFromEnv({
    GOOGLE_TTS_SA_JSON: JSON.stringify({
      client_email: 'a@b.iam.gserviceaccount.com',
      private_key: 'KEY',
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
  });
  assert.equal(got?.clientEmail, 'a@b.iam.gserviceaccount.com');
  assert.equal(got?.privateKey, 'KEY');
});

test('thieu private_key thi nga ra chu khong tra null', () => {
  // null nghia la "chua bat", con day la "da noi ro y dinh nhung khai sai" —
  // hai chuyen khac nhau, va lan sau la loi cau hinh.
  assert.throws(
    () =>
      serviceAccountFromEnv({
        GOOGLE_TTS_SA_JSON: JSON.stringify({ client_email: 'a@b.com' }),
      }),
    /private_key/
  );
});

test('JSON hong thi noi ro la hong o dau', () => {
  assert.throws(() => serviceAccountFromEnv({ GOOGLE_TTS_SA_JSON: '{khong phai json' }), /SA_JSON/);
});

test('token_uri thieu thi lay mac dinh cua Google', () => {
  const got = serviceAccountFromEnv({
    GOOGLE_TTS_SA_JSON: JSON.stringify({
      client_email: 'a@b.iam.gserviceaccount.com',
      private_key: 'KEY',
    }),
  });
  assert.equal(got?.tokenUri, 'https://oauth2.googleapis.com/token');
});

// ------------------------------------------------------------------ ky JWT

test('JWT co header RS256 va bo claim Google doi', () => {
  const [h, p] = signedJwt(SA, AT).split('.');
  const header = decodeSegment(h ?? '');
  const claims = decodeSegment(p ?? '');

  assert.equal(header['alg'], 'RS256');
  assert.equal(header['typ'], 'JWT');

  assert.equal(claims['iss'], SA.clientEmail);
  // `aud` PHAI la token_uri. Dat sai cho nay la 400 invalid_grant.
  assert.equal(claims['aud'], SA.tokenUri);
  assert.equal(claims['scope'], SCOPE);
  assert.equal(claims['iat'], AT / 1000);
  assert.equal(claims['exp'], AT / 1000 + 3600);
});

test('scope la cloud-platform — Cloud TTS khong co scope nao hep hon', () => {
  // Ghi ra thanh mot assert de sau nay ai do siet lai thi phai doi tay o day, va
  // doc duoc ly do. Day cung la ly do SA nay phai la SA rieng khong co quyen gi
  // khac: token ro ra la goi duoc moi API ma SA duoc phep.
  assert.equal(SCOPE, 'https://www.googleapis.com/auth/cloud-platform');
});

test('chu ky JWT kiem duoc bang public key that', () => {
  const jwt = signedJwt(SA, AT);
  const [h, p, sig] = jwt.split('.');
  assert.ok(
    verifySignature(
      'RSA-SHA256',
      Buffer.from(`${h}.${p}`),
      publicKey,
      Buffer.from(sig ?? '', 'base64url')
    ),
    'chu ky khong kiem duoc'
  );
});

// ------------------------------------------------------------------ doi token

interface Stub {
  restore: () => void;
  calls: () => number;
  bodies: () => string[];
}

function stubToken(reply: () => { status: number; body: string }): Stub {
  const original = globalThis.fetch;
  const bodies: string[] = [];

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    const { status, body } = reply();
    return new Response(body, { status });
  }) as typeof globalThis.fetch;

  return {
    restore: () => {
      globalThis.fetch = original;
    },
    calls: () => bodies.length,
    bodies: () => bodies,
  };
}

const ok = (expiresIn = 3599) => () => ({
  status: 200,
  body: JSON.stringify({ access_token: 'ya29.TOKEN', expires_in: expiresIn }),
});

test('doi JWT lay access token, va bao dung han', async () => {
  const stub = stubToken(ok());
  try {
    const got = await googleTokenSource(SA).token(AT);
    assert.equal(got.accessToken, 'ya29.TOKEN');
    assert.equal(got.expiresAt, AT + 3599_000);
  } finally {
    stub.restore();
  }
});

test('body dung grant_type jwt-bearer', async () => {
  const stub = stubToken(ok());
  try {
    await googleTokenSource(SA).token(AT);
    const form = new URLSearchParams(stub.bodies()[0] ?? '');
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.ok(form.get('assertion')?.startsWith('ey'), 'assertion phai la JWT');
  } finally {
    stub.restore();
  }
});

test('token con han thi TAI DUNG, khong goi Google lan nua', async () => {
  // Day la cai dat nhat neu lam sai. Moi khuc doc ma mint mot token 1 tieng la
  // hang tram request thua moi buoi hoc, va rate limit cua chinh minh se chan
  // minh truoc khi hoa don kip len.
  const stub = stubToken(ok());
  try {
    const src = googleTokenSource(SA);
    const a = await src.token(AT);
    const b = await src.token(AT + 60_000);
    assert.equal(stub.calls(), 1, 'token con han ma van goi lai Google');
    assert.equal(a.accessToken, b.accessToken);
  } finally {
    stub.restore();
  }
});

test('hai lan xin cung luc chi mint MOT token', async () => {
  // Luc khoi dong lanh, nhieu buoi hoc mo cung luc deu thay cache rong. Khong
  // gop lai thi moi cai tu mint mot token, va do la dung luc de dot rate limit.
  const stub = stubToken(ok());
  try {
    const src = googleTokenSource(SA);
    const [a, b] = await Promise.all([src.token(AT), src.token(AT)]);
    assert.equal(stub.calls(), 1, 'hai lan xin song song lam thanh hai request');
    assert.equal(a.accessToken, b.accessToken);
  } finally {
    stub.restore();
  }
});

test('gan het han thi mint lai truoc khi client kip cam token chet', async () => {
  // Client con phai giu token nay mot luc va ban nhieu khuc bang no. Tra ve mot
  // token con 10 giay la dung ky thuat ma vo dung tren thuc te.
  const stub = stubToken(ok());
  try {
    const src = googleTokenSource(SA);
    await src.token(AT);
    await src.token(AT + 3550_000);
    assert.equal(stub.calls(), 2, 'token gan chet phai duoc thay');
  } finally {
    stub.restore();
  }
});

test('Google tu choi thi nem, va mang theo status', async () => {
  const stub = stubToken(() => ({
    status: 400,
    body: JSON.stringify({ error: 'invalid_grant' }),
  }));
  try {
    await assert.rejects(() => googleTokenSource(SA).token(AT), /400|invalid_grant/);
  } finally {
    stub.restore();
  }
});

test('mot lan hong khong dong bang cache vinh vien', async () => {
  // Neu lan hong duoc nho lai nhu mot promise trong cache thi moi lan xin sau do
  // deu nhan lai dung cai loi cu, va buoi hoc khong bao gio co tieng nua cho toi
  // luc restart server.
  let fail = true;
  const stub = stubToken(() => {
    if (fail) return { status: 500, body: 'boom' };
    return ok()();
  });
  try {
    const src = googleTokenSource(SA);
    await assert.rejects(() => src.token(AT));
    fail = false;
    const got = await src.token(AT);
    assert.equal(got.accessToken, 'ya29.TOKEN');
  } finally {
    stub.restore();
  }
});

test('200 nhung khong co access_token cung la hong', async () => {
  const stub = stubToken(() => ({ status: 200, body: JSON.stringify({ expires_in: 3599 }) }));
  try {
    await assert.rejects(() => googleTokenSource(SA).token(AT), /access_token/);
  } finally {
    stub.restore();
  }
});
