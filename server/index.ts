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
  PollyGrant,
  ProgressRecord,
  Quota,
} from '../shared/types.ts';

import * as db from './db.ts';
import { AUDIO_DIR } from './db.ts';
import * as audio from './audio-store.ts';
import { buildInstructions, buildResumeContext, buildTranscriptionPrompt } from './prompt.ts';
import type { ResumeContext } from './prompt.ts';
import { buildTools } from './tools.ts';
import { gradeSession } from './grader.ts';
import { pollyConfigFromEnv } from './polly.ts';
import { pollyGrant as mintPollyGrant, stsConfigFromEnv } from './sts.ts';

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
 * STS de cap credential tam cho client tu goi Polly trong hoi thoai.
 * null = chua cau hinh; AI se hien chu nhung khong co tieng.
 */
const sts = stsConfigFromEnv();

if (polly && !sts) {
  console.warn(
    '  [polly] POLLY=on nhung chua co POLLY_STS_ROLE_ARN — AI se hien chu ma khong co tieng.'
  );
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
 * Quyen goi Polly cho mot thiet bi. null khi chua cau hinh, hoac khi STS tu
 * choi — hong duong nay khong duoc lam hong ca buoi hoc, AI van hien chu.
 */
async function pollyGrantFor(
  req: IncomingMessage,
  userId: string,
  character?: Character
): Promise<PollyGrant | null> {
  if (!polly || !sts) return null;
  try {
    // Giong cua nhan vat de len mac dinh trong env: POLLY_VOICE gio chi con
    // la phuong an cuoi cho truong hop khong biet nhan vat nao.
    const cfg = character ? { ...polly, ...character.voice } : polly;
    return await mintPollyGrant(cfg, sts, {
      sessionName: userId,
      sourceIp: clientIp(req),
    });
  } catch (err) {
    console.warn('[polly] khong cap duoc credential tam:', errorMessage(err));
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
 * Toan bo cau hinh session (instructions, tools, VAD, transcription) duoc nhung
 * thang vao token o server. Browser chi nhan duoc mot chuoi secret ngan han va
 * khong sua duoc luat bai hoc.
 */
async function mintClientSecret({
  lesson,
  progress,
  resume,
  character,
}: {
  lesson: Lesson;
  progress: ProgressRecord[];
  resume: ResumeContext | null;
  character: Character;
}): Promise<{ value: string; expiresAt: number; model: string }> {
  const model = process.env.REALTIME_MODEL || 'gpt-realtime';

  const payload = {
    session: {
      type: 'realtime',
      model,
      instructions: buildInstructions(lesson, { progress, resume, character }),
      // AI chi tra ve CHU. Tieng noi do client tu lay tu Amazon Polly, vi
      // Realtime API khong phat ra viseme/phoneme nao — nhep mom trong hoi
      // thoai chi con cach suy tu pho am thanh, dung nhip nhung sai am vi.
      // Doi lai: mat prosody cua giong Realtime, va them mot vong goi Polly.
      // Push-to-talk nen khong mat gi ve ngat loi — khong co barge-in de mat.
      output_modalities: ['text'],
      audio: {
        input: {
          // whisper-1 chu khong phai gpt-4o-transcribe: gpt-4o-transcribe la
          // model LLM, no rut gon va don dep loi hoc vien truoc khi tra chu ve
          // ("I want to order a cup of coffee. I like a cappuccino" -> "I wanna
          // order a coffee"). Voi app luyen noi thi do la mat du lieu: chinh cai
          // loi bi don di moi la thu can cham.
          //
          // Doi lai whisper bia dat tren doan ghi ngan, va `prompt` la thuoc
          // giai duy nhat o day — Realtime API khong nhan `temperature`.
          transcription: {
            model: 'whisper-1',
            language: 'en',
            prompt: buildTranscriptionPrompt(lesson),
          },
          // Push-to-talk: tat VAD hoan toan. Server khong doan luot noi va
          // khong tu tao response nua — client la noi duy nhat chot mot luot,
          // bang input_audio_buffer.commit + response.create gui tay khi user
          // tha nut. Bat VAD lai la AI se tu noi khi nghe thay tieng vong loa.
          turn_detection: null,
        },
        // Khong con nhanh `output`: giong va toc do gio thuoc ve Polly. Toc do
        // la `playbackRate` cua the <audio> nen doi duoc GIUA CHUNG mot cau,
        // thu ma session.update cua Realtime API khong bao gio cho.
      },
      tools: buildTools(lesson),
      tool_choice: 'auto',
    },
  };

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

const routes: Route[] = [
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
      const { lessonId, characterCode } = await readJSON(req);
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

      const session = db.createSession(randomUUID(), lessonId, deviceId(req, res), character.code);
      return { sessionId: session.id, lesson: lessons.get(lessonId), character };
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
        // Nghe lai cau AI bang cach doc lai bang Polly (khi khong bat luu mp3).
        // Credential cua buoi hoc do da het han tu lau nen phai la ban moi.
        character: characterOr(session.character_code),
        pollyGrant: await pollyGrantFor(req, session.user_id, characterOr(session.character_code)),
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
      const secret = await mintClientSecret({
        lesson,
        progress,
        resume: resumeContext,
        character,
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
        pollyGrant: await pollyGrantFor(req, session.user_id, character),
        character,
      };
    },
  },

  /**
   * Cap lai rieng quyen goi Polly, khong dung chung duong voi `/token`.
   *
   * Credential rang vao IP nen doi Wi-Fi <-> 4G la no chet — chuyen thuong
   * ngay tren mobile. Di lai `/token` chi de lay grant thi mint thua mot client
   * secret cua OpenAI va dung lai ca ngu canh resume, tat ca deu bi vut di.
   */
  {
    method: 'POST',
    pattern: /^\/api\/sessions\/([\w-]+)\/polly$/,
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
        pollyGrant: await pollyGrantFor(req, session.user_id, characterOr(session.character_code)),
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
