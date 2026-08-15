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
};

export type { Message };
