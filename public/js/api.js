async function request(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).error ?? detail;
    } catch {
      /* body khong phai JSON */
    }
    throw new Error(detail);
  }
  return res.json();
}

const json = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

export const api = {
  listLessons: () => request('/api/lessons'),

  listSessions: () => request('/api/sessions'),

  startSession: (lessonId) => request('/api/sessions', json('POST', { lessonId })),

  getSession: (id) => request(`/api/sessions/${id}`),

  getToken: (id, resume = false) => request(`/api/sessions/${id}/token`, json('POST', { resume })),

  saveMessage: (id, message) => request(`/api/sessions/${id}/messages`, json('POST', message)),

  saveProgress: (id, progress) => request(`/api/sessions/${id}/progress`, json('POST', progress)),

  countHint: (id) => request(`/api/sessions/${id}/hint`, json('POST')),

  endSession: (id, reason) => request(`/api/sessions/${id}/end`, json('POST', { reason })),

  uploadAudio: (id, seq, role, durationMs, blob) =>
    request(`/api/sessions/${id}/messages/${seq}/audio`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        'X-Role': role,
        'X-Duration-Ms': String(Math.round(durationMs)),
      },
      body: blob,
    }),
};
