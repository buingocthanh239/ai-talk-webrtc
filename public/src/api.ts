import type {
  Lesson,
  Message,
  ProgressRecord,
  Quota,
  Role,
  SessionDetail,
  SessionListItem,
  Summary,
  TokenResponse,
  UploadGrant,
} from '../../shared/types.ts';

/**
 * Loi HTTP giu nguyen status va payload.
 *
 * Vong thu lai ket noi phai phan biet duoc "het han muc" (dung han) voi "mat
 * mang" (thu lai) — doan qua cau chu bao loi la khong dang tin.
 */
export class ApiError extends Error {
  status: number;
  detail: Record<string, unknown> | null;

  constructor(message: string, status: number, detail: Record<string, unknown> | null) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, options);
  if (!res.ok) {
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* body khong phai JSON */
    }
    throw new ApiError(
      typeof body?.['error'] === 'string' ? body['error'] : res.statusText,
      res.status,
      body
    );
  }
  return (await res.json()) as T;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

export const api = {
  listLessons: () => request<Lesson[]>('/api/lessons'),

  listSessions: () => request<SessionListItem[]>('/api/sessions'),

  startSession: (lessonId: string) =>
    request<{ sessionId: string; lesson: Lesson }>('/api/sessions', json('POST', { lessonId })),

  getSession: (id: string) => request<SessionDetail>(`/api/sessions/${id}`),

  getToken: (id: string, resume = false) =>
    request<TokenResponse>(`/api/sessions/${id}/token`, json('POST', { resume })),

  getQuota: () => request<Quota>('/api/quota'),

  startCall: (id: string, callId: string) =>
    request<Quota>(`/api/sessions/${id}/call`, json('POST', { callId })),

  endCall: (callId: string) => request<Quota>(`/api/calls/${callId}/end`, json('POST')),

  saveMessage: (id: string, message: { seq: number; role: Role; text: string; durationMs?: number }) =>
    request<{ ok: true }>(`/api/sessions/${id}/messages`, json('POST', message)),

  saveProgress: (id: string, progress: ProgressRecord) =>
    request<{ ok: true }>(`/api/sessions/${id}/progress`, json('POST', progress)),

  countHint: (id: string) => request<{ ok: true }>(`/api/sessions/${id}/hint`, json('POST')),

  endSession: (id: string, reason: string) =>
    request<{ summary: Summary | null }>(`/api/sessions/${id}/end`, json('POST', { reason })),

  /** Duong roi ve khi server luu audio tren dia: WAV di xuyen qua backend. */
  uploadAudio: (id: string, seq: number, role: Role, durationMs: number, blob: Blob) =>
    request<{ ok: true; audioUrl: string; bytes: number }>(
      `/api/sessions/${id}/messages/${seq}/audio`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'audio/wav',
          'X-Role': role,
          'X-Duration-Ms': String(Math.round(durationMs)),
        },
        body: blob,
      }
    ),

  /** Bao server rang file da nam tren S3. Chi la metadata, khong co byte nao. */
  confirmAudio: (
    id: string,
    seq: number,
    body: { key: string; role: Role; bytes: number; durationMs: number }
  ) =>
    request<{ ok: true; audioUrl: string; bytes: number | null }>(
      `/api/sessions/${id}/messages/${seq}/audio`,
      json('POST', body)
    ),
};

/**
 * Day thang len S3 bang presigned POST policy.
 *
 * Khong di qua `request()` vi day khong phai endpoint cua minh: S3 tra 204
 * rong khi thanh cong va XML khi loi, khong phai JSON.
 *
 * Thu tu field khong phai chuyen thu vi: `key` truoc, cac field ky o giua, va
 * `file` PHAI o cuoi — S3 ngung doc form ngay khi gap `file`, field nao dung
 * sau no coi nhu khong ton tai.
 */
export async function putAudioToS3(grant: UploadGrant, key: string, blob: Blob): Promise<void> {
  const form = new FormData();
  form.append('key', key);
  for (const [name, value] of Object.entries(grant.fields)) form.append(name, value);
  form.append('file', blob);

  // Khong tu dat Content-Type: trinh duyet phai tu sinh boundary cua multipart.
  const res = await fetch(grant.url, { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error(`S3 tu choi upload (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

export type { Message };
