import { createServer } from 'node:http';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  Character,
  CharacterList,
  Lesson,
  ProgressRecord,
  Quota,
  TtsGrant,
  VoiceMode,
} from '../shared/types.ts';
import {
  aiSpeaksItself,
  clientTtsProvider,
  effectiveVoiceMode,
  normalizeVoiceMode,
  VOICE_MODE_DEFAULT,
} from '../shared/voice-mode.ts';
import { clampSpeed } from '../shared/speed.ts';

import * as db from './db.ts';
import { AUDIO_DIR } from './db.ts';
import * as audio from './audio-store.ts';
import { buildResumeContext } from './prompt.ts';
import type { ResumeContext } from './prompt.ts';
import { buildSessionPayload } from './realtime-session.ts';
import { gradeSession } from './grader.ts';
import { pollyConfigFromEnv } from './polly.ts';
import { pollyGrant as mintPollyGrant, pollyCredsFromEnv, usesSts } from './sts.ts';
import { googleTtsConfigFromEnv } from './google-tts.ts';
import { googleTokenSource, serviceAccountFromEnv } from './google-token.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const LESSON_DIR = join(ROOT, 'server', 'lessons');
const CHARACTER_DIR = join(ROOT, 'server', 'characters');
/** Asset Spine (.skel/.atlas.txt/.png) — nam ngoai public/ vi chung nang. */
const CHARACTER_ASSET_DIR = join(ROOT, 'character');
const PORT = Number(process.env.PORT || 3000);

if (!process.env.OPENAI_API_KEY) {
  console.error('\n  Thieu OPENAI_API_KEY.\n  Chay:  cp .env.example .env   roi dien key vao.\n');
  process.exit(1);
}

// ---------------------------------------------------------------- lessons

const lessons = new Map<string, Lesson>();

async function loadLessons(): Promise<void> {
  const files = (await readdir(LESSON_DIR)).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const lesson = JSON.parse(await readFile(join(LESSON_DIR, f), 'utf8')) as Lesson;
    lessons.set(lesson.id, lesson);
  }
  console.log(`  Da nap ${lessons.size} bai hoc: ${[...lessons.keys()].join(', ')}`);
}

// ------------------------------------------------------------- nhan vat

const characters = new Map<string, Character>();
let defaultCharacter = '';

/**
 * Nap nhan vat tu server/characters/*.json — cung loi voi bai hoc: them mot
 * nhan vat la them mot file roi restart, khong sua code.
 *
 * `"default": true` chon nhan vat mac dinh. Khong file nao khai thi lay cai
 * `sort` nho nhat — luon phai co MOT, vi client can mot cai de mo len ngay.
 */
async function loadCharacters(): Promise<void> {
  const files = (await readdir(CHARACTER_DIR)).filter((f) => f.endsWith('.json'));
  const marked: string[] = [];

  for (const f of files) {
    const raw = JSON.parse(await readFile(join(CHARACTER_DIR, f), 'utf8')) as Character & {
      default?: boolean;
    };
    const { default: isDefault, ...character } = raw;
    characters.set(character.code, character);
    if (isDefault) marked.push(character.code);
  }

  if (!characters.size) throw new Error(`Khong co nhan vat nao trong ${CHARACTER_DIR}`);
  if (marked.length > 1) {
    throw new Error(`Nhieu hon mot nhan vat khai "default": ${marked.join(', ')}`);
  }

  defaultCharacter =
    marked[0] ?? [...characters.values()].sort((a, b) => a.sort - b.sort)[0]!.code;

  console.log(
    `  Da nap ${characters.size} nhan vat: ${[...characters.keys()].join(', ')}` +
      ` (mac dinh: ${defaultCharacter})`
  );
}

/** Nhan vat theo code, roi ve mac dinh khi code la hoac khong con ton tai. */
function characterOr(code: string | null | undefined): Character {
  return characters.get(code ?? '') ?? characters.get(defaultCharacter)!;
}

// ---------------------------------------------------------------- helpers

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.glb': 'model/gltf-binary',
  '.txt': 'text/plain; charset=utf-8',
  '.skel': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Polly — tieng noi cua AI. null = chua bat, AI se hien chu ma khong co tieng.
 * Nga ra ngay luc khoi dong neu cau hinh sai, giong cach s3.ts lam.
 */
const polly = pollyConfigFromEnv();

/**
 * Credential cho client tu goi Polly trong hoi thoai.
 * null = chua cau hinh; AI se hien chu nhung khong co tieng.
 */
const pollyCreds = polly ? pollyCredsFromEnv(polly) : null;

if (polly && !pollyCreds) {
  console.warn(
    '  [polly] POLLY=on nhung thieu AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY —\n' +
      '          AI se hien chu ma khong co tieng.'
  );
}

// Duong thang khong co rao nao: credential day du quyen cua IAM user, khong
// han that, khong rang IP. Mot dong log de no la lua chon nhin thay duoc chu
// khong phai thu am tham xay ra vi quen dat mot bien.
if (pollyCreds && !usesSts(pollyCreds)) {
  console.warn(
    '  [polly] Khong co POLLY_STS_ROLE_ARN — dua thang credential AWS cua backend\n' +
      '          xuong browser. Chi dung cho demo; production thi dat role ARN.'
  );
}

/**
 * Google Cloud TTS — duong tieng noi mac dinh. null = chua bat.
 */
const googleTts = googleTtsConfigFromEnv();

/**
 * Service account de ky JWT doi lay access token. Nguon token co cache: token cua
 * Google song 1 tieng, mint mot cai moi cho tung khuc doc la vua cham vua tu dot
 * rate limit cua chinh minh.
 */
const googleSa = googleTts ? serviceAccountFromEnv() : null;
const googleTokens = googleSa ? googleTokenSource(googleSa) : null;

if (googleTts && !googleTokens) {
  console.warn(
    '  [google-tts] GOOGLE_TTS=on nhung thieu GOOGLE_TTS_SA_FILE / GOOGLE_TTS_SA_JSON —\n' +
      '               AI se hien chu ma khong co tieng.'
  );
}

/** Nha nao that su dung duoc. Buoi hoc xin mode nao cung phai qua day. */
const ttsAvailable = {
  polly: Boolean(polly && pollyCreds),
  google: Boolean(googleTts && googleTokens),
};

if (googleTokens) {
  // Token cua Google la bearer token cho CA service account, song 1 tieng, khong
  // rang duoc vao IP va khong siet duoc xuong rieng quyen doc chu (Cloud TTS
  // khong co scope nao hep hon `cloud-platform`, va Credential Access Boundary
  // chi ap cho Cloud Storage). Ba viec chan thiet hai that su deu nam NGOAI code
  // nay, nen no phai la mot dong log nhin thay duoc chu khong phai mot gia dinh.
  console.warn(
    '  [google-tts] Access token gui xuong browser khong rang duoc vao IP va mang\n' +
      '               du quyen cua service account. Bat buoc: project rieng chi chua\n' +
      '               TTS, SA khong co quyen gi khac, quota cap + budget alert o cap\n' +
      '               project.'
  );
}

/**
 * Rate limit cap token theo userId (B4 cua docs/webrtc-migration.md).
 *
 * Cai duy nhat trong bon lop bao ve nam duoc trong code. Khong chan duoc nguoi
 * da cam token trong tay — token nao cung goi Google truc tiep — nhung chan duoc
 * viec mot thiet bi xin HANG NGHIN token khac nhau, tuc la chan duong bien mot
 * tai khoan thanh mot voi cap token cong khai.
 *
 * Cua so truot don gian trong RAM: mat khi restart, khong chia duoc giua nhieu
 * instance. Dung muc do do la co y — no chan cai no phai chan, va mot cai
 * chinh xac hon thi phai co Redis.
 */
const TOKEN_RATE_WINDOW_MS = 60_000;
const TOKEN_RATE_MAX = 20;
const tokenMints = new Map<string, number[]>();

function allowTokenMint(userId: string): boolean {
  const now = Date.now();
  const recent = (tokenMints.get(userId) ?? []).filter((t) => now - t < TOKEN_RATE_WINDOW_MS);
  if (recent.length >= TOKEN_RATE_MAX) {
    tokenMints.set(userId, recent);
    return false;
  }
  recent.push(now);
  tokenMints.set(userId, recent);
  // Don rac: khong co cho nay thi Map giu moi userId tung ghe qua, vinh vien.
  if (tokenMints.size > 10_000) {
    for (const [id, stamps] of tokenMints) {
      if (stamps.every((t) => now - t >= TOKEN_RATE_WINDOW_MS)) tokenMints.delete(id);
    }
  }
  return true;
}

/**
 * IP that cua client, de rang credential Polly vao no.
 *
 * `x-forwarded-for` co the la mot chuoi qua nhieu proxy — phan tu DAU la client
 * that. Chi tin duoc khi dung sau reverse proxy minh kiem soat; neu khong thi
 * bat ky ai cung tu khai duoc IP, va het duong rang buoc.
 */
function clientIp(req: IncomingMessage): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (first) return first.split(',')[0]?.trim() ?? null;
  return req.socket.remoteAddress ?? null;
}

/**
 * Quyen goi nha TTS cho mot thiet bi, theo mode cua buoi hoc.
 *
 * null khi chua cau hinh, hoac khi nha do tu choi — hong duong nay khong duoc
 * lam hong ca buoi hoc, AI van hien chu. Mode `openai` cung tra null: o do AI tu
 * phat tieng, khong ai can grant.
 */
async function ttsGrantFor(
  req: IncomingMessage,
  userId: string,
  mode: VoiceMode,
  character?: Character
): Promise<TtsGrant | null> {
  switch (clientTtsProvider(mode)) {
    case 'google':
      return googleGrantFor(userId, character);
    case 'polly':
      return pollyGrantFor(req, userId, character);
    default:
      return null;
  }
}

/**
 * Mode dung cho nut "doc lai" o man tong ket.
 *
 * Khac mode cua buoi hoc o mot cho: buoi hoc mode `openai` khong chon nha TTS nao
 * ca (AI tu noi), nhung man tong ket thi KHONG co stream WebRTC nua — muon nghe
 * lai mot cau thi phai co mot nha doc no. Nen o day roi ve nha dang chay duoc,
 * bat ke buoi hoc do da noi bang gi.
 */
function replayVoiceMode(stored: string): VoiceMode {
  const mode = normalizeVoiceMode(stored);
  const wanted = aiSpeaksItself(mode) ? VOICE_MODE_DEFAULT : mode;
  return effectiveVoiceMode(wanted, ttsAvailable);
}

async function pollyGrantFor(
  req: IncomingMessage,
  userId: string,
  character?: Character
): Promise<TtsGrant | null> {
  if (!polly || !pollyCreds) return null;
  try {
    // Giong cua nhan vat de len mac dinh trong env: POLLY_VOICE gio chi con
    // la phuong an cuoi cho truong hop khong biet nhan vat nao.
    const cfg = character ? { ...polly, ...character.voice } : polly;
    return await mintPollyGrant(cfg, pollyCreds, {
      sessionName: userId,
      sourceIp: clientIp(req),
    });
  } catch (err) {
    console.warn('[polly] khong cap duoc credential tam:', errorMessage(err));
    return null;
  }
}

/**
 * Quyen goi Google TTS.
 *
 * Khong nhan `req`: token cua Google khong rang duoc vao IP nao (khong co
 * `aws:SourceIp`, khong co session policy) nen IP cua client khong dung duoc vao
 * viec gi o day. Do la mat mat that su cua viec doi nha — xem dau
 * `server/google-token.ts`.
 */
async function googleGrantFor(userId: string, character?: Character): Promise<TtsGrant | null> {
  if (!googleTts || !googleTokens) return null;
  if (!allowTokenMint(userId)) {
    console.warn(`[google-tts] ${userId} xin token qua day, tam tu choi.`);
    return null;
  }
  try {
    const { accessToken, expiresAt } = await googleTokens.token();
    return {
      provider: 'google',
      accessToken,
      expiresAt,
      // Giong cua nhan vat de len GOOGLE_TTS_VOICE. Thieu `voiceGoogle` thi ca
      // bon nhan vat noi cung mot giong — chay duoc, nhung do la phai dien.
      voice: character?.voiceGoogle ?? googleTts.voice,
    };
  } catch (err) {
    console.warn('[google-tts] khong cap duoc access token:', errorMessage(err));
    return null;
  }
}

// -------------------------------------------------------------- danh tinh
//
// Chua co dang nhap: moi thiet bi duoc cap mot id ngau nhien luu trong cookie
// httpOnly. Xoa cookie la co han muc moi — day la gioi han co huu cua cach
// nay, khong phai loi. No chan duoc nguoi dung binh thuong, khong chan duoc
// nguoi co tinh; muon chat hon thi phai co dang nhap that.

const DEVICE_COOKIE = 'did';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

function parseCookies(header = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Lay device id, cap moi neu chua co. Phai goi truoc khi ghi header. */
function deviceId(req: IncomingMessage, res: ServerResponse): string {
  const existing = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
  if (existing) return existing;

  const id = randomUUID();
  res.setHeader(
    'Set-Cookie',
    `${DEVICE_COOKIE}=${id}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`
  );
  return id;
}

/**
 * Them Set-Cookie ma khong de len cookie da co.
 *
 * `deviceId()` cung ghi Set-Cookie, va `res.setHeader` thi GHI DE chu khong
 * noi them — cap cookie nghe lai bang setHeader se lam mat luon cookie `did`
 * cua thiet bi vua duoc cap.
 */
function appendCookies(res: ServerResponse, cookies: string[]): void {
  if (!cookies.length) return;
  const existing = res.getHeader('Set-Cookie');
  const before = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  res.setHeader('Set-Cookie', [...before, ...cookies]);
}

/**
 * Client native khong co cookie jar tu nhien, nen phai ky thang vao URL.
 * Nhan dien bang chinh header ma mobile dung de dinh danh.
 */
const isNativeClient = (req: IncomingMessage): boolean => Boolean(req.headers['x-device-id']);

function sendJSON(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req: IncomingMessage, limitBytes = 25 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new HttpError(413, 'Payload qua lon');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Body JSON den tu mang, nen kieu tra ve la `any` mot cach co y thuc: moi
 * route tu chiu trach nhiem kiem gia tri no doc ra. Bọc thanh kieu chat hon o
 * day chi tao cam giac an toan gia, vi khong ai xac minh du lieu that ca.
 */
async function readJSON(req: IncomingMessage): Promise<any> {
  const buf = await readBody(req, 1024 * 1024);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON khong hop le');
  }
}

class HttpError extends Error {
  status: number;
  /** Du lieu may doc duoc (vd han muc con lai) di kem cau bao loi. */
  detail: Record<string, unknown> | null;

  constructor(status: number, message: string, detail: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** `catch (err)` cho ra `unknown` duoi strict — day la cho boc no mot lan. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requireSession(id: string): { session: db.SessionRow; lesson: Lesson } {
  const session = db.getSession(id);
  if (!session) throw new HttpError(404, 'Khong tim thay session');
  const lesson = lessons.get(session.lesson_id);
  if (!lesson) throw new HttpError(500, `Bai hoc "${session.lesson_id}" khong con ton tai`);
  return { session, lesson };
}

function serveStatic(res: ServerResponse, filePath: string): void {
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
  stream.on('open', () => {
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
  });
  stream.pipe(res);
}

// ---------------------------------------------------------------- OpenAI

/**
 * Mint ephemeral client secret.
 *
 * Toan bo cau hinh session (instructions, tools, VAD, transcription, mode
 * giong) duoc nhung thang vao token o server. Browser chi nhan duoc mot chuoi
 * secret ngan han va khong sua duoc luat bai hoc.
 *
 * Hinh dang cua `session` nam o `realtime-session.ts` de test duoc mot minh.
 */
async function mintClientSecret({
  lesson,
  progress,
  resume,
  character,
  voiceMode,
}: {
  lesson: Lesson;
  progress: ProgressRecord[];
  resume: ResumeContext | null;
  character: Character;
  voiceMode: VoiceMode;
}): Promise<{ value: string; expiresAt: number; model: string }> {
  const model = process.env.REALTIME_MODEL || 'gpt-realtime';

  const payload = buildSessionPayload({
    model,
    lesson,
    progress,
    resume,
    character,
    voiceMode,
    // Toc do khoi diem cua mode `openai`. Slider cua nguoi hoc chua toi duoc
    // server, nen client gui `session.update` ngay sau khi bat tay neu no dang
    // de khac — xem `public/src/session.ts::#applyRate`.
    speed: clampSpeed(lesson.speed) * character.speed,
  });

  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 600);
    console.error('[token] OpenAI tu choi:', res.status, detail);
    throw new HttpError(502, `Khong mint duoc token (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as { value: string; expires_at: number };
  return { value: data.value, expiresAt: data.expires_at, model };
}

// ------------------------------------------------------------- cuong che
//
// Ba lop cat doc lap, hong mot lop van con hai lop kia:
//   1. Tu choi cap token khi da het gio  -> khong mo duoc buoi moi
//   2. Hen gio hangup khi het han muc    -> chot chan cung
//   3. Kenh presence dut -> hangup       -> dong tab / mat mang thi cat ngay
//
// Lop 3 phai CAT chu khong duoc chi "ngung dem". Kenh presence va cuoc goi
// WebRTC la hai ket noi doc lap: neu mat presence chi lam dong ho dung lai
// thi client sua vai dong co the dong presence ma van giu WebRTC chay, thanh
// ra goi mien phi vo han. Khong tin, ma cat.

/** Route tra ve gia tri nay khi no da tu ghi response (SSE). */
const HANDLED = Symbol('handled');

/**
 * `params` la cac nhom bat duoc tu regex cua route. Da khop pattern thi chung
 * chac chan ton tai, nen kieu la string chu khong phai string | undefined.
 */
interface Route {
  method: 'GET' | 'POST';
  pattern: RegExp;
  handler: (
    req: IncomingMessage,
    params: string[],
    res: ServerResponse
  ) => unknown | Promise<unknown>;
}

interface LiveCall {
  timer: NodeJS.Timeout | null;
  graceTimer: NodeJS.Timeout | null;
  sessionId: string;
  userId: string;
}

/**
 * Cac cuoc goi dang chay. Day la thu duy nhat nam trong RAM, va no tai tao
 * duoc tu bang `call` — xem reschedulePendingCalls().
 */
const liveCalls = new Map<string, LiveCall>();

/** Bao lau sau khi mat presence thi moi that su cat, de EventSource kip noi lai. */
const PRESENCE_GRACE_MS = 15_000;

type HangupReason = 'quota' | 'gone' | 'client';

async function hangup(callId: string, reason: HangupReason): Promise<void> {
  const entry = liveCalls.get(callId);
  if (entry?.timer) clearTimeout(entry.timer);
  if (entry?.graceTimer) clearTimeout(entry.graceTimer);
  liveCalls.delete(callId);

  // Dong ban ghi truoc: du OpenAI co tu choi thi gio van phai duoc tru.
  const closed = db.endCall(callId, reason);
  if (!closed) return;

  try {
    const res = await fetch(`https://api.openai.com/v1/realtime/calls/${callId}/hangup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });
    if (!res.ok && res.status !== 404) {
      console.warn(`[quota] hangup ${callId} that bai:`, res.status, (await res.text()).slice(0, 200));
    }
  } catch (err) {
    console.warn(`[quota] hangup ${callId} loi mang:`, errorMessage(err));
  }
}

/** Hen chuong cat cuoc goi khi dung het phan gio con lai. */
function scheduleHangup(
  callId: string,
  sessionId: string,
  userId: string,
  remainingMs: number
): void {
  const prev = liveCalls.get(callId);
  if (prev?.timer) clearTimeout(prev.timer);
  if (prev?.graceTimer) clearTimeout(prev.graceTimer);

  const timer = setTimeout(() => void hangup(callId, 'quota'), Math.max(0, remainingMs));
  timer.unref?.();
  liveCalls.set(callId, { timer, graceTimer: null, sessionId, userId });
}

/** Presence dut: cho an han roi cat, vi EventSource tu ket noi lai. */
function onPresenceLost(callId: string): void {
  const entry = liveCalls.get(callId);
  if (!entry || entry.graceTimer) return;

  const graceTimer = setTimeout(() => void hangup(callId, 'gone'), PRESENCE_GRACE_MS);
  graceTimer.unref?.();
  liveCalls.set(callId, { ...entry, graceTimer });
}

function onPresenceBack(callId: string): void {
  const entry = liveCalls.get(callId);
  if (!entry?.graceTimer) return;
  clearTimeout(entry.graceTimer);
  liveCalls.set(callId, { ...entry, graceTimer: null });
}

/**
 * Server restart lam mat het setTimeout. Cac moc thoi gian thi van nam trong
 * DB, nen dung do dung lai chuong — khong co gi that su la trang thai RAM.
 */
function reschedulePendingCalls() {
  for (const call of db.openCalls()) {
    const { remainingMs } = db.quotaFor(call.user_id);
    if (remainingMs <= 0) {
      hangup(call.id, 'quota');
      continue;
    }
    // Chua ai gan lai presence sau restart, nen vao thang che do an han.
    scheduleHangup(call.id, call.session_id, call.user_id, remainingMs);
    onPresenceLost(call.id);
  }
}

// ---------------------------------------------------------------- routes

/**
 * Ung vien giong Chirp3-HD de nghe thu.
 *
 * KHONG ghi chu nam/nu o day, va do la co y: doan gioi tinh tu ten sao la doan,
 * ma ca trang nay ton tai chinh vi muc dich khong doan nua. Nghe roi tu xep.
 */
const AUDITION_VOICES = [
  'Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam', 'Aoede',
  'Autonoe', 'Callirrhoe', 'Charon', 'Despina', 'Enceladus', 'Erinome',
  'Fenrir', 'Gacrux', 'Iapetus', 'Kore', 'Laomedeia', 'Leda',
  'Orus', 'Puck', 'Pulcherrima', 'Rasalgethi', 'Sadachbia', 'Schedar',
  'Sulafat', 'Umbriel', 'Vindemiatrix', 'Zephyr',
];

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Trang nghe thu, viet thang thanh HTML.
 *
 * Khong nam trong `public/` vi khong muon no di theo bundle cua app: day la mot
 * cai thuoc do dung mot lan roi tat, khong phai mot phan cua san pham.
 */
function auditionPage(): string {
  const current = [...characters.values()]
    .sort((a, b) => a.sort - b.sort)
    .map((c) => `${c.name}: ${c.voiceGoogle?.name ?? '(chua map)'}`)
    .join(' · ');

  return `<!doctype html>
<meta charset="utf-8"><title>Nghe thu giong Google</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 46rem; padding: 0 1rem; }
  h1 { font-size: 1.2rem; }
  .warn { background: #fff6e5; border-left: 3px solid #e0a000; padding: .6rem .8rem; }
  textarea { width: 100%; font: inherit; }
  ul { list-style: none; padding: 0; display: grid; gap: .3rem;
       grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); }
  button { font: inherit; cursor: pointer; text-align: left; padding: .4rem .6rem; width: 100%; }
  #err { color: #b00; white-space: pre-wrap; }
</style>
<h1>Nghe thu giong Google Chirp3-HD</h1>
<p class="warn">Mỗi lần bấm là một lần gọi Google thật và một lần trả tiền.
Trang này bật bằng <code>GOOGLE_TTS_AUDITION=on</code> — tắt lại khi xong.</p>
<p><small>Đang map: ${escapeHtml(current)}</small></p>
<p>Câu đọc thử:</p>
<textarea id="text" rows="2">Hi! I'm here to help you practise English. What would you like to talk about today?</textarea>
<p id="err"></p>
<ul id="list"></ul>
<script>
const VOICES = ${JSON.stringify(AUDITION_VOICES)};
const err = document.getElementById('err');
let grant = null;

async function ensureGrant() {
  if (grant && grant.expiresAt - Date.now() > 60000) return grant;
  const res = await fetch('/dev/voices/grant', { method: 'POST' });
  const body = await res.json();
  if (!body.ttsGrant) throw new Error('Server khong cap duoc token. GOOGLE_TTS da bat chua?');
  grant = body.ttsGrant;
  return grant;
}

async function speak(name, button) {
  err.textContent = '';
  const label = button.textContent;
  button.disabled = true;
  button.textContent = label + ' …';
  try {
    const g = await ensureGrant();
    const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + g.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: document.getElementById('text').value },
        voice: { languageCode: 'en-US', name },
        audioConfig: { audioEncoding: 'MP3' },
      }),
    });
    const body = await res.json();
    if (!body.audioContent) throw new Error(JSON.stringify(body).slice(0, 300));
    const bytes = Uint8Array.from(atob(body.audioContent), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
    const audio = new Audio(url);
    await audio.play();
    audio.onended = () => URL.revokeObjectURL(url);
  } catch (e) {
    err.textContent = String(e && e.message ? e.message : e);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

const list = document.getElementById('list');
for (const short of VOICES) {
  const name = 'en-US-Chirp3-HD-' + short;
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.textContent = '▶ ' + short;
  button.onclick = () => speak(name, button);
  li.append(button);
  list.append(li);
}
</script>`;
}

const routes: Route[] = [
  /**
   * Trang nghe thu giong, de chot mapping giong cho bon nhan vat BANG TAI.
   *
   * Ly do ton tai: khong ai chon duoc giong tu mot bang gia. `docs/webrtc-
   * migration.md` muc 5 ghi thang rui ro "doi TTS = doi giong nhan vat, user cu
   * nhan ra" va cach xu ly la nghe thu ca bon truoc khi chot — day la cho de lam
   * viec do trong mot lan ngoi.
   *
   * TAT MAC DINH. Moi lan bam la mot lan goi Google that va mot lan tra tien, va
   * duong nay khong doi session nao ca — no cap grant cho bat cu ai mo duoc URL.
   * Bat bang `GOOGLE_TTS_AUDITION=on` khi can, roi tat lai.
   */
  {
    method: 'GET',
    pattern: /^\/dev\/voices$/,
    handler: (_req, _params, res) => {
      if ((process.env.GOOGLE_TTS_AUDITION ?? 'off') !== 'on') {
        throw new HttpError(404, 'Khong co endpoint nay');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(auditionPage());
      return HANDLED;
    },
  },

  /** Grant de trang nghe thu tu goi Google. Cung mot cong tac voi trang tren. */
  {
    method: 'POST',
    pattern: /^\/dev\/voices\/grant$/,
    handler: async (req) => {
      if ((process.env.GOOGLE_TTS_AUDITION ?? 'off') !== 'on') {
        throw new HttpError(404, 'Khong co endpoint nay');
      }
      // Mot id co dinh cho ca trang: rate limit o day chi de mot tab bi ket
      // trong vong lap khong dot het quota, khong phai de phan biet ai.
      return { ttsGrant: await googleGrantFor('dev-audition') };
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/lessons$/,
    handler: () => [...lessons.values()],
  },

  {
    method: 'GET',
    pattern: /^\/api\/lessons\/([\w-]+)$/,
    handler: (_req, [id]) => {
      const lesson = lessons.get(id);
      if (!lesson) throw new HttpError(404, 'Khong tim thay bai hoc');
      return lesson;
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/characters$/,
    handler: (): CharacterList => ({
      characters: [...characters.values()].sort((a, b) => a.sort - b.sort),
      defaultCode: defaultCharacter,
    }),
  },

  {
    method: 'GET',
    pattern: /^\/api\/sessions$/,
    handler: () =>
      db.listSessions().map((s) => ({
        id: s.id,
        lessonId: s.lesson_id,
        lessonTitle: lessons.get(s.lesson_id)?.title ?? s.lesson_id,
        status: s.status,
        startedAt: s.started_at,
        endedAt: s.ended_at,
        messageCount: s.message_count,
        overall: s.summary_json ? JSON.parse(s.summary_json).overall : null,
      })),
  },

  {
    method: 'POST',
    pattern: /^\/api\/sessions$/,
    handler: async (req, _params, res) => {
      const { lessonId, characterCode, voiceMode } = await readJSON(req);
      if (!lessons.has(lessonId)) throw new HttpError(400, 'lessonId khong hop le');

      // Chan o SERVER chu khong an nut o client: nut an di thi mot request
      // gui tay van mo duoc buoi hoc voi nhan vat tra phi.
      const character = characterOr(characterCode);
      if (character.tier === 'paid') {
        throw new HttpError(402, `Nhan vat "${character.name}" danh cho ban tra phi`, {
          code: 'character_paid',
          characterCode: character.code,
        });
      }

      // Chot MOT LAN o day cho ca buoi. Mode khong doi giua chung: doi no la
      // doi output_modalities, ma cai do chi cai lai duoc bang mot lan bat tay
      // WebRTC moi — va nua buoi hoc mot giong cung khong phai thu ai muon.
      //
      // Loc qua `effectiveVoiceMode` NGAY TAI DAY, truoc khi ghi vao DB: mot mode
      // tro toi nha chua cau hinh se lang le khong co tieng (grant null la trang
      // thai hop le), nen no phai bi doi thanh mode chay duoc truoc khi thanh
      // thuoc tinh co dinh cua buoi hoc.
      const mode = effectiveVoiceMode(normalizeVoiceMode(voiceMode), ttsAvailable);

      const session = db.createSession(
        randomUUID(),
        lessonId,
        deviceId(req, res),
        character.code,
        mode
      );
      return { sessionId: session.id, lesson: lessons.get(lessonId), character, voiceMode: mode };
    },
  },

  /** Han muc con lai cua thiet bi nay hom nay. */
  {
    method: 'GET',
    pattern: /^\/api\/quota$/,
    handler: (req, _params, res) => db.quotaFor(deviceId(req, res)),
  },

  /**
   * Client bao da bat tay xong WebRTC, kem call_id lay tu header Location.
   * Tu day server moi hen duoc chuong cat.
   */
  {
    method: 'POST',
    pattern: /^\/api\/sessions\/([\w-]+)\/call$/,
    handler: async (req, [id]) => {
      const { session } = requireSession(id);
      const { callId } = await readJSON(req);
      if (!callId) throw new HttpError(400, 'Thieu callId');

      db.startCall(callId, id, session.user_id);
      const quota = db.quotaFor(session.user_id);

      // Lop 2: chot chan cung. Het phan gio con lai la cat, bat ke client
      // con song hay khong.
      scheduleHangup(callId, id, session.user_id, quota.remainingMs);
      return quota;
    },
  },

  /**
   * Kenh presence. Giu mo suot cuoc goi; dut la server biet client bien mat.
   *
   * Dung SSE chu khong phai WebSocket: du an khong co dependency nao va Node
   * khong co san WS server. Thu can o day chi la "TCP con mo khong" cong voi
   * mot chieu day tin xuong — SSE lam du ca hai bang node:http tran.
   */
  {
    method: 'GET',
    pattern: /^\/api\/calls\/([\w-]+)\/presence$/,
    handler: (req, [callId], res) => {
      const call = db.getCall(callId);
      if (!call) throw new HttpError(404, 'Khong tim thay cuoc goi');

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const push = (event: 'sync' | 'ended', data: unknown): void => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      onPresenceBack(callId);
      push('sync', db.quotaFor(call.user_id));

      // Nan lai dong ho client dinh ky. Client tu dem tung giay giua cac lan
      // nan, nen day co the thua — 15s la du de tab ngu day khong lech lau.
      const sync = setInterval(() => {
        const current = db.getCall(callId);
        if (current?.ended_at) {
          push('ended', { reason: current.end_reason });
          clearInterval(sync);
          res.end();
          return;
        }
        push('sync', db.quotaFor(call.user_id));
      }, 15_000);
      sync.unref?.();

      res.on('close', () => {
        clearInterval(sync);
        // Lop 3: khong tin, ma cat. Co an han de EventSource kip noi lai.
        onPresenceLost(callId);
      });

      return HANDLED;
    },
  },

  /** Client chu dong dung: dong ban ghi ngay thay vi doi chuong. */
  {
    method: 'POST',
    pattern: /^\/api\/calls\/([\w-]+)\/end$/,
    handler: (_req, [callId]) => {
      const entry = liveCalls.get(callId);
      if (entry?.timer) clearTimeout(entry.timer);
      if (entry?.graceTimer) clearTimeout(entry.graceTimer);
      liveCalls.delete(callId);
      db.endCall(callId, 'client');
      const call = db.getCall(callId);
      return call ? db.quotaFor(call.user_id) : { ok: true };
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/sessions\/([\w-]+)$/,
    handler: async (req, [id], res) => {
      const { session, lesson } = requireSession(id);

      // Man tong ket la cho duy nhat nghe lai, nen cap quyen nghe ngay tai day
      // thay vi de client phai xin them mot vong nua.
      appendCookies(res, audio.playbackCookies(id));
      const signed = isNativeClient(req);

      return {
        // Nghe lai cau AI bang cach doc lai (khi khong bat luu mp3). Credential
        // cua buoi hoc do da het han tu lau nen phai la ban moi.
        //
        // Buoi hoc mode `openai` khong co grant nao ca, nen o day xin theo mode
        // CHAY DUOC gan nhat thay vi mode cua buoi: nut "doc lai" van phai bam
        // duoc. Buoi hoc cu (cot voice_mode rong) cung roi vao duong nay.
        character: characterOr(session.character_code),
        ttsGrant: await ttsGrantFor(
          req,
          session.user_id,
          replayVoiceMode(session.voice_mode),
          characterOr(session.character_code)
        ),
        sessionId: session.id,
        status: session.status,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        hintCount: session.hint_count,
        lesson,
        messages: db.listMessages(id).map(({ audioPath, audioStore, ...m }) => ({
          ...m,
          audioUrl: audioPath ? audio.playbackUrl(audioStore, audioPath, signed) : null,
        })),
        progress: db.listProgress(id),
        summary: session.summary_json ? JSON.parse(session.summary_json) : null,
      };
    },
  },

  /**
   * Cap token cho ket noi WebRTC.
   * resume=true: nhet lich su da nen vao instructions va tra ve seedItems
   * de client bom lai vai luot gan nhat vao conversation moi.
   */
  {
    method: 'POST',
    pattern: /^\/api\/sessions\/([\w-]+)\/token$/,
    handler: async (req, [id]) => {
      const { session, lesson } = requireSession(id);
      if (session.status === 'ended') throw new HttpError(409, 'Buoi hoc nay da ket thuc');

      // Lop 1: het gio thi khong cap token. Khong co token thi khong bat tay
      // WebRTC duoc, nen day chan duoc moi buoi goi moi.
      const quota = db.quotaFor(session.user_id);
      if (quota.remainingMs <= 0) {
        throw new HttpError(429, 'Het thoi luong mien phi hom nay', {
          code: 'quota_exhausted',
          ...quota,
        });
      }

      const { resume } = await readJSON(req);
      const progress = db.listProgress(id);

      let resumeContext = null;
      if (resume) {
        resumeContext = buildResumeContext(lesson, db.listMessages(id), progress);
      }

      const character = characterOr(session.character_code);
      // Doc tu DB chu khong tu request: mode la thu client khong duoc phep
      // doi giua buoi, cung ly do voi instructions.
      // `effectiveVoiceMode` mot lan nua chu khong tin cot DB: buoi hoc co the da
      // duoc tao luc Google con bat, roi server restart voi cau hinh khac. Khong
      // loc lai thi reconnect vao mot buoi nhu vay se im lang.
      const voiceMode = effectiveVoiceMode(
        normalizeVoiceMode(session.voice_mode),
        ttsAvailable
      );
      const secret = await mintClientSecret({
        lesson,
        progress,
        resume: resumeContext,
        character,
        voiceMode,
      });
      return {
        clientSecret: secret.value,
        expiresAt: secret.expiresAt,
        model: secret.model,
        seedItems: resumeContext?.seedItems ?? [],
        progress,
        // Cap lai moi lan xin token: buoi hoc dai hon han cua grant, hoac
        // reconnect sau khi treo may lau, thi quyen ghi cu da het han.
        uploadGrant: audio.uploadGrant(id),
        // Ky MOT LAN cho ca buoi. Han 1 tieng, dai hon moi buoi hoc, nen client
        // khong phai hoi lai giua chung — do la ca diem cua viec cap credential
        // thay vi ky tung cau.
        //
        // Cap o CA BA mode: mode `openai` khong dung nha TTS nao de noi trong
        // buoi, nhung man tong ket van co nut "doc lai".
        ttsGrant: await ttsGrantFor(req, session.user_id, replayVoiceMode(session.voice_mode), character),
        character,
        voiceMode,
      };
    },
  },

  /**
   * Cap lai rieng quyen goi nha TTS, khong dung chung duong voi `/token`.
   *
   * Grant chet giua buoi la chuyen thuong: token Google song 1 tieng, con
   * credential Polly thi rang vao IP nen doi Wi-Fi <-> 4G la het — chuyen xay ra
   * lien tuc tren mobile. Di lai `/token` chi de lay grant thi mint thua mot
   * client secret cua OpenAI va dung lai ca ngu canh resume, tat ca deu bi vut di.
   *
   * Duong cu `/polly` giu nguyen ben duoi de client da cai san khong hong.
   */
  {
    method: 'POST',
    pattern: /^\/api\/sessions\/([\w-]+)\/(?:tts|polly)$/,
    handler: async (req, [id]) => {
      const { session } = requireSession(id);
      const quota = db.quotaFor(session.user_id);
      if (quota.remainingMs <= 0) {
        throw new HttpError(429, 'Het thoi luong mien phi hom nay', {
          code: 'quota_exhausted',
          ...quota,
        });
      }
      return {
        ttsGrant: await ttsGrantFor(
          req,
          session.user_id,
          replayVoiceMode(session.voice_mode),
          characterOr(session.character_code)
        ),
      };
    },
  },

  {
    method: 'POST',
    pattern: /^\/api\/sessions\/([\w-]+)\/messages$/,
    handler: async (req, [id]) => {
      requireSession(id);
      const { seq, role, text, durationMs } = await readJSON(req);
      if (typeof seq !== 'number' || !['user', 'assistant'].includes(role)) {
        throw new HttpError(400, 'seq hoac role khong hop le');
      }
      db.saveMessage(id, { seq, role, text, durationMs });
      return { ok: true };
    },
  },

  /**
   * Gan audio vao mot message. Client goi ngay khi cat xong, khong doi cuoi buoi.
   *
   * Hai duong vao, phan biet bang Content-Type:
   *
   *   application/json  — client da day thang len S3, day chi la xac nhan.
   *   audio/wav         — raw WAV, server ghi xuong dia (mac dinh, va la duong
   *                       roi ve khi khong cau hinh S3).
   *
   * Duong disk giu lai chu khong xoa: buoi hoc cu van nghe lai duoc, va S3
   * hong thi con cho ma lui ve.
   */
  {
    method: 'POST',
    pattern: /^\/api\/sessions\/([\w-]+)\/messages\/(\d+)\/audio$/,
    handler: async (req, [id, seqRaw]) => {
      requireSession(id);
      const seq = Number(seqRaw);

      if (req.headers['content-type']?.includes('application/json')) {
        const { key, role: rawRole, bytes, durationMs } = await readJSON(req);
        const role = rawRole === 'assistant' ? 'assistant' : 'user';

        // Khong tin key client gui: dung lai tu (sessionId, seq, role) roi doi
        // chieu. Policy da chan ghi ra ngoai prefix cua session, cho nay chan
        // not viec gan nham file cua message khac trong cung session.
        let verified: string;
        try {
          verified = audio.verifyKey(id, seq, role, String(key));
        } catch (err) {
          throw new HttpError(400, errorMessage(err));
        }

        db.attachAudio(id, seq, verified, 's3', Number(durationMs) || null);
        return {
          ok: true,
          audioUrl: audio.playbackUrl('s3', verified, isNativeClient(req)),
          bytes: Number(bytes) || null,
        };
      }

      const buf = await readBody(req);
      if (buf.length < 45) throw new HttpError(400, 'File audio rong');

      const role = req.headers['x-role'] === 'assistant' ? 'assistant' : 'user';
      const durationMs = Number(req.headers['x-duration-ms']) || null;

      await mkdir(join(AUDIO_DIR, id), { recursive: true });
      const relative = audio.diskPath(id, seq, role);
      await writeFile(join(AUDIO_DIR, relative), buf);

      db.attachAudio(id, seq, relative, 'disk', durationMs);
      return { ok: true, audioUrl: `/audio/${relative}`, bytes: buf.length };
    },
  },

  {
    method: 'POST',
    pattern: /^\/api\/sessions\/([\w-]+)\/progress$/,
    handler: async (req, [id]) => {
      const { lesson } = requireSession(id);
      const { objectiveId, status, evidence, messageSeq } = await readJSON(req);
      if (!lesson.objectives.some((o) => o.id === objectiveId)) {
        throw new HttpError(400, `objectiveId "${objectiveId}" khong thuoc bai hoc nay`);
      }
      db.saveProgress(id, { objectiveId, status, evidence, messageSeq });
      return { progress: db.listProgress(id) };
    },
  },

  {
    method: 'POST',
    pattern: /^\/api\/sessions\/([\w-]+)\/hint$/,
    handler: (_req, [id]) => {
      requireSession(id);
      db.incrementHintCount(id);
      return { ok: true };
    },
  },

  {
    method: 'POST',
    pattern: /^\/api\/sessions\/([\w-]+)\/end$/,
    handler: async (req, [id]) => {
      const { session, lesson } = requireSession(id);
      if (session.status === 'ended') {
        return { summary: JSON.parse(session.summary_json ?? 'null') };
      }

      const { reason } = await readJSON(req);

      const summary = await gradeSession({
        lesson,
        session,
        messages: db.listMessages(id),
        progress: db.listProgress(id),
      });

      db.endSession(id, reason ?? 'manual', summary);
      return { summary };
    },
  },
];

// ---------------------------------------------------------------- server

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const path = decodeURIComponent(url.pathname);

  try {
    for (const route of routes) {
      const match = path.match(route.pattern);
      if (!match) continue;
      if (req.method !== route.method) continue;
      const payload = await route.handler(req, match.slice(1), res);
      // Route tu quan ly response (vd SSE giu ket noi mo) thi tra ve HANDLED.
      if (payload === HANDLED) return;
      return sendJSON(res, 200, payload);
    }

    if (path.startsWith('/api/')) throw new HttpError(404, 'Khong co endpoint nay');

    // Asset Spine cua nhan vat (.skel / .atlas.txt / .png)
    if (path.startsWith('/character/')) {
      const rel = normalize(path.slice('/character/'.length));
      if (rel.startsWith('..')) throw new HttpError(400, 'Duong dan khong hop le');
      return serveStatic(res, join(CHARACTER_ASSET_DIR, rel));
    }

    // File audio da ghi
    if (path.startsWith('/audio/')) {
      const rel = normalize(path.slice('/audio/'.length));
      if (rel.startsWith('..')) throw new HttpError(400, 'Duong dan khong hop le');
      return serveStatic(res, join(AUDIO_DIR, rel));
    }

    // Static
    const rel = normalize(path === '/' ? 'index.html' : path.slice(1));
    if (rel.startsWith('..')) throw new HttpError(400, 'Duong dan khong hop le');
    return serveStatic(res, join(PUBLIC_DIR, rel));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const detail = err instanceof HttpError ? err.detail : null;
    if (status >= 500) console.error(`[${req.method} ${path}]`, err);
    sendJSON(res, status, { error: errorMessage(err), ...(detail ?? {}) });
  }
});

await loadLessons();
await loadCharacters();
reschedulePendingCalls();
server.listen(PORT, () => {
  console.log(`\n  AI Learn (WebRTC) dang chay:  http://localhost:${PORT}\n`);
});
