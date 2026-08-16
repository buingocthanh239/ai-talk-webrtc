import { api } from './api.ts';
import { LessonSession } from './session.ts';
import type { PttState, SessionHandlers } from './session.ts';
// Chi lay KIEU o day. Module that duoc nap bang dynamic import trong
// mountTalkAvatar(), vi no keo theo three.js — xem build.js.
import type { TalkAvatar } from './talk-avatar.ts';
import { synthesize } from './polly-client.ts';

import type {
  Lesson,
  Message,
  ObjectiveProgress,
  PollyEngine,
  PollyGrant,
  Quota,
  Role,
  SessionDetail,
  Summary,
} from '../../shared/types.ts';
import { clampSpeed } from '../../shared/speed.ts';

/**
 * Thieu mot phan tu trong index.html la loi lap trinh, khong phai tinh huong
 * can xu ly. Nga ra ngay luc nap trang de biet ngay, hon la de `null` troi den
 * mot handler nao do roi vo giua chung.
 */
function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Thieu phan tu #${id} trong index.html`);
  return node as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const screens = {
  home: $('screen-home'),
  live: $('screen-live'),
  summary: $('screen-summary'),
};

/** Avatar cua man hoi thoai. null khi chua dung xong hoac da roi man. */
let talkAvatar: TalkAvatar | null = null;
/** Dung nap hai lan khi reconnect — moi lan connect deu bao lai avatarUrl. */
let talkAvatarLoading = false;

/** `catch (err)` cho ra `unknown` duoi strict — boc mot lan o day. */
const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

function showScreen(name: keyof typeof screens): void {
  // Avatar giu mot vong rAF cua three.js va mot vong nua cua VisemePlayer. Roi
  // man ma khong dong thi no ve tiep duoi nen, an pin va CPU cho toi khi dong
  // tab.
  if (name !== 'live') {
    talkAvatar?.dispose();
    talkAvatar = null;
    $('talk-avatar').classList.add('hidden');
  }

  for (const [key, node] of Object.entries(screens)) {
    node.classList.toggle('hidden', key !== name);
  }
  window.scrollTo(0, 0);
}

// ─────────────────────────────────── home ───────────────────────────────────

let quotaExhausted = false;

function renderQuotaNotice(quota: Quota | null): void {
  const node = $('quota-notice');
  if (!quota) {
    node.classList.add('hidden');
    return;
  }

  quotaExhausted = quota.remainingMs <= 0;
  const mins = Math.floor(quota.remainingMs / 60000);
  const secs = Math.floor((quota.remainingMs % 60000) / 1000);

  node.className = `banner ${quotaExhausted ? 'warn' : 'info'}`;
  node.textContent = quotaExhausted
    ? `Đã dùng hết ${Math.round(quota.totalMs / 60000)} phút miễn phí hôm nay. Hạn mức mới lúc ${new Date(
        quota.resetAt
      ).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} — các buổi đang dở vẫn giữ nguyên.`
    : `Hôm nay bạn còn ${mins}:${String(secs).padStart(2, '0')} thời lượng gọi miễn phí.`;
}

async function loadHome(): Promise<void> {
  showScreen('home');
  stopQuotaClock();
  const [lessons, sessions, quota] = await Promise.all([
    api.listLessons().catch(() => []),
    api.listSessions().catch(() => []),
    api.getQuota().catch(() => null),
  ]);

  renderQuotaNotice(quota);

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

let active: LessonSession | null = null;
const bubbles = new Map<number, HTMLElement>();

/**
 * The chuc mung hoan thanh bai hoc.
 *
 * Day la LOI MOI bam Ket thuc chu khong phai thong bao thoang qua, nen no
 * khong tu tat — tat sau vai giay la mat dung phan quan trong nhat. Nguoi hoc
 * dong duoc, va van hoc tiep duoc: tool call khong dung hoi thoai, luc the nay
 * bat thi AI con dang noi not cau cua no.
 */
function showCongrats(doneCount: number, totalCount: number): void {
  $('congrats-count').textContent = totalCount > 0 ? `Đủ ${doneCount}/${totalCount} mục tiêu.` : '';
  $('congrats').classList.remove('hidden');
}

function hideCongrats(): void {
  $('congrats').classList.add('hidden');
}

function setBanner(text: string | null, kind?: 'info' | 'warn' | 'error'): void {
  const banner = $('status-banner');
  if (!text) {
    banner.classList.add('hidden');
    return;
  }
  banner.className = `banner ${kind ?? 'info'}`;
  banner.textContent = text;
}

/** Duoi nguong nay layout doi sang mot cot — trung voi @media trong styles.css. */
const NARROW = '(max-width: 860px)';

function renderPanel(lesson: Lesson): void {
  $('live-title').textContent = lesson.title;
  $('live-meta').textContent = `${lesson.level} · ~${lesson.estimatedMinutes} phút`;

  // Man hinh hep thi mo san panel se day transcript va nut noi xuong duoi
  // man hinh gap. Gap lai, nguoi hoc tu mo khi can xem tu vung.
  const panel = $('lesson-panel') as HTMLDetailsElement;
  panel.open = !window.matchMedia(NARROW).matches;

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

function renderObjectives(objectives: ObjectiveProgress[]): void {
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

function upsertBubble({ seq, role, text, pending }: { seq: number; role: Role; text: string; pending?: boolean }): void {
  let node = bubbles.get(seq);
  if (!node) {
    node = el('div', `bubble ${role}`);
    node.append(el('div', 'who', role === 'user' ? 'Bạn' : 'AI'));
    node.append(el('div', 'txt'));
    bubbles.set(seq, node);

    // Chen dung thu tu seq, khong phai lúc nao cung append cuoi
    const transcript = $('transcript');
    const after = [...transcript.children].find(
      (c) => Number((c as HTMLElement).dataset['seq']) > seq
    );
    node.dataset['seq'] = String(seq);
    transcript.insertBefore(node, after ?? null);
  }
  const txt = node.querySelector('.txt');
  if (txt) txt.textContent = text || (pending ? '…' : '');
  node.classList.toggle('pending', Boolean(pending));
  $('transcript').scrollTop = $('transcript').scrollHeight;
}

function attachBubbleAudio(seq: number, url: string): void {
  const node = bubbles.get(seq);
  if (!node || node.querySelector('audio')) return;
  const audio = el('audio');
  audio.controls = true;
  audio.preload = 'none';
  audio.src = url;
  node.append(audio);
}

// ──────────────────────────── đồng hồ hạn mức ────────────────────────────
//
// Client dem tung giay, server nan lai dinh ky qua SSE. Con so nay thuan
// trang tri — cat that la viec cua server, nen client dem lech cung khong ai
// goi lau duoc.

// Neo lai moc do server gui, roi TINH LAI moi tick thay vi tru dan. Tab chay
// nen bi bop setInterval xuong 1 lan/phut va may ngu thi no dung han — tru
// dan se cham theo, con tinh tu moc neo thi tick tre bao nhieu cung dung.
let quotaAnchor: { remainingMs: number; at: number } | null = null;
let quotaTicker: ReturnType<typeof setInterval> | null = null;

const fmtClock = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function remainingNow(): number {
  if (!quotaAnchor) return 0;
  return Math.max(0, quotaAnchor.remainingMs - (performance.now() - quotaAnchor.at));
}

function paintClock(): void {
  const left = remainingNow();
  const node = $('quota-clock');
  node.classList.remove('hidden');
  node.textContent = `⏱ còn ${fmtClock(left)}`;
  node.classList.toggle('low', left <= 60_000);

  if (left <= 30_000 && left > 0 && !node.dataset['warned']) {
    node.dataset['warned'] = '1';
    setBanner('Sắp hết thời lượng miễn phí hôm nay — còn dưới 30 giây.', 'warn');
  }
}

function setQuota(quota: Quota | undefined): void {
  if (!quota || typeof quota.remainingMs !== 'number') return;
  quotaAnchor = { remainingMs: quota.remainingMs, at: performance.now() };
  paintClock();
  if (quotaTicker) return;
  quotaTicker = setInterval(paintClock, 1000);
}

function stopQuotaClock(): void {
  if (quotaTicker) clearInterval(quotaTicker);
  quotaTicker = null;
  quotaAnchor = null;
  const node = $('quota-clock');
  node.classList.add('hidden');
  delete node.dataset['warned'];
}

// Tab quay lai foreground thi so hien tren man co the da cu — xin nan ngay.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !quotaAnchor) return;
  api.getQuota().then(setQuota).catch(() => {});
});

// ───────────────────────────── push-to-talk ─────────────────────────────

const PTT_LABEL = {
  locked: 'Đang kết nối…',
  ready: 'Đến lượt bạn — giữ nút để nói',
  recording: 'Đang thu — thả ra để gửi',
  thinking: 'Đang gửi cho AI…',
  ai: 'AI đang nói — chờ một chút',
};

function setPttUi(state: PttState): void {
  const btn = $<HTMLButtonElement>('btn-ptt');
  btn.dataset.state = state;
  btn.disabled = state !== 'ready';
  const icon = btn.querySelector('.ptt-icon');
  const label = btn.querySelector('.ptt-text');
  if (icon) icon.textContent = state === 'recording' ? '●' : '🎙';
  if (label) label.textContent = state === 'recording' ? 'Đang thu…' : 'Giữ để nói';
  $('mic-label').textContent = PTT_LABEL[state] ?? '';

  // Go chu va noi la hai duong vao cua cung mot luot, nen mo/khoa cung nhip.
  $<HTMLInputElement>('text-input').disabled = state !== 'ready';
  $<HTMLButtonElement>('btn-send').disabled = state !== 'ready';

  // Slider toc do khong con bi khoa: no la playbackRate cua the <audio> nen
  // keo giua luc AI dang doc la nghe thay doi ngay. Truoc day phai khoa vi
  // Realtime API chi nhan session.update giua cac luot.
}

// ------------------------------------------------------------ toc do AI

const SPEED_KEY = 'ai-learn:speed';

/** Toc do nguoi hoc da chon lan truoc. null = chua tung chinh, dung mac dinh bai. */
function storedSpeed(): number | null {
  const raw = localStorage.getItem(SPEED_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? clampSpeed(n) : null;
}

function renderSpeed(value: number): void {
  $<HTMLInputElement>('speed-range').value = String(value);
  $('speed-value').textContent = `${value.toFixed(2).replace(/0$/, '')}×`;
}

// ------------------------------------------------------------ giong doc

const VOICE_KEY = 'ai-learn:voice';
const ENGINE_KEY = 'ai-learn:engine';
const SAVE_AUDIO_KEY = 'ai-learn:save-ai-audio';

/**
 * Danh sach giong ghi cung thay vi goi `DescribeVoices`.
 *
 * Goi DescribeVoices nghia la them mot API nua phai ky tu browser, de lay ve
 * mot danh sach gan nhu khong bao gio doi. Khi nao Polly ra giong moi dang
 * dung thi them mot dong o day.
 */
const VOICES: readonly { id: string; label: string }[] = [
  { id: 'Joanna', label: 'Joanna — nữ, Mỹ' },
  { id: 'Matthew', label: 'Matthew — nam, Mỹ' },
  { id: 'Ruth', label: 'Ruth — nữ, Mỹ' },
  { id: 'Stephen', label: 'Stephen — nam, Mỹ' },
  { id: 'Amy', label: 'Amy — nữ, Anh' },
  { id: 'Brian', label: 'Brian — nam, Anh' },
  { id: 'Olivia', label: 'Olivia — nữ, Úc' },
];

const ENGINES: readonly PollyEngine[] = ['standard', 'neural', 'long-form'];

const storedEngine = (): PollyEngine => {
  const raw = localStorage.getItem(ENGINE_KEY);
  return ENGINES.includes(raw as PollyEngine) ? (raw as PollyEngine) : 'neural';
};

const storedVoice = (): string => localStorage.getItem(VOICE_KEY) ?? 'Joanna';

const storedSaveAudio = (): boolean => localStorage.getItem(SAVE_AUDIO_KEY) === '1';

function buildVoicePanel(): void {
  const select = $<HTMLSelectElement>('voice-select');
  select.replaceChildren(
    ...VOICES.map(({ id, label }) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = label;
      return option;
    })
  );
  select.value = storedVoice();
  $<HTMLSelectElement>('engine-select').value = storedEngine();
  $<HTMLInputElement>('save-audio').checked = storedSaveAudio();
}

/** Doi giong: ap dung tu khuc KE TIEP, khuc dang doc thi de yen. */
function applyVoice(): void {
  const voiceId = $<HTMLSelectElement>('voice-select').value;
  const engine = $<HTMLSelectElement>('engine-select').value as PollyEngine;
  localStorage.setItem(VOICE_KEY, voiceId);
  localStorage.setItem(ENGINE_KEY, engine);
  active?.setVoice(voiceId, engine);
}

buildVoicePanel();

$<HTMLSelectElement>('voice-select').onchange = applyVoice;
$<HTMLSelectElement>('engine-select').onchange = applyVoice;

$<HTMLInputElement>('save-audio').onchange = (e) => {
  const enabled = (e.currentTarget as HTMLInputElement).checked;
  localStorage.setItem(SAVE_AUDIO_KEY, enabled ? '1' : '');
  active?.setSaveAiAudio(enabled);
};

// ------------------------------------------------------ avatar hoi thoai

/**
 * Dung avatar cho man hoi thoai.
 *
 * Nap bang dynamic import: no keo theo three.js, va nguoi
 * hoc khong cau hinh avatar thi khong co ly do tai ve.
 *
 * Goi lai moi lan bat tay (ke ca reconnect) nen phai chan dung hai lan — mot
 * lan reconnect giua buoi la du de co hai avatar cung ve len mot canvas.
 */
async function mountTalkAvatar(avatarUrl: string | null): Promise<void> {
  if (talkAvatar || talkAvatarLoading) return;
  talkAvatarLoading = true;
  try {
    const { createTalkAvatar } = await import('./talk-avatar.ts');
    $('talk-avatar').classList.remove('hidden');
    talkAvatar = await createTalkAvatar({
      canvas: $<HTMLCanvasElement>('talk-canvas'),
      note: $('talk-avatar-note'),
      bars: $('talk-bars'),
      hint: $('talk-hint'),
      audio: $<HTMLAudioElement>('ai-audio'),
      avatarUrl,
    });
  } catch (err) {
    // Avatar la phan trang tri cua buoi hoc, khong phai duong song. Hong thi
    // ghi log va hoc tiep bang chu va tieng.
    console.warn('[avatar]', errorMessage(err));
    $('talk-avatar').classList.add('hidden');
  } finally {
    talkAvatarLoading = false;
  }
}

function sendTyped(): void {
  const input = $<HTMLInputElement>('text-input');
  if (!active?.sendText(input.value)) return;
  input.value = '';
  // Tra focus ra ngoai de phim Space lai dieu khien duoc nut giu-de-noi.
  input.blur();
}

$<HTMLButtonElement>('btn-send').onclick = sendTyped;
$<HTMLInputElement>('text-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  sendTyped();
});

const isTyping = (node: EventTarget | null): boolean =>
  node instanceof HTMLElement &&
  (node.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName));

let pttHeld = false;

function pttDown(): void {
  if (pttHeld || !active) return;
  if (active.startTalking()) pttHeld = true;
}

function pttUp(): void {
  if (!pttHeld) return;
  pttHeld = false;
  active?.stopTalking();
}

$<HTMLButtonElement>('btn-ptt').addEventListener('pointerdown', (e) => {
  e.preventDefault(); // chan chon chu / long-press menu khi giu tren mobile
  pttDown();
});
$<HTMLButtonElement>('btn-ptt').addEventListener('contextmenu', (e) => e.preventDefault());

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

function prepareLiveScreen(lesson: Lesson): void {
  bubbles.clear();
  pttHeld = false;
  $<HTMLInputElement>('text-input').value = '';
  setPttUi('locked');
  $('transcript').replaceChildren();
  $('hint-chips').replaceChildren();
  $<HTMLButtonElement>('btn-finish').disabled = true;
  $<HTMLButtonElement>('btn-finish').classList.remove('urging');
  hideCongrats();
  setBanner(null);
  renderPanel(lesson);
  renderObjectives(lesson.objectives.map((o) => ({ ...o, status: 'pending' as const, evidence: null })));
  showScreen('live');
}

async function startLesson(lesson: Lesson): Promise<void> {
  // Chan som cho do phai vao man hoc roi moi bao loi. Server van kiem lai o
  // buoc cap token — day chi la phep lich su, khong phai cho cuong che.
  if (quotaExhausted) {
    renderQuotaNotice(await api.getQuota().catch(() => null));
    return;
  }
  prepareLiveScreen(lesson);

  let sessionId;
  try {
    ({ sessionId } = await api.startSession(lesson.id));
  } catch (err) {
    setBanner(`Không tạo được buổi học: ${errorMessage(err)}`, 'error');
    return;
  }

  await runSession({ sessionId, lesson });
}

/** Hoc tiep mot buoi dang do: dung lai transcript cu roi noi lai ket noi. */
async function resumeLesson(id: string): Promise<void> {
  if (quotaExhausted) {
    renderQuotaNotice(await api.getQuota().catch(() => null));
    return;
  }

  let session;
  try {
    session = await api.getSession(id);
  } catch (err) {
    setBanner(`Không mở lại được buổi học: ${errorMessage(err)}`, 'error');
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

async function runSession({
  sessionId,
  lesson,
  startSeq = 0,
  resume = false,
}: {
  sessionId: string;
  lesson: Lesson;
  startSeq?: number;
  resume?: boolean;
}): Promise<void> {
  active = new LessonSession({
    sessionId,
    lesson,
    startSeq,
    speed: storedSpeed() ?? lesson.speed,
    audioElement: $<HTMLAudioElement>('ai-audio'),
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
          $<HTMLButtonElement>('btn-finish').disabled = false;
          setBanner(detail?.['resumed'] ? 'Đã kết nối lại, hội thoại tiếp tục.' : null, 'info');
          if (detail?.['resumed']) setTimeout(() => setBanner(null), 4000);
        } else if (state === 'reconnecting') {
          label.textContent = 'Mất kết nối';
          setBanner(
            `Đang kết nối lại… (lần ${detail?.['attempt']}/${detail?.['total']}) — bài học của bạn vẫn được giữ nguyên.`,
            'warn'
          );
        } else if (state === 'grading') {
          label.textContent = 'Đang chấm bài…';
        } else if (state === 'error') {
          setBanner(String(detail?.['message'] ?? 'Có lỗi xảy ra.'), 'error');
          $<HTMLButtonElement>('btn-finish').disabled = false;
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
        const txt = node.querySelector('.txt');
        if (txt) txt.textContent = text || '…';
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
      canFinish({ note, completed, doneCount, totalCount }) {
        // Nut Ket thuc luon duoc lam noi — the chuc mung co the bi dong, chi
        // dan khong duoc bien mat theo.
        $<HTMLButtonElement>('btn-finish').classList.add('urging');

        if (completed) showCongrats(doneCount, totalCount);
        else setBanner(note || 'Bạn đã đủ điều kiện kết thúc bài học.', 'info');
      },

      quota: setQuota,

      // Timeline cua khuc AI vua bat dau doc. Day la thu duong audio cu khong
      // bao gio cho duoc — Realtime API khong phat ra viseme nao.
      visemes(frames) {
        talkAvatar?.load(frames);
      },

      avatar(avatarUrl) {
        void mountTalkAvatar(avatarUrl);
      },

      quotaExhausted() {
        stopQuotaClock();
        setPttUi('locked');
        setBanner(
          'Đã hết 5 phút miễn phí hôm nay. Buổi học được giữ nguyên — mai bạn bấm “Tiếp tục” để học tiếp.',
          'warn'
        );
        $<HTMLButtonElement>('btn-finish').disabled = false;
      },
    },
  });

  renderSpeed(active.speed);
  // Lua chon cua nguoi hoc song lau hon mot buoi hoc, nen ap lai moi lan mo.
  active.setVoice(storedVoice(), storedEngine());
  active.setSaveAiAudio(storedSaveAudio());

  try {
    await active.start({ resume });
  } catch (err) {
    console.error(err);
    setBanner(`Không kết nối được: ${errorMessage(err)}`, 'error');
    $<HTMLButtonElement>('btn-finish').disabled = false;
  }
}

// Bo focus sau khi bam: neu khong, phim Space sau do se vua kich lai nut nay
// vua kich push-to-talk.
$<HTMLButtonElement>('btn-hint').onclick = (e) => {
  (e.currentTarget as HTMLButtonElement | null)?.blur();
  active?.requestVoiceHint();
};

$<HTMLButtonElement>('congrats-close').onclick = hideCongrats;

// Bam thang vao nut that thay vi nhan doi luong ket thuc — mot cho sua, va
// khong the lech nhau.
$<HTMLButtonElement>('congrats-finish').onclick = () => {
  hideCongrats();
  $<HTMLButtonElement>('btn-finish').click();
};

$<HTMLInputElement>('speed-range').oninput = (e) => {
  const input = e.currentTarget as HTMLInputElement;
  // Nho gia tri ngay ca khi chua vao buoi hoc nao — lan sau mo bai la co san.
  const applied = active ? active.setSpeed(Number(input.value)) : clampSpeed(input.value);
  localStorage.setItem(SPEED_KEY, String(applied));
  renderSpeed(applied);
};

// Tra focus ra ngoai de phim Space lai dieu khien nut giu-de-noi chu khong
// keo slider.
$<HTMLInputElement>('speed-range').onchange = (e) => {
  (e.currentTarget as HTMLInputElement | null)?.blur();
};

$<HTMLButtonElement>('btn-finish').onclick = async () => {
  if (!active) return;
  const session = active;
  $<HTMLButtonElement>('btn-finish').disabled = true;
  $<HTMLButtonElement>('btn-finish').textContent = 'Đang chấm bài…';
  try {
    const summary = await session.finish('manual');
    renderSummary(summary, await api.getSession(session.sessionId));
    showScreen('summary');
    active = null;
  } catch (err) {
    // Giu `active` de bam lai duoc: buoi hoc da luu, chi rieng buoc cham diem hong.
    setBanner(`Chấm bài thất bại: ${errorMessage(err)} — bấm lại để thử chấm lần nữa.`, 'error');
    $<HTMLButtonElement>('btn-finish').disabled = false;
  } finally {
    $<HTMLButtonElement>('btn-finish').textContent = 'Kết thúc bài học';
  }
};

$<HTMLButtonElement>('btn-quit').onclick = async () => {
  if (active && !confirm('Thoát bây giờ? Buổi học vẫn được lưu nhưng chưa có tổng kết.')) return;
  // Chi ngat ket noi, khong cham diem — thoat giua chung khong nen ton mot luot goi model.
  await active?.stop().catch(() => {});
  active = null;
  loadHome();
};

// ────────────────────────────────── summary ─────────────────────────────────

const scoreClass = (n: number): string => (n >= 75 ? 'good' : n >= 55 ? 'warn' : 'bad');

function scoreCard(label: string, value: number | null, hero = false): HTMLElement {
  const box = el('div', `score${hero ? ' hero-score' : ''}`);
  box.append(el('div', `value ${value === null ? '' : scoreClass(value)}`, String(value ?? '—')));
  box.append(el('div', 'label', label));
  return box;
}

function renderSummary(summary: Summary | null, session: SessionDetail): void {
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
function renderReplay(body: HTMLElement, session: SessionDetail): void {
  body.append(el('h2', null, 'Nghe lại buổi học'));

  const urls = session.messages
    .map((m) => m.audioUrl)
    .filter((u): u is string => u !== null);
  if (urls.length > 0) {
    const playAll = el('button', 'ghost-btn', '▶ Phát lại toàn bộ');
    playAll.style.marginBottom = '1rem';
    playAll.onclick = () => playSequentially(urls, playAll);
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
    } else if (m.role === 'assistant' && m.text && session.pollyGrant) {
      // Khong bat luu mp3 thi khong co file nao ca — doc lai bang Polly ngay
      // luc bam. Ton them tien moi lan nghe, doi lai buoi hoc khong phai luu
      // gi, va ban doc lai nay co du viseme neu sau nay muon xem khau hinh.
      row.append(speakAgainButton(m.text, session.pollyGrant));
    } else {
      row.append(el('div', 'no-audio', 'không có audio'));
    }
    body.append(row);
  }
}

/**
 * Nut doc lai mot cau cua AI bang Polly.
 *
 * Chi doc mot lan roi giu lai the <audio>: bam nghe di nghe lai la chuyen binh
 * thuong o man tong ket, va moi lan goi Polly la mot lan tra tien.
 */
function speakAgainButton(text: string, grant: PollyGrant): HTMLElement {
  const button = el('button', 'ghost-btn', '🔊 Đọc lại');

  button.onclick = async () => {
    (button as HTMLButtonElement).disabled = true;
    button.textContent = 'Đang đọc…';
    try {
      const { url } = await synthesize(grant, text, {
        voiceId: storedVoice(),
        engine: storedEngine(),
      });
      const audio = el('audio') as HTMLAudioElement;
      audio.controls = true;
      audio.src = url;
      button.replaceWith(audio);
      await audio.play().catch(() => {});
    } catch (err) {
      button.textContent = '🔊 Đọc lại';
      (button as HTMLButtonElement).disabled = false;
      setBanner(`Không đọc lại được: ${errorMessage(err)}`, 'error');
    }
  };

  return button;
}

let sequentialPlayer: HTMLAudioElement | null = null;

function playSequentially(urls: string[], button: HTMLElement): void {
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

async function openSavedSession(id: string): Promise<void> {
  showScreen('summary');
  $('summary-body').replaceChildren(el('p', 'spinner', 'Đang tải…'));
  try {
    const session = await api.getSession(id);
    renderSummary(session.summary, session);
  } catch (err) {
    $('summary-body').replaceChildren(el('p', 'empty', `Không tải được: ${errorMessage(err)}`));
  }
}

$<HTMLButtonElement>('btn-home').onclick = loadHome;

loadHome();
