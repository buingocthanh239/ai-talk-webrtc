import { api } from './api.js';
import { RealtimeConnection } from './realtime.js';
import { TrackRecorder } from './recorder.js';

/** Lich thu lai khi mat ket noi. */
const BACKOFF_MS = [800, 2000, 4000, 8000, 15000];

/** Do tre truoc khi commit, de goi audio cuoi kip di het qua WebRTC. */
const PTT_TAIL_MS = 300;
/** Doan ngan hon nguong nay coi nhu bam nham — khong gui. */
const PTT_MIN_MS = 300;
/** Tran an toan: neu khong chot duoc luc AI ngung tieng thi van mo lai nut. */
const PTT_UNLOCK_FAILSAFE_MS = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HINT_INSTRUCTIONS = {
  1: 'The learner has gone quiet. Do not answer for them. Gently encourage them and rephrase your last question in simpler words. One or two short sentences.',
  2: 'The learner is still stuck. Give them the sentence frame only — the first few words — and let them finish it. Do not say the whole sentence. Keep it under two sentences.',
  3: 'The learner still cannot answer. Say one full model sentence they could use, slowly and clearly, then invite them to repeat it.',
};

/**
 * LessonSession — dieu phoi toan bo mot buoi hoc.
 *
 * Giu trang thai bai hoc o phia server, con ket noi WebRTC chi la duong truyen.
 * Mat ket noi thi chi mat duong truyen, khong mat buoi hoc.
 */
export class LessonSession {
  #conn = null;
  #ctx = null;
  #micStream = null;
  #micRec = null;
  #aiRec = null;

  #seq = 0;
  #pendingUser = [];
  #activeResponse = null;
  #hintsResponseId = null;
  #hintsPending = false;
  #hintLevel = 0;
  #ptt = null;
  #pttState = 'locked';
  #unlockTimer = null;
  #reconnecting = false;
  #ended = false;
  #stopped = false;
  #progress = new Map();

  /**
   * startSeq: so luot lon nhat da co trong buoi hoc nay. Bat buoc phai truyen
   * khi hoc tiep mot buoi dang do — db.saveMessage upsert theo (session_id,
   * seq), nen bat dau lai tu 0 se ghi de len chinh cac luot cu.
   */
  constructor({ sessionId, lesson, audioElement, handlers, startSeq = 0 }) {
    this.sessionId = sessionId;
    this.lesson = lesson;
    this.audioElement = audioElement;
    this.on = handlers;
    this.#seq = startSeq;
  }

  // ------------------------------------------------------------- lifecycle

  /** resume=true: noi lai mot buoi dang do thay vi bat dau tu dau. */
  async start({ resume = false } = {}) {
    this.on.status('connecting');

    this.#micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    this.#ctx = new AudioContext();
    await this.#ctx.audioWorklet.addModule('/js/pcm-worklet.js');
    if (this.#ctx.state === 'suspended') await this.#ctx.resume();

    this.#micRec = await TrackRecorder.create(this.#ctx, this.#micStream);

    await this.#connect({ resume });
    this.on.status('live');
    this.#setPttState('ready');
  }

  async #connect({ resume }) {
    const token = await api.getToken(this.sessionId, resume);

    for (const p of token.progress ?? []) {
      this.#progress.set(p.objectiveId, p);
    }
    this.on.progress(this.progressList());

    this.#conn = new RealtimeConnection({
      onEvent: (e) => this.#handleEvent(e),
      onRemoteStream: (stream) => this.#attachRemote(stream),
      onDisconnect: (state) => this.#handleDisconnect(state),
    });

    await this.#conn.connect({
      clientSecret: token.clientSecret,
      micStream: this.#micStream,
    });

    // Push-to-talk: mic im cho toi khi user giu nut. Track van nam trong
    // WebRTC (chi phat ra khoang lang) nen bat/tat khong phai thuong luong
    // lai SDP — re hon nhieu so voi them/bot track.
    this.#conn.setMicEnabled(false);

    if (resume) await this.#seedConversation(token.seedItems);
  }

  async #attachRemote(stream) {
    this.audioElement.srcObject = stream;
    await this.audioElement.play().catch(() => {});
    // Recorder moi cho moi ket noi — dong ho cua no bat dau lai tu 0,
    // nen moi luot AI phai nho recorder ma no thuoc ve.
    this.#aiRec = await TrackRecorder.create(this.#ctx, stream);
  }

  /**
   * Sau khi reconnect: bom lai vai luot gan nhat vao conversation moi.
   * Phan lich su cu hon da duoc nen thanh tom tat va nhet san trong
   * instructions o server, nen o day khong replay toan bo.
   */
  async #seedConversation(seedItems) {
    for (const item of seedItems ?? []) {
      this.#conn.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: item.role,
          content: [
            item.role === 'user'
              ? { type: 'input_text', text: item.text }
              : { type: 'output_text', text: item.text },
          ],
        },
      });
      await sleep(30);
    }

    // Khong goi response.create o day: push-to-talk nghia la AI chi noi khi
    // user bam nut. Ke ca vua rot mang xong hay vua mo lai buoi hoc cu, quyen
    // mo loi van thuoc ve user.
  }

  async #handleDisconnect(state) {
    if (this.#ended || this.#reconnecting) return;
    this.#reconnecting = true;
    this.#setPttState('locked');
    this.#ptt = null;
    this.#activeResponse = null;
    this.#hintsResponseId = null;
    this.#pendingUser = [];

    console.warn('[rtc] mat ket noi:', state);

    for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
      if (this.#ended) return;
      this.on.status('reconnecting', { attempt: attempt + 1, total: BACKOFF_MS.length });
      await sleep(BACKOFF_MS[attempt]);
      if (this.#ended) return;

      try {
        this.#conn?.close();
        await this.#connect({ resume: true });
        this.#reconnecting = false;
        this.on.status('live', { resumed: true });
        this.#setPttState('ready');
        return;
      } catch (err) {
        console.warn(`[rtc] thu lai lan ${attempt + 1} that bai:`, err.message);
      }
    }

    this.#reconnecting = false;
    this.on.status('error', {
      message: 'Không kết nối lại được. Bài học đã lưu, bạn có thể kết thúc để xem tổng kết.',
    });
  }

  /** Ngat ket noi va tra micro. Tach khoi cham diem de cham diem hong con retry duoc. */
  async stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#ended = true;
    clearTimeout(this.#unlockTimer);
    this.#setPttState('locked');
    this.#ptt = null;
    this.#conn?.close();

    // Doi cac doan audio dang cat/upload kip hoan tat
    await sleep(400);

    this.#micRec?.stop();
    this.#aiRec?.stop();
    this.#micStream?.getTracks().forEach((t) => t.stop());
    await this.#ctx?.close().catch(() => {});
  }

  async finish(reason = 'manual') {
    await this.stop();
    this.on.status('grading');
    const { summary } = await api.endSession(this.sessionId, reason);
    this.on.status('ended');
    return summary;
  }

  // ---------------------------------------------------------------- events

  #handleEvent(event) {
    switch (event.type) {
      case 'error':
        console.error('[realtime] server error:', event.error);
        // Commit hong (vd doan rong) thi khong co response nao tra ve — mo lai
        // nut thay vi de user ket o trang thai "dang cho AI" mai mai.
        if (this.#pttState === 'thinking' && !this.#activeResponse) this.#setPttState('ready');
        break;

      case 'conversation.item.input_audio_transcription.completed':
        this.#onUserTranscript(event.transcript ?? '');
        break;

      case 'conversation.item.input_audio_transcription.failed':
        this.#pendingUser.shift();
        break;

      case 'response.created':
        this.#onResponseCreated(event.response);
        break;

      // GA doi ten event; ho tro ca hai de khong phu thuoc phien ban
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (this.#activeResponse) {
          this.#activeResponse.text = (this.#activeResponse.text ?? '') + (event.delta ?? '');
          this.on.messageUpdate(this.#activeResponse.seq, this.#activeResponse.text);
        }
        break;

      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (this.#activeResponse) this.#activeResponse.text = event.transcript ?? '';
        break;

      case 'response.function_call_arguments.done':
        this.#onToolCall(event);
        break;

      case 'response.done':
        this.#onResponseDone(event.response);
        break;
    }
  }

  // ------------------------------------------------------- push-to-talk

  /** 'locked' | 'ready' | 'recording' | 'thinking' | 'ai'. */
  get pttState() {
    return this.#pttState;
  }

  #setPttState(state) {
    if (this.#pttState === state) return;
    this.#pttState = state;
    this.on.pttState?.(state);
  }

  /**
   * User giu nut — mo mic, bat dau mot luot noi.
   * Tra ve false neu chua den luot (dang ket noi, hoac AI dang noi).
   */
  startTalking() {
    if (this.#ended || this.#pttState !== 'ready') return false;

    // Trong luc mic tat, buffer phia server van dang nhan khoang lang.
    // Khong don sach thi doan commit se co mot dau im lang dai lam
    // transcription doan sai.
    this.#conn?.send({ type: 'input_audio_buffer.clear' });
    this.#conn?.setMicEnabled(true);

    const seq = ++this.#seq;
    this.#ptt = { seq, rec: this.#micRec, startMs: this.#micRec.nowMs(), endMs: null };

    this.#setPttState('recording');
    this.on.speaking('user');
    this.on.message({ seq, role: 'user', text: '', pending: true });
    return true;
  }

  /**
   * User tha nut — dong mic, chot doan va giao luot cho AI.
   *
   * Khong commit ngay lap tuc: goi audio cuoi cung con dang tren duong qua
   * WebRTC, commit som se cut mat duoi cau.
   */
  async stopTalking() {
    if (this.#pttState !== 'recording') return;

    const entry = this.#ptt;
    this.#ptt = null;
    this.#conn?.setMicEnabled(false);
    this.#setPttState('thinking');
    this.on.speaking(null);
    if (!entry) return;

    await sleep(PTT_TAIL_MS);
    entry.endMs = entry.rec.nowMs();

    // Nguong thap hon nguong cat cau: o day chi can biet "co noi gi khong",
    // sai lech ve phia gui di van hon la nuot mat cau noi nho cua user.
    const tooShort = entry.endMs - entry.startMs < PTT_MIN_MS;
    if (tooShort || !entry.rec.hasVoice(entry.startMs, entry.endMs, 0.006)) {
      // Bam nham hoac giu nut ma khong noi gi: vut doan di, dung lam ban
      // hoi thoai va dung ton mot luot goi model.
      this.#conn?.send({ type: 'input_audio_buffer.clear' });
      this.on.messageRemove(entry.seq);
      if (!this.#ended) this.#setPttState('ready');
      return;
    }

    this.#pendingUser.push(entry);

    this.#releaseHintsSlot();
    this.#conn?.send({ type: 'input_audio_buffer.commit' });
    this.#conn?.send({ type: 'response.create' });
  }

  /**
   * User go chu thay vi noi. Chen thang vao hoi thoai roi xin AI tra loi bang
   * giong nhu mot luot binh thuong.
   *
   * Duong nay khong di qua transcribe nao ca — chu user go chinh la chu, nen
   * no mien nhiem voi chuyen transcribe nghe sot.
   */
  sendText(raw) {
    const text = (raw ?? '').trim();
    if (this.#ended || this.#pttState !== 'ready' || !text) return false;

    const seq = ++this.#seq;
    this.on.message({ seq, role: 'user', text, pending: false });

    this.#releaseHintsSlot();
    this.#conn?.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    this.#conn?.send({ type: 'response.create' });
    this.#setPttState('thinking');

    // Khong co audio nen khong cat/upload WAV — luot nay se khong duoc cham
    // phat am, con ngu phap/tu vung thi van cham binh thuong.
    api
      .saveMessage(this.sessionId, { seq, role: 'user', text })
      .catch((e) => console.warn('[save] message text:', e.message));

    if (text.split(/\s+/).length >= 3) this.#hintLevel = 0;
    return true;
  }

  /**
   * Nhuong cho cho mot response moi. Session chi cho mot response chay mot
   * luc, va luot cua user luon uu tien hon goi y chu.
   */
  #releaseHintsSlot() {
    if (this.#hintsResponseId) {
      this.#conn?.send({ type: 'response.cancel', response_id: this.#hintsResponseId });
      this.#hintsResponseId = null;
    }
    // Yeu cau goi y chua kip thanh response thi vut luon, khong de no nhan
    // nham response cua chinh luot nay.
    this.#hintsPending = false;
  }

  /** Mo lai nut sau khi AI da noi het cau. */
  #unlockPtt() {
    clearTimeout(this.#unlockTimer);
    this.#unlockTimer = null;
    if (this.#ended) return;
    if (this.#pttState === 'ai' || this.#pttState === 'thinking') this.#setPttState('ready');
  }

  // ------------------------------------------------------------ user turns

  async #onUserTranscript(text) {
    const entry = this.#pendingUser.shift();
    if (!entry) return;

    entry.endMs ??= entry.rec.nowMs();
    this.on.messageUpdate(entry.seq, text, { pending: false });

    // Noi duoc mot cau tu te thi reset thang goi y ve 0
    if (text.trim().split(/\s+/).length >= 3) this.#hintLevel = 0;

    await api
      .saveMessage(this.sessionId, {
        seq: entry.seq,
        role: 'user',
        text,
        durationMs: entry.endMs - entry.startMs,
      })
      .catch((e) => console.warn('[save] message user:', e.message));

    this.#cutAndUpload(entry, 'user');
  }

  // ------------------------------------------------------------- ai turns

  #onResponseCreated(response) {
    // Response ngoai luong (goi y chu tren man hinh) khong phai mot luot noi.
    //
    // Khong tin vao metadata: server KHONG doi metadata ve trong response.created
    // / response.done, nen loc theo metadata la hong — goi y bi tinh thanh mot
    // luot AI that, sinh ra bubble rong va mot file audio toan im lang.
    // Server chi chay mot response mot luc, nen response.created dau tien sau
    // khi ta gui yeu cau goi y chinh la no.
    if (response?.metadata?.purpose === 'hints' || this.#hintsPending) {
      this.#hintsPending = false;
      this.#hintsResponseId = response?.id ?? null;
      return;
    }

    this.#setPttState('ai');
    this.on.speaking('ai');

    const seq = ++this.#seq;
    this.#activeResponse = {
      id: response?.id,
      seq,
      rec: this.#aiRec,
      startMs: this.#aiRec?.nowMs() ?? 0,
      text: '',
    };
    this.on.message({ seq, role: 'assistant', text: '', pending: true });
  }

  async #onResponseDone(response) {
    const isHints =
      response?.metadata?.purpose === 'hints' ||
      (this.#hintsResponseId !== null && response?.id === this.#hintsResponseId);

    if (isHints) {
      this.#hintsResponseId = null;
      this.#applyHints(response);
      return;
    }

    const entry = this.#activeResponse;
    this.#activeResponse = null;
    this.on.speaking(null);
    if (!entry) {
      this.#unlockPtt();
      return;
    }

    // Nut mo lai trong #finalizeAssistantAudio, khi audio that su het tieng.
    // Day chi la tran an toan phong khi viec do im lang khong chot duoc.
    clearTimeout(this.#unlockTimer);
    this.#unlockTimer = setTimeout(() => this.#unlockPtt(), PTT_UNLOCK_FAILSAFE_MS);

    if (!entry.text) entry.text = extractTranscript(response) ?? '';
    this.on.messageUpdate(entry.seq, entry.text, { pending: false });

    await api
      .saveMessage(this.sessionId, { seq: entry.seq, role: 'assistant', text: entry.text })
      .catch((e) => console.warn('[save] message ai:', e.message));

    this.#finalizeAssistantAudio(entry);
    this.#requestHints();
  }

  #onToolCall(event) {
    let args = {};
    try {
      args = JSON.parse(event.arguments || '{}');
    } catch {
      return;
    }

    if (event.name === 'mark_objective') {
      const record = {
        objectiveId: args.objective_id,
        status: args.status,
        evidence: args.evidence,
        messageSeq: this.#seq,
      };
      // Model chi de xuat; client moi la noi chot trang thai va hien thi.
      this.#progress.set(record.objectiveId, record);
      this.on.progress(this.progressList());
      api.saveProgress(this.sessionId, record).catch((e) => console.warn('[save] progress:', e.message));
      this.#maybeOfferFinish();
    }

    if (event.name === 'end_lesson') {
      this.on.canFinish({ reason: args.reason, note: args.closing_note });
    }

    // Tra ket qua tool vao conversation nhung khong goi response.create:
    // model da noi xong trong chinh luot nay, khong can cho no noi them.
    this.#conn?.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: event.call_id,
        output: JSON.stringify({ ok: true }),
      },
    });
  }

  // -------------------------------------------------------------- diem dung

  /** Diem dung: du muc tieu bat buoc VA du so luot toi thieu. */
  #maybeOfferFinish() {
    const required = this.lesson.objectives.filter((o) => o.required);
    const allDone = required.every((o) => this.#progress.get(o.id)?.status === 'done');
    const enoughTurns = this.#seq >= this.lesson.minTurns;

    if (allDone && enoughTurns) {
      this.on.canFinish({
        reason: 'objectives_complete',
        note: 'Bạn đã hoàn thành tất cả mục tiêu của bài. Có thể kết thúc bất cứ lúc nào.',
      });
    }
  }

  progressList() {
    return this.lesson.objectives.map((o) => ({
      ...o,
      status: this.#progress.get(o.id)?.status ?? 'pending',
      evidence: this.#progress.get(o.id)?.evidence ?? null,
    }));
  }

  // ----------------------------------------------------------------- hints

  /**
   * Goi y hien tren man hinh: dung response ngoai luong (conversation: 'none')
   * nen model van doc duoc ngu canh nhung khong chen them luot noi nao.
   */
  #requestHints() {
    if (this.#hintsPending) return;
    this.#hintsPending = true;
    this.#conn?.send({
      type: 'response.create',
      response: {
        conversation: 'none',
        output_modalities: ['text'],
        metadata: { purpose: 'hints' },
        instructions:
          `You are helping a Vietnamese learner at CEFR level ${this.lesson.level}. ` +
          'Look at the last thing the coach said, and write 2 different short replies the learner ' +
          'could say next. Each under 12 words, natural spoken English, appropriate for that level. ' +
          'Respond with ONLY a JSON array of 2 strings, nothing else.',
      },
    });
  }

  #applyHints(response) {
    const raw = extractText(response);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim());
      if (Array.isArray(parsed)) this.on.hints(parsed.slice(0, 3).map(String));
    } catch {
      /* model tra ve khong dung JSON — bo qua, goi y khong phai tinh nang bat buoc */
    }
  }

  /**
   * Goi y bang giong noi, leo thang 3 nac de user van phai tu nghi.
   *
   * Day la con duong duy nhat con lai de AI chu dong noi: khong con timer im
   * lang nao tu goi no nua, user phai bam nut Goi y.
   */
  requestVoiceHint() {
    if (this.#ended || this.#pttState !== 'ready') return;
    this.#setPttState('thinking');

    this.#hintLevel = Math.min(3, this.#hintLevel + 1);
    this.on.hintUsed(this.#hintLevel);
    api.countHint(this.sessionId).catch(() => {});

    this.#conn?.send({
      type: 'response.create',
      response: { instructions: HINT_INSTRUCTIONS[this.#hintLevel] },
    });
  }

  // ----------------------------------------------------------------- audio

  /**
   * `response.done` chi bao model sinh xong text/audio — audio van dang phat not
   * qua WebRTC. Doi den khi im lang moi cat, neu khong se hut mat duoi cau.
   */
  async #finalizeAssistantAudio(entry) {
    const rec = entry.rec;
    if (!rec) {
      this.#unlockPtt();
      return;
    }

    const deadline = performance.now() + 12000;
    let endMs = null;

    while (performance.now() < deadline) {
      await sleep(300);
      const last = rec.lastVoiceMs(entry.startMs, rec.nowMs());
      if (last !== null && rec.nowMs() - last > 700) {
        endMs = last + 200;
        break;
      }
    }
    entry.endMs = endMs ?? rec.nowMs();

    // AI da that su ngung tieng — den day moi tra nut lai cho user.
    this.#unlockPtt();

    const firstVoice = rec.firstVoiceMs(entry.startMs, entry.endMs);
    if (firstVoice !== null) entry.startMs = Math.max(entry.startMs, firstVoice - 150);

    this.#cutAndUpload(entry, 'assistant');
  }

  /** Cat doan audio cua mot message va day len server ngay, khong doi cuoi buoi. */
  async #cutAndUpload(entry, role) {
    try {
      const blob = entry.rec?.sliceToWav(entry.startMs, entry.endMs);
      if (!blob) return;
      const durationMs = entry.endMs - entry.startMs;
      const { audioUrl } = await api.uploadAudio(
        this.sessionId,
        entry.seq,
        role,
        durationMs,
        blob
      );
      this.on.messageAudio(entry.seq, audioUrl, durationMs);
    } catch (err) {
      console.warn(`[audio] khong luu duoc doan seq=${entry.seq}:`, err.message);
    }
  }
}

// -------------------------------------------------------------------- utils

function extractTranscript(response) {
  for (const item of response?.output ?? []) {
    for (const c of item.content ?? []) {
      if (c.transcript) return c.transcript;
    }
  }
  return null;
}

function extractText(response) {
  for (const item of response?.output ?? []) {
    for (const c of item.content ?? []) {
      if (c.type === 'output_text' || c.type === 'text') return c.text;
    }
  }
  return null;
}
