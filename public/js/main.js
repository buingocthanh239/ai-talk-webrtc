import { api } from './api.js';
import { LessonSession } from './session.js';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const screens = {
  home: $('screen-home'),
  live: $('screen-live'),
  summary: $('screen-summary'),
};

function showScreen(name) {
  for (const [key, node] of Object.entries(screens)) {
    node.classList.toggle('hidden', key !== name);
  }
  window.scrollTo(0, 0);
}

// ─────────────────────────────────── home ───────────────────────────────────

async function loadHome() {
  showScreen('home');
  const [lessons, sessions] = await Promise.all([
    api.listLessons().catch(() => []),
    api.listSessions().catch(() => []),
  ]);

  const list = $('lesson-list');
  list.replaceChildren(
    ...lessons.map((lesson) => {
      const card = el('button', 'lesson-card');
      card.append(el('strong', null, lesson.title));
      card.append(el('span', 'meta', lesson.scenario.slice(0, 110) + '…'));

      const tags = el('div', 'tags');
      tags.append(el('span', 'tag accent', lesson.level));
      tags.append(el('span', 'tag', `${lesson.objectives.length} mục tiêu`));
      tags.append(el('span', 'tag', `~${lesson.estimatedMinutes} phút`));
      card.append(tags);

      card.onclick = () => startLesson(lesson);
      return card;
    })
  );

  const history = $('history-list');
  if (sessions.length === 0) {
    history.replaceChildren(el('p', 'empty', 'Chưa có buổi học nào được lưu.'));
    return;
  }

  history.replaceChildren(
    ...sessions.map((s) => {
      const done = s.status === 'ended';
      const meta = `${new Date(s.startedAt).toLocaleString('vi-VN')} · ${s.messageCount} lượt · ${
        done ? 'đã tổng kết' : 'chưa tổng kết'
      }`;

      // Buoi da tong ket thi ca hang la mot nut mo tong ket. Buoi dang do thi
      // tach hai hanh dong ra, de khong ai lo tay noi lai WebRTC khi chi
      // dinh xem lai.
      if (done) {
        const row = el('button', 'history-row');
        const grow = el('div', 'grow');
        grow.append(el('div', null, s.lessonTitle));
        grow.append(el('small', null, meta));
        row.append(grow);
        if (s.overall !== null && s.overall !== undefined) {
          row.append(el('span', 'tag accent', `${s.overall}/100`));
        }
        row.onclick = () => openSavedSession(s.id);
        return row;
      }

      const row = el('div', 'history-row open');
      const grow = el('div', 'grow');
      grow.append(el('div', null, s.lessonTitle));
      grow.append(el('small', null, meta));
      row.append(grow);

      const resume = el('button', 'primary-btn small', '▶ Tiếp tục');
      resume.onclick = () => resumeLesson(s.id);
      row.append(resume);

      const review = el('button', 'ghost-btn small', 'Xem lại');
      review.onclick = () => openSavedSession(s.id);
      row.append(review);

      return row;
    })
  );
}

// ─────────────────────────────────── live ───────────────────────────────────

let active = null;
const bubbles = new Map();

function setBanner(text, kind) {
  const banner = $('status-banner');
  if (!text) {
    banner.classList.add('hidden');
    return;
  }
  banner.className = `banner ${kind ?? 'info'}`;
  banner.textContent = text;
}

function renderPanel(lesson) {
  $('live-title').textContent = lesson.title;
  $('live-meta').textContent = `${lesson.level} · ~${lesson.estimatedMinutes} phút`;

  $('vocab-list').replaceChildren(
    ...lesson.vocabulary.map((v) => {
      const li = el('li');
      li.append(el('b', null, v.term));
      li.append(document.createTextNode(` — ${v.meaning}`));
      return li;
    })
  );

  $('grammar-list').replaceChildren(
    ...lesson.grammar.map((g) => {
      const li = el('li');
      li.append(el('b', null, g.point));
      li.append(document.createTextNode(` — ${g.note}`));
      return li;
    })
  );
}

function renderObjectives(objectives) {
  $('objective-list').replaceChildren(
    ...objectives.map((o) => {
      const li = el('li', o.status);
      li.append(el('span', 'box', o.status === 'done' ? '✓' : o.status === 'struggling' ? '!' : ''));
      const label = el('span');
      label.textContent = o.text;
      if (!o.required) label.append(el('span', 'opt', ' (tuỳ chọn)'));
      li.append(label);
      li.title = o.evidence ? `Bằng chứng: "${o.evidence}"` : '';
      return li;
    })
  );
}

function upsertBubble({ seq, role, text, pending }) {
  let node = bubbles.get(seq);
  if (!node) {
    node = el('div', `bubble ${role}`);
    node.append(el('div', 'who', role === 'user' ? 'Bạn' : 'AI'));
    node.append(el('div', 'txt'));
    bubbles.set(seq, node);

    // Chen dung thu tu seq, khong phai lúc nao cung append cuoi
    const transcript = $('transcript');
    const after = [...transcript.children].find((c) => Number(c.dataset.seq) > seq);
    node.dataset.seq = String(seq);
    transcript.insertBefore(node, after ?? null);
  }
  node.querySelector('.txt').textContent = text || (pending ? '…' : '');
  node.classList.toggle('pending', Boolean(pending));
  $('transcript').scrollTop = $('transcript').scrollHeight;
}

function attachBubbleAudio(seq, url) {
  const node = bubbles.get(seq);
  if (!node || node.querySelector('audio')) return;
  const audio = el('audio');
  audio.controls = true;
  audio.preload = 'none';
  audio.src = url;
  node.append(audio);
}

// ───────────────────────────── push-to-talk ─────────────────────────────

const PTT_LABEL = {
  locked: 'Đang kết nối…',
  ready: 'Đến lượt bạn — giữ nút để nói',
  recording: 'Đang thu — thả ra để gửi',
  thinking: 'Đang gửi cho AI…',
  ai: 'AI đang nói — chờ một chút',
};

function setPttUi(state) {
  const btn = $('btn-ptt');
  btn.dataset.state = state;
  btn.disabled = state !== 'ready';
  btn.querySelector('.ptt-icon').textContent = state === 'recording' ? '●' : '🎙';
  btn.querySelector('.ptt-text').textContent =
    state === 'recording' ? 'Đang thu…' : 'Giữ để nói';
  $('mic-label').textContent = PTT_LABEL[state] ?? '';

  // Go chu va noi la hai duong vao cua cung mot luot, nen mo/khoa cung nhip.
  $('text-input').disabled = state !== 'ready';
  $('btn-send').disabled = state !== 'ready';
}

function sendTyped() {
  const input = $('text-input');
  if (!active?.sendText(input.value)) return;
  input.value = '';
  // Tra focus ra ngoai de phim Space lai dieu khien duoc nut giu-de-noi.
  input.blur();
}

$('btn-send').onclick = sendTyped;
$('text-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  sendTyped();
});

const isTyping = (node) =>
  node instanceof HTMLElement &&
  (node.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName));

let pttHeld = false;

function pttDown() {
  if (pttHeld || !active) return;
  if (active.startTalking()) pttHeld = true;
}

function pttUp() {
  if (!pttHeld) return;
  pttHeld = false;
  active?.stopTalking();
}

$('btn-ptt').addEventListener('pointerdown', (e) => {
  e.preventDefault(); // chan chon chu / long-press menu khi giu tren mobile
  pttDown();
});
$('btn-ptt').addEventListener('contextmenu', (e) => e.preventDefault());

// Nghe tha tay o cap window chu khong phai tren nut: keo ngon tay ra ngoai
// nut roi tha, hay bi cuoc goi chen ngang, ma khong bat duoc thi mic ket bat.
window.addEventListener('pointerup', pttUp);
window.addEventListener('pointercancel', pttUp);
window.addEventListener('blur', pttUp);

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || isTyping(e.target)) return;
  if (screens.live.classList.contains('hidden')) return;
  e.preventDefault();
  pttDown();
});

document.addEventListener('keyup', (e) => {
  if (e.code !== 'Space' || isTyping(e.target)) return;
  e.preventDefault();
  pttUp();
});

function prepareLiveScreen(lesson) {
  bubbles.clear();
  pttHeld = false;
  $('text-input').value = '';
  setPttUi('locked');
  $('transcript').replaceChildren();
  $('hint-chips').replaceChildren();
  $('btn-finish').disabled = true;
  setBanner(null);
  renderPanel(lesson);
  renderObjectives(lesson.objectives.map((o) => ({ ...o, status: 'pending' })));
  showScreen('live');
}

async function startLesson(lesson) {
  prepareLiveScreen(lesson);

  let sessionId;
  try {
    ({ sessionId } = await api.startSession(lesson.id));
  } catch (err) {
    setBanner(`Không tạo được buổi học: ${err.message}`, 'error');
    return;
  }

  await runSession({ sessionId, lesson });
}

/** Hoc tiep mot buoi dang do: dung lai transcript cu roi noi lai ket noi. */
async function resumeLesson(id) {
  let session;
  try {
    session = await api.getSession(id);
  } catch (err) {
    setBanner(`Không mở lại được buổi học: ${err.message}`, 'error');
    return;
  }

  prepareLiveScreen(session.lesson);

  let lastSeq = 0;
  for (const m of session.messages) {
    upsertBubble({ seq: m.seq, role: m.role, text: m.text, pending: false });
    if (m.audioUrl) attachBubbleAudio(m.seq, m.audioUrl);
    lastSeq = Math.max(lastSeq, m.seq);
  }

  await runSession({ sessionId: id, lesson: session.lesson, startSeq: lastSeq, resume: true });
}

async function runSession({ sessionId, lesson, startSeq = 0, resume = false }) {
  active = new LessonSession({
    sessionId,
    lesson,
    startSeq,
    audioElement: $('ai-audio'),
    handlers: {
      status(state, detail) {
        const label = $('mic-label');
        const micState = $('mic-state');
        micState.className = 'mic-state';

        if (state === 'connecting') {
          label.textContent = 'Đang kết nối…';
        } else if (state === 'live') {
          // Chu o day do pttState dat ngay sau do — khong ghi de.
          // Ket thuc duoc bat cu luc nao, khong cho du muc tieu.
          $('btn-finish').disabled = false;
          setBanner(detail?.resumed ? 'Đã kết nối lại, hội thoại tiếp tục.' : null, 'info');
          if (detail?.resumed) setTimeout(() => setBanner(null), 4000);
        } else if (state === 'reconnecting') {
          label.textContent = 'Mất kết nối';
          setBanner(
            `Đang kết nối lại… (lần ${detail.attempt}/${detail.total}) — bài học của bạn vẫn được giữ nguyên.`,
            'warn'
          );
        } else if (state === 'grading') {
          label.textContent = 'Đang chấm bài…';
        } else if (state === 'error') {
          setBanner(detail?.message ?? 'Có lỗi xảy ra.', 'error');
          $('btn-finish').disabled = false;
        }
      },

      // Chi doi mau cham; chu o mic-label do pttState lam chu de hai ben
      // khong ghi de len nhau.
      speaking(who) {
        $('mic-state').className = who ? `mic-state ${who}` : 'mic-state';
      },

      pttState: setPttUi,

      message: upsertBubble,

      messageRemove(seq) {
        bubbles.get(seq)?.remove();
        bubbles.delete(seq);
      },

      messageUpdate(seq, text, opts = {}) {
        const node = bubbles.get(seq);
        if (!node) return;
        node.querySelector('.txt').textContent = text || '…';
        if (opts.pending === false) node.classList.remove('pending');
        $('transcript').scrollTop = $('transcript').scrollHeight;
      },

      messageAudio: attachBubbleAudio,

      progress(list) {
        renderObjectives(list);
      },

      hints(list) {
        $('hint-chips').replaceChildren(...list.map((h) => el('div', 'hint-chip', h)));
      },

      hintUsed(level) {
        setBanner(`Đã dùng gợi ý (mức ${level}/3) — số lần gợi ý sẽ được tính vào điểm.`, 'info');
        setTimeout(() => setBanner(null), 3500);
      },

      // Nut Ket thuc da mo san tu luc live — day chi la loi goi y.
      canFinish({ note }) {
        setBanner(note || 'Bạn đã đủ điều kiện kết thúc bài học.', 'info');
      },
    },
  });

  try {
    await active.start({ resume });
  } catch (err) {
    console.error(err);
    setBanner(`Không kết nối được: ${err.message}`, 'error');
    $('btn-finish').disabled = false;
  }
}

// Bo focus sau khi bam: neu khong, phim Space sau do se vua kich lai nut nay
// vua kich push-to-talk.
$('btn-hint').onclick = (e) => {
  e.currentTarget.blur();
  active?.requestVoiceHint();
};

$('btn-finish').onclick = async () => {
  if (!active) return;
  const session = active;
  $('btn-finish').disabled = true;
  $('btn-finish').textContent = 'Đang chấm bài…';
  try {
    const summary = await session.finish('manual');
    renderSummary(summary, await api.getSession(session.sessionId));
    showScreen('summary');
    active = null;
  } catch (err) {
    // Giu `active` de bam lai duoc: buoi hoc da luu, chi rieng buoc cham diem hong.
    setBanner(`Chấm bài thất bại: ${err.message} — bấm lại để thử chấm lần nữa.`, 'error');
    $('btn-finish').disabled = false;
  } finally {
    $('btn-finish').textContent = 'Kết thúc bài học';
  }
};

$('btn-quit').onclick = async () => {
  if (active && !confirm('Thoát bây giờ? Buổi học vẫn được lưu nhưng chưa có tổng kết.')) return;
  // Chi ngat ket noi, khong cham diem — thoat giua chung khong nen ton mot luot goi model.
  await active?.stop().catch(() => {});
  active = null;
  loadHome();
};

// ────────────────────────────────── summary ─────────────────────────────────

const scoreClass = (n) => (n >= 75 ? 'good' : n >= 55 ? 'warn' : 'bad');

function scoreCard(label, value, hero = false) {
  const box = el('div', `score${hero ? ' hero-score' : ''}`);
  box.append(el('div', `value ${value === null ? '' : scoreClass(value)}`, value ?? '—'));
  box.append(el('div', 'label', label));
  return box;
}

function renderSummary(summary, session) {
  const body = $('summary-body');
  body.replaceChildren();

  if (!summary) {
    body.append(el('p', 'empty', 'Buổi học này chưa được tổng kết.'));
    renderReplay(body, session);
    return;
  }

  body.append(el('h1', null, `Tổng kết: ${session.lesson.title}`));
  body.append(
    el(
      'p',
      'meta',
      `${summary.turnCount} lượt nói · ${summary.hintCount} lần dùng gợi ý · ${new Date(
        session.startedAt
      ).toLocaleString('vi-VN')}`
    )
  );

  const grid = el('div', 'score-grid');
  grid.append(scoreCard('Tổng điểm', summary.overall, true));
  grid.append(scoreCard('Phát âm', summary.pronunciation));
  grid.append(scoreCard('Ngữ pháp', summary.grammar));
  grid.append(scoreCard('Từ vựng', summary.vocabulary));
  grid.append(scoreCard('Trôi chảy', summary.fluency));
  body.append(grid);

  if (summary.warnings?.includes('pronunciation_grading_failed')) {
    body.append(
      el('p', 'empty', 'Lưu ý: phần chấm phát âm bằng audio không chạy được ở buổi này.')
    );
  }

  if (summary.coachNoteVi) {
    const note = el('div', 'note');
    note.append(el('strong', null, 'Nhận xét'));
    note.append(el('p', null, summary.coachNoteVi));
    if (summary.pronunciationNoteVi) {
      note.append(el('p', null, `Phát âm: ${summary.pronunciationNoteVi}`));
    }
    body.append(note);
  }

  // Muc tieu
  body.append(el('h2', null, 'Mục tiêu bài học'));
  const objList = el('ul', 'objectives');
  for (const o of session.lesson.objectives) {
    const graded = summary.objectives?.find((x) => x.id === o.id);
    const li = el('li', graded?.passed ? 'done' : '');
    li.append(el('span', 'box', graded?.passed ? '✓' : ''));
    const label = el('span');
    label.textContent = o.text;
    if (graded?.evidence) label.append(el('span', 'opt', ` — "${graded.evidence}"`));
    li.append(label);
    objList.append(li);
  }
  body.append(objList);

  // Loi can sua — bam vao la nghe lai dung cau do
  if (summary.mistakes?.length) {
    body.append(el('h2', null, 'Lỗi cần sửa'));
    const byseq = new Map(session.messages.map((m) => [m.seq, m]));
    for (const m of summary.mistakes) {
      const box = el('div', 'mistake');
      const line = el('div');
      line.append(el('span', 'said', m.said));
      line.append(document.createTextNode('  →  '));
      line.append(el('span', 'better', m.better));
      box.append(line);
      box.append(el('div', 'why', `${m.explanation_vi} (${m.type})`));

      const source = byseq.get(m.message_seq);
      if (source?.audioUrl) {
        const audio = el('audio');
        audio.controls = true;
        audio.preload = 'none';
        audio.src = source.audioUrl;
        box.append(audio);
      }
      body.append(box);
    }
  }

  if (summary.strengths?.length) {
    body.append(el('h2', null, 'Bạn làm tốt'));
    const ul = el('ul', 'pill-list');
    ul.append(...summary.strengths.map((s) => el('li', null, s)));
    body.append(ul);
  }

  if (summary.nextFocus?.length) {
    body.append(el('h2', null, 'Buổi sau nên tập trung'));
    const ul = el('ul', 'pill-list');
    ul.append(...summary.nextFocus.map((s) => el('li', null, s)));
    body.append(ul);
  }

  renderReplay(body, session);
}

/** Nghe lai ca buoi hoc: moi message la mot file audio rieng. */
function renderReplay(body, session) {
  body.append(el('h2', null, 'Nghe lại buổi học'));

  const withAudio = session.messages.filter((m) => m.audioUrl);
  if (withAudio.length > 0) {
    const playAll = el('button', 'ghost-btn', '▶ Phát lại toàn bộ');
    playAll.style.marginBottom = '1rem';
    playAll.onclick = () => playSequentially(withAudio.map((m) => m.audioUrl), playAll);
    body.append(playAll);
  }

  if (session.messages.length === 0) {
    body.append(el('p', 'empty', 'Buổi này không ghi được lượt nói nào.'));
    return;
  }

  for (const m of session.messages) {
    const row = el('div', 'replay-row');
    row.append(el('div', 'role', m.role === 'user' ? 'Bạn' : 'AI'));
    row.append(el('div', 'txt', m.text || '(không có transcript)'));
    if (m.audioUrl) {
      const audio = el('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = m.audioUrl;
      row.append(audio);
    } else {
      row.append(el('div', 'no-audio', 'không có audio'));
    }
    body.append(row);
  }
}

let sequentialPlayer = null;

function playSequentially(urls, button) {
  if (sequentialPlayer) {
    sequentialPlayer.pause();
    sequentialPlayer = null;
    button.textContent = '▶ Phát lại toàn bộ';
    return;
  }

  let index = 0;
  const audio = new Audio();
  sequentialPlayer = audio;
  button.textContent = '⏸ Dừng phát';

  const next = () => {
    if (index >= urls.length) {
      sequentialPlayer = null;
      button.textContent = '▶ Phát lại toàn bộ';
      return;
    }
    audio.src = urls[index++];
    audio.play().catch(() => next());
  };
  audio.addEventListener('ended', next);
  audio.addEventListener('error', next);
  next();
}

async function openSavedSession(id) {
  showScreen('summary');
  $('summary-body').replaceChildren(el('p', 'spinner', 'Đang tải…'));
  try {
    const session = await api.getSession(id);
    renderSummary(session.summary, session);
  } catch (err) {
    $('summary-body').replaceChildren(el('p', 'empty', `Không tải được: ${err.message}`));
  }
}

$('btn-home').onclick = loadHome;

loadHome();
