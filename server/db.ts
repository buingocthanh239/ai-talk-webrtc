import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  Message,
  ProgressRecord,
  ProgressStatus,
  Quota,
  Role,
  Summary,
  VoiceMode,
} from '../shared/types.ts';
import { VOICE_MODE_DEFAULT } from '../shared/voice-mode.ts';

// ---------------------------------------------------------------- hang DB
//
// node:sqlite tra ve hang dang Record<string, SQLOutputValue>. Khai bao hinh
// dang that o day roi ep kieu mot lan trong cac ham duoi, de phan con lai cua
// server lam viec voi kieu that thay vi doan mo.

export interface SessionRow {
  id: string;
  lesson_id: string;
  user_id: string;
  status: 'active' | 'ended';
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  hint_count: number;
  summary_json: string | null;
  /** `code` cua nhan vat AI. Rong = buoi hoc tao truoc khi co nhan vat. */
  character_code: string;
  /**
   * `openai` | `google` | `polly`. Rong = buoi hoc tao truoc khi co cot nay;
   * doc qua `normalizeVoiceMode()` la roi ve mac dinh hien tai (`google`).
   *
   * Khong co migration nao doi gia tri cu: cot nay chi duoc doc ra, khong duoc
   * so sanh voi hang so nao ngoai `shared/voice-mode.ts`, va buoi hoc da ket thuc
   * thi mode cua no chi con anh huong toi nut "doc lai" o man tong ket.
   */
  voice_mode: string;
}

export interface CallRow {
  id: string;
  session_id: string;
  user_id: string;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
}

export type SessionListRow = SessionRow & { message_count: number };

interface MessageRow {
  seq: number;
  role: Role;
  text: string;
  audio_path: string | null;
  audio_store: AudioStore;
  duration_ms: number | null;
}

/** Audio nam tren dia cua server hay tren S3. Ghi theo tung message chu khong
 * theo ca he thong: bat S3 giua chung thi cac buoi cu van nghe lai duoc. */
export type AudioStore = 'disk' | 's3';

/**
 * Message kem cho luu that. `audioUrl` khong tinh o day vi no phu thuoc CDN /
 * chu ky — `audio-store.ts` lo phan do, DB chi giu su that tho.
 */
export type StoredMessage = Message & {
  audioPath: string | null;
  audioStore: AudioStore;
};

interface ProgressRow {
  objective_id: string;
  status: ProgressStatus;
  evidence: string | null;
  message_seq: number | null;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');
export const AUDIO_DIR = join(DATA_DIR, 'audio');

mkdirSync(AUDIO_DIR, { recursive: true });

const db = new DatabaseSync(join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS session (
  id           TEXT PRIMARY KEY,
  lesson_id    TEXT NOT NULL,
  user_id      TEXT NOT NULL DEFAULT 'demo-user',
  status       TEXT NOT NULL DEFAULT 'active',   -- active | ended
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  end_reason   TEXT,
  hint_count   INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,
  character_code TEXT NOT NULL DEFAULT '',
  voice_mode   TEXT NOT NULL DEFAULT ''      -- openai | google | polly
);

CREATE TABLE IF NOT EXISTS message (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,                     -- user | assistant
  text        TEXT NOT NULL DEFAULT '',
  audio_path  TEXT,
  audio_store TEXT NOT NULL DEFAULT 'disk',       -- disk | s3
  duration_ms INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE TABLE IF NOT EXISTS progress (
  session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  objective_id TEXT NOT NULL,
  status       TEXT NOT NULL,                    -- pending | done | struggling
  evidence     TEXT,
  message_seq  INTEGER,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, objective_id)
);

-- Mot cuoc goi WebRTC toi OpenAI. Day la don vi tinh gio: han muc mien phi
-- tru theo thoi gian ket noi that, khong phai theo so luot noi.
CREATE TABLE IF NOT EXISTS call (
  id          TEXT PRIMARY KEY,                 -- call_id do OpenAI cap
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  end_reason  TEXT                              -- client | quota | gone | error
);

CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_call_user ON call(user_id, started_at);
`);

// CREATE TABLE IF NOT EXISTS khong dong them cot vao bang da co, nen DB tao
// truoc khi co S3 phai duoc va lai bang tay. Mac dinh 'disk' la dung: tat ca
// nhung gi ghi truoc do deu nam tren dia.
{
  const columns = db.prepare(`SELECT name FROM pragma_table_info('message')`).all() as unknown as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === 'audio_store')) {
    db.exec(`ALTER TABLE message ADD COLUMN audio_store TEXT NOT NULL DEFAULT 'disk'`);
  }
}

// Nhan vat AI va mode giong. Buoi hoc cu khong co hai cot nay; de trong roi de
// `characterOr()` / `normalizeVoiceMode()` roi ve mac dinh, hon la nhet san
// mot gia tri co the bien mat khi doi file.
{
  const columns = db.prepare(`SELECT name FROM pragma_table_info('session')`).all() as unknown as {
    name: string;
  }[];
  const has = (name: string): boolean => columns.some((c) => c.name === name);

  if (!has('character_code')) {
    db.exec(`ALTER TABLE session ADD COLUMN character_code TEXT NOT NULL DEFAULT ''`);
  }
  if (!has('voice_mode')) {
    db.exec(`ALTER TABLE session ADD COLUMN voice_mode TEXT NOT NULL DEFAULT ''`);
  }
}

const q = {
  createSession: db.prepare(
    `INSERT INTO session (id, lesson_id, user_id, started_at, character_code, voice_mode)
     VALUES (?, ?, ?, ?, ?, ?)`
  ),
  getSession: db.prepare(`SELECT * FROM session WHERE id = ?`),
  listSessions: db.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count
     FROM session s ORDER BY s.started_at DESC LIMIT 50`
  ),
  endSession: db.prepare(
    `UPDATE session SET status = 'ended', ended_at = ?, end_reason = ?, summary_json = ? WHERE id = ?`
  ),
  bumpHint: db.prepare(`UPDATE session SET hint_count = hint_count + 1 WHERE id = ?`),

  upsertMessage: db.prepare(
    `INSERT INTO message (session_id, seq, role, text, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, seq) DO UPDATE SET
       text = excluded.text,
       duration_ms = COALESCE(excluded.duration_ms, message.duration_ms)`
  ),
  setAudio: db.prepare(
    `UPDATE message SET audio_path = ?, audio_store = ?, duration_ms = ?
     WHERE session_id = ? AND seq = ?`
  ),
  listMessages: db.prepare(
    `SELECT seq, role, text, audio_path, audio_store, duration_ms FROM message
     WHERE session_id = ? ORDER BY seq ASC`
  ),

  upsertProgress: db.prepare(
    `INSERT INTO progress (session_id, objective_id, status, evidence, message_seq, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, objective_id) DO UPDATE SET
       status = excluded.status,
       evidence = COALESCE(excluded.evidence, progress.evidence),
       message_seq = COALESCE(excluded.message_seq, progress.message_seq),
       updated_at = excluded.updated_at`
  ),
  listProgress: db.prepare(
    `SELECT objective_id, status, evidence, message_seq FROM progress WHERE session_id = ?`
  ),

  startCall: db.prepare(
    `INSERT INTO call (id, session_id, user_id, started_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`
  ),
  endCall: db.prepare(
    `UPDATE call SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL`
  ),
  getCall: db.prepare(`SELECT * FROM call WHERE id = ?`),
  openCalls: db.prepare(`SELECT * FROM call WHERE ended_at IS NULL`),
  // Call chua dong duoc tinh toi thoi diem hoi, neu khong thi chi can dong tab
  // la dong ho ngung chay.
  usedSince: db.prepare(
    `SELECT COALESCE(SUM(COALESCE(ended_at, ?) - started_at), 0) AS used
     FROM call WHERE user_id = ? AND started_at >= ?`
  ),
};

const now = (): number => Date.now();

export function createSession(
  id: string,
  lessonId: string,
  userId = 'demo-user',
  characterCode = '',
  voiceMode: VoiceMode = VOICE_MODE_DEFAULT
): SessionRow {
  q.createSession.run(id, lessonId, userId, now(), characterCode, voiceMode);
  const session = getSession(id);
  // Vua INSERT xong ma doc lai khong thay thi DB da hong that su — nga ra
  // ngay con hon tra ve null roi de cho goi phai doan.
  if (!session) throw new Error(`Khong doc lai duoc session vua tao: ${id}`);
  return session;
}

export function getSession(id: string): SessionRow | null {
  return (q.getSession.get(id) as SessionRow | undefined) ?? null;
}

export function listSessions(): SessionListRow[] {
  return q.listSessions.all() as unknown as SessionListRow[];
}

export function endSession(id: string, reason: string | null, summary: Summary | null): void {
  q.endSession.run(now(), reason ?? null, summary ? JSON.stringify(summary) : null, id);
}

export function incrementHintCount(id: string): void {
  q.bumpHint.run(id);
}

export interface MessageInput {
  seq: number;
  role: Role;
  text?: string;
  durationMs?: number | null;
}

export function saveMessage(sessionId: string, { seq, role, text, durationMs }: MessageInput): void {
  q.upsertMessage.run(sessionId, seq, role, text ?? '', durationMs ?? null, now());
}

export function attachAudio(
  sessionId: string,
  seq: number,
  path: string,
  store: AudioStore,
  durationMs: number | null
): void {
  q.setAudio.run(path, store, durationMs ?? null, sessionId, seq);
}

/**
 * `audioUrl` co tinh de null: chi `audio-store.ts` moi biet dung URL nao (dia,
 * CDN, hay presigned), nen goi phai tu dien vao truoc khi tra xuong client.
 */
export function listMessages(sessionId: string): StoredMessage[] {
  return (q.listMessages.all(sessionId) as unknown as MessageRow[]).map((m) => ({
    seq: m.seq,
    role: m.role,
    text: m.text,
    audioUrl: null,
    audioPath: m.audio_path,
    audioStore: m.audio_store ?? 'disk',
    durationMs: m.duration_ms,
  }));
}

export function saveProgress(
  sessionId: string,
  { objectiveId, status, evidence, messageSeq }: ProgressRecord
): void {
  q.upsertProgress.run(
    sessionId,
    objectiveId,
    status,
    evidence ?? null,
    messageSeq ?? null,
    now()
  );
}

export function listProgress(sessionId: string): ProgressRecord[] {
  return (q.listProgress.all(sessionId) as unknown as ProgressRow[]).map((p) => ({
    objectiveId: p.objective_id,
    status: p.status,
    evidence: p.evidence,
    messageSeq: p.message_seq,
  }));
}

// ------------------------------------------------------------ han muc goi

/**
 * Han muc mien phi moi ngay, tinh bang thoi gian ket noi that.
 *
 * 2 tieng la muc de TEST, khong phai muc cho nguoi dung that: no du de ngoi
 * thu ca hai mode giong trong mot buoi lam viec ma khong phai sua env giua
 * chung. Truoc khi mo cho nguoi ngoai, keo xuong bang `DAILY_QUOTA_MS` —
 * rieng mode `openai` dat gap ~2 lan, nen 2 tieng o do la mot hoa don that.
 */
export const DAILY_QUOTA_MS = Number(process.env.DAILY_QUOTA_MS ?? 2 * 60 * 60 * 1000);

/** Lech mui gio dung de cat ngay. Mac dinh gio Viet Nam. */
const TZ_OFFSET_MS = Number(process.env.QUOTA_TZ_OFFSET_MS ?? 7 * 60 * 60 * 1000);

/** Moc nua dem gan nhat theo mui gio tren, tra ve epoch ms UTC. */
export function startOfDay(at: number = now()): number {
  const DAY = 24 * 60 * 60 * 1000;
  return Math.floor((at + TZ_OFFSET_MS) / DAY) * DAY - TZ_OFFSET_MS;
}

/** Con lai bao nhieu ms trong ngay hom nay, va bao gio reset. */
export function quotaFor(userId: string, at: number = now()): Quota {
  const dayStart = startOfDay(at);
  const row = q.usedSince.get(at, userId, dayStart) as { used: number } | undefined;
  const used = row?.used ?? 0;
  return {
    usedMs: used,
    remainingMs: Math.max(0, DAILY_QUOTA_MS - used),
    totalMs: DAILY_QUOTA_MS,
    resetAt: dayStart + 24 * 60 * 60 * 1000,
  };
}

export function startCall(callId: string, sessionId: string, userId: string): CallRow | null {
  q.startCall.run(callId, sessionId, userId, now());
  return getCall(callId);
}

/** Tra ve true neu chinh lan goi nay dong duoc call (chua ai dong truoc do). */
export function endCall(callId: string, reason: string): boolean {
  return q.endCall.run(now(), reason, callId).changes > 0;
}

export function getCall(callId: string): CallRow | null {
  return (q.getCall.get(callId) as CallRow | undefined) ?? null;
}

export function openCalls(): CallRow[] {
  return q.openCalls.all() as unknown as CallRow[];
}
