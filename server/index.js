import { createServer } from 'node:http';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import * as db from './db.js';
import { AUDIO_DIR } from './db.js';
import { buildInstructions, buildResumeContext } from './prompt.js';
import { buildTools } from './tools.js';
import { gradeSession } from './grader.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const LESSON_DIR = join(ROOT, 'server', 'lessons');
const PORT = Number(process.env.PORT || 3000);

if (!process.env.OPENAI_API_KEY) {
  console.error('\n  Thieu OPENAI_API_KEY.\n  Chay:  cp .env.example .env   roi dien key vao.\n');
  process.exit(1);
}

// ---------------------------------------------------------------- lessons

const lessons = new Map();

async function loadLessons() {
  const files = (await readdir(LESSON_DIR)).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const lesson = JSON.parse(await readFile(join(LESSON_DIR, f), 'utf8'));
    lessons.set(lesson.id, lesson);
  }
  console.log(`  Da nap ${lessons.size} bai hoc: ${[...lessons.keys()].join(', ')}`);
}

// ---------------------------------------------------------------- helpers

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limitBytes = 25 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new HttpError(413, 'Payload qua lon');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJSON(req) {
  const buf = await readBody(req, 1024 * 1024);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON khong hop le');
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireSession(id) {
  const session = db.getSession(id);
  if (!session) throw new HttpError(404, 'Khong tim thay session');
  const lesson = lessons.get(session.lesson_id);
  if (!lesson) throw new HttpError(500, `Bai hoc "${session.lesson_id}" khong con ton tai`);
  return { session, lesson };
}

function serveStatic(res, filePath) {
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
async function mintClientSecret({ lesson, progress, resume }) {
  const model = process.env.REALTIME_MODEL || 'gpt-realtime';

  const payload = {
    session: {
      type: 'realtime',
      model,
      instructions: buildInstructions(lesson, { progress, resume }),
      audio: {
        input: {
          // whisper-1 chu khong phai gpt-4o-transcribe: gpt-4o-transcribe la
          // model LLM, no rut gon va don dep loi hoc vien truoc khi tra chu ve
          // ("I want to order a cup of coffee. I like a cappuccino" -> "I wanna
          // order a coffee"). Voi app luyen noi thi do la mat du lieu: chinh cai
          // loi bi don di moi la thu can cham. whisper-1 ghi nguyen van.
          transcription: { model: 'whisper-1', language: 'en' },
          // Push-to-talk: tat VAD hoan toan. Server khong doan luot noi va
          // khong tu tao response nua — client la noi duy nhat chot mot luot,
          // bang input_audio_buffer.commit + response.create gui tay khi user
          // tha nut. Bat VAD lai la AI se tu noi khi nghe thay tieng vong loa.
          turn_detection: null,
        },
        output: { voice: process.env.REALTIME_VOICE || 'marin' },
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

  const data = await res.json();
  return { value: data.value, expiresAt: data.expires_at, model };
}

// ---------------------------------------------------------------- routes

const routes = [
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
    handler: async (req) => {
      const { lessonId } = await readJSON(req);
      if (!lessons.has(lessonId)) throw new HttpError(400, 'lessonId khong hop le');
      const session = db.createSession(randomUUID(), lessonId);
      return { sessionId: session.id, lesson: lessons.get(lessonId) };
    },
  },

  {
    method: 'GET',
    pattern: /^\/api\/sessions\/([\w-]+)$/,
    handler: (_req, [id]) => {
      const { session, lesson } = requireSession(id);
      return {
        sessionId: session.id,
        status: session.status,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        hintCount: session.hint_count,
        lesson,
        messages: db.listMessages(id),
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

      const { resume } = await readJSON(req);
      const progress = db.listProgress(id);

      let resumeContext = null;
      if (resume) {
        resumeContext = buildResumeContext(lesson, db.listMessages(id), progress);
      }

      const secret = await mintClientSecret({ lesson, progress, resume: resumeContext });
      return {
        clientSecret: secret.value,
        expiresAt: secret.expiresAt,
        model: secret.model,
        seedItems: resumeContext?.seedItems ?? [],
        progress,
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

  /** Nhan raw WAV cua tung message. Client upload ngay khi cat xong, khong doi cuoi buoi. */
  {
    method: 'POST',
    pattern: /^\/api\/sessions\/([\w-]+)\/messages\/(\d+)\/audio$/,
    handler: async (req, [id, seqRaw]) => {
      requireSession(id);
      const seq = Number(seqRaw);
      const buf = await readBody(req);
      if (buf.length < 45) throw new HttpError(400, 'File WAV rong');

      const role = req.headers['x-role'] === 'assistant' ? 'assistant' : 'user';
      const durationMs = Number(req.headers['x-duration-ms']) || null;

      const dir = join(AUDIO_DIR, id);
      await mkdir(dir, { recursive: true });
      const relative = join(id, `${String(seq).padStart(3, '0')}-${role}.wav`);
      await writeFile(join(AUDIO_DIR, relative), buf);

      db.attachAudio(id, seq, relative, durationMs);
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
      const messages = db.listMessages(id).map((m) => ({
        ...m,
        audioPath: m.audioUrl ? m.audioUrl.replace('/audio/', '') : null,
      }));

      const summary = await gradeSession({
        lesson,
        session,
        messages,
        progress: db.listProgress(id),
      });

      db.endSession(id, reason ?? 'manual', summary);
      return { summary };
    },
  },
];

// ---------------------------------------------------------------- server

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = decodeURIComponent(url.pathname);

  try {
    for (const route of routes) {
      const match = path.match(route.pattern);
      if (!match) continue;
      if (req.method !== route.method) continue;
      const payload = await route.handler(req, match.slice(1));
      return sendJSON(res, 200, payload);
    }

    if (path.startsWith('/api/')) throw new HttpError(404, 'Khong co endpoint nay');

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
    if (status >= 500) console.error(`[${req.method} ${path}]`, err);
    sendJSON(res, status, { error: err.message });
  }
});

await loadLessons();
server.listen(PORT, () => {
  console.log(`\n  AI Learn (WebRTC) dang chay:  http://localhost:${PORT}\n`);
});
