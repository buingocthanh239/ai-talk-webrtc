import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  summary_json TEXT
);

CREATE TABLE IF NOT EXISTS message (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,                     -- user | assistant
  text        TEXT NOT NULL DEFAULT '',
  audio_path  TEXT,
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

CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id, seq);
`);

const q = {
  createSession: db.prepare(
    `INSERT INTO session (id, lesson_id, user_id, started_at) VALUES (?, ?, ?, ?)`
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
    `UPDATE message SET audio_path = ?, duration_ms = ? WHERE session_id = ? AND seq = ?`
  ),
  listMessages: db.prepare(
    `SELECT seq, role, text, audio_path, duration_ms FROM message
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
};

const now = () => Date.now();

export function createSession(id, lessonId, userId = 'demo-user') {
  q.createSession.run(id, lessonId, userId, now());
  return getSession(id);
}

export function getSession(id) {
  return q.getSession.get(id) ?? null;
}

export function listSessions() {
  return q.listSessions.all();
}

export function endSession(id, reason, summary) {
  q.endSession.run(now(), reason ?? null, summary ? JSON.stringify(summary) : null, id);
}

export function incrementHintCount(id) {
  q.bumpHint.run(id);
}

export function saveMessage(sessionId, { seq, role, text, durationMs }) {
  q.upsertMessage.run(sessionId, seq, role, text ?? '', durationMs ?? null, now());
}

export function attachAudio(sessionId, seq, relativePath, durationMs) {
  q.setAudio.run(relativePath, durationMs ?? null, sessionId, seq);
}

export function listMessages(sessionId) {
  return q.listMessages.all(sessionId).map((m) => ({
    seq: m.seq,
    role: m.role,
    text: m.text,
    audioUrl: m.audio_path ? `/audio/${m.audio_path}` : null,
    durationMs: m.duration_ms,
  }));
}

export function saveProgress(sessionId, { objectiveId, status, evidence, messageSeq }) {
  q.upsertProgress.run(
    sessionId,
    objectiveId,
    status,
    evidence ?? null,
    messageSeq ?? null,
    now()
  );
}

export function listProgress(sessionId) {
  return q.listProgress.all(sessionId).map((p) => ({
    objectiveId: p.objective_id,
    status: p.status,
    evidence: p.evidence,
    messageSeq: p.message_seq,
  }));
}
