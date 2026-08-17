import { api, ApiError, putAudioToS3 } from './api.ts';
import { RealtimeConnection } from './realtime.ts';
import type { RealtimeEvent } from './realtime.ts';
import { TrackRecorder } from './recorder.ts';
import { SpeechQueue } from './speech-queue.ts';

import type {
  Character,
  Lesson,
  ObjectiveProgress,
  ProgressRecord,
  ProgressStatus,
  Quota,
  Role,
  SeedItem,
  TtsGrant,
  UploadGrant,
  VoiceMode,
} from '../../shared/types.ts';
import { clampSpeed } from '../../shared/speed.ts';
import { aiSpeaksItself, VOICE_MODE_DEFAULT } from '../../shared/voice-mode.ts';

/** Trang thai nut push-to-talk. Chi 'ready' moi cho bat dau noi. */
export type PttState = 'locked' | 'ready' | 'recording' | 'thinking' | 'ai';

export type SpeakingWho = 'user' | 'ai' | null;

export interface SessionHandlers {
  status: (state: string, detail?: Record<string, unknown>) => void;
  speaking: (who: SpeakingWho) => void;
  message: (m: { seq: number; role: Role; text: string; pending: boolean }) => void;
  messageUpdate: (seq: number, text: string, opts?: { pending?: boolean }) => void;
  messageRemove: (seq: number) => void;
  messageAudio: (seq: number, url: string, durationMs: number) => void;
  progress: (list: ObjectiveProgress[]) => void;
  hints: (list: string[]) => void;
  hintUsed: (level: number) => void;
  /**
   * Du dieu kien ket thuc. `completed` chi true khi HOAN THANH THAT (du muc
   * tieu bat buoc), va chi true DUNG MOT LAN ca buoi — nguoi hoc xin dung
   * giua chung hay dang duoi thi khong phai luc chuc mung.
   */
  canFinish: (info: {
    reason?: string;
    note?: string;
    completed: boolean;
    doneCount: number;
    totalCount: number;
  }) => void;
  pttState?: (state: PttState) => void;
  quota?: (quota: Quota) => void;
  quotaExhausted?: () => void;
  /** Nhan vat cua buoi hoc. Goi mot lan khi bat tay xong. */
  character?: (character: Character) => void;
  /**
   * Mode da chot cho buoi nay, kem stream cua AI khi AI tu phat tieng.
   *
   * Goi sau moi lan bat tay (ke ca reconnect). `stream` la null o mode `polly`
   * — luc do tieng AI di ra tu the <audio> cua SpeechQueue chu khong tu WebRTC.
   */
  voiceMode?: (mode: VoiceMode, stream: MediaStream | null) => void;
}

/** Mot luot noi dang cho: moc thoi gian trong recorder de cat WAV ve sau. */
interface PendingTurn {
  seq: number;
  rec: TrackRecorder;
  startMs: number;
  endMs: number | null;
}

interface ActiveResponse {
  id: string | undefined;
  seq: number;
  text: string;
}

/** Lich thu lai khi mat ket noi. */
const BACKOFF_MS = [800, 2000, 4000, 8000, 15000];

/** Do tre truoc khi commit, de goi audio cuoi kip di het qua WebRTC. */
const PTT_TAIL_MS = 300;

/**
 * Do tre truoc khi chot duoi luot AI, khi ghi lai tieng AI.
 *
 * Cung ly do voi PTT_TAIL_MS nhung nguoc chieu: `output_audio_buffer.stopped`
 * noi ve luc server gui xong, jitter buffer ben nay con phat not.
 */
const AI_TAIL_MS = 400;

/** Doan ngan hon nguong nay coi nhu bam nham — khong gui. */
const PTT_MIN_MS = 300;

/** Lich thu lai khi day audio hong. Ngan hon BACKOFF_MS: mat mot doan audio
 * khong lam hong buoi hoc, khong dang giu micro cua user lai 30 giay. */
const UPLOAD_RETRY_MS = [0, 1000, 3000];

/** Tran cho stop() doi upload. Qua nguong nay thi coi nhu mang chet — vao man
 * tong ket con hon treo o man dang hoc. */
const UPLOAD_DRAIN_TIMEOUT_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `catch (err)` cho ra `unknown` duoi strict — boc mot lan o day. */
const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Thu lai theo lich tren. Loi 4xx thi dung ngay: presigned policy sai hoac key
 * bi tu choi thi thu them chi ton them thoi gian, khong bao gio thanh cong.
 */
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (const wait of UPLOAD_RETRY_MS) {
    if (wait) await sleep(wait);
    try {
      return await fn();
    } catch (err) {
      last = err;
      const status = err instanceof ApiError ? err.status : 0;
      if (status >= 400 && status < 500) break;
    }
  }
  throw last;
}

const HINT_INSTRUCTIONS: Record<number, string> = {
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
  #conn: RealtimeConnection | null = null;
  #ctx: AudioContext | null = null;
  #micStream: MediaStream | null = null;
  #micRec: TrackRecorder | null = null;

  #seq = 0;
  #pendingUser: PendingTurn[] = [];
  #activeResponse: ActiveResponse | null = null;
  #hintsResponseId: string | null = null;
  #hintsPending = false;
  #hintLevel = 0;
  #ptt: PendingTurn | null = null;
  #pttState: PttState = 'locked';
  #reconnecting = false;
  #ended = false;
  #stopped = false;
  #progress = new Map<string, ProgressRecord>();

  /** Da chuc mung hoan thanh bai hoc chua. Ca buoi chi mot lan. */
  #congratulated = false;

  /** Toc do doc cua AI. Bat dau tu mac dinh cua bai hoc. */
  #speed: number;

  /** Bien text cua AI thanh tieng noi qua nha TTS (Google, hoac Polly). */
  readonly #speech: SpeechQueue;

  /** Nhan vat AI. null cho toi khi bat tay xong. */
  #character: Character | null = null;

  /**
   * Duong dua tieng AI ra loa. Server chot, client chi doc — xem
   * `shared/voice-mode.ts`. Giu mac dinh cho toi khi bat tay xong.
   */
  #voiceMode: VoiceMode = VOICE_MODE_DEFAULT;

  /** Stream cua AI o mode `openai`. null o hai mode TTS client. */
  #remoteStream: MediaStream | null = null;

  /**
   * Ghi tieng AI tu stream WebRTC. Chi dung khi AI tu phat tieng VA nguoi hoc
   * bat "Luu giong AI" — khong bat thi khong dung recorder nao, va do la ly do
   * no lazy: mot AudioWorklet chay suot buoi khong phai thu dung bat san.
   *
   * Hai mode TTS client khong di qua day: tieng AI o do la mp3 tu nha TTS, duoc
   * gom o `#collectTurnAudio`.
   */
  #aiRec: TrackRecorder | null = null;
  #aiTurnStartMs: number | null = null;

  /**
   * Mode `openai`: server dang gui audio cho luot nay.
   *
   * Can no vi `output_audio_buffer.stopped` chi den khi CO audio. Luot chi goi
   * tool, hoac response bi huy, thi khong co event nao ca — va neu chi ngoi doi
   * no thi nut micro khoa vinh vien.
   */
  #outputAudioActive = false;

  /**
   * Cac khuc mp3 cua luot AI dang noi, gom lai de day len S3 khi bat luu.
   *
   * Mot luot noi bi cat thanh nhieu khuc nhung chi ung voi MOT message, nen
   * phai noi lai truoc khi luu. MP3 la dong frame lien tiep nen noi thang byte
   * la phat duoc, khong phai giai ma roi ma hoa lai.
   */
  #turnAudio: { blobs: Blob[]; durationMs: number } | null = null;

  /** Message dang duoc doc. Hang doi canh sau `response.done` nen phai nho. */
  #speakingSeq: number | null = null;

  /** Bat thi luu mp3 cua AI len S3; tat thi nghe lai bang cach doc lai. */
  #saveAiAudio = false;

  /** Quyen ghi thang len S3. null = server dang luu audio tren dia. */
  #uploadGrant: UploadGrant | null = null;
  /** Cac doan dang cat/day. stop() phai doi het truoc khi tha micro. */
  #pendingUploads = new Set<Promise<unknown>>();

  readonly sessionId: string;
  readonly lesson: Lesson;
  readonly audioElement: HTMLAudioElement;
  readonly on: SessionHandlers;

  /**
   * startSeq: so luot lon nhat da co trong buoi hoc nay. Bat buoc phai truyen
   * khi hoc tiep mot buoi dang do — db.saveMessage upsert theo (session_id,
   * seq), nen bat dau lai tu 0 se ghi de len chinh cac luot cu.
   */
  constructor({
    sessionId,
    lesson,
    audioElement,
    handlers,
    startSeq = 0,
    speed,
  }: {
    sessionId: string;
    lesson: Lesson;
    audioElement: HTMLAudioElement;
    handlers: SessionHandlers;
    startSeq?: number;
    speed?: number;
  }) {
    this.sessionId = sessionId;
    this.lesson = lesson;
    this.audioElement = audioElement;
    this.on = handlers;
    this.#seq = startSeq;
    // Nguoi hoc da tung chinh thi dung so do, chua thi lay mac dinh cua bai.
    this.#speed = clampSpeed(speed ?? lesson.speed);

    this.#speech = new SpeechQueue(audioElement, {
      onDrain: () => this.#onSpeechDone(),
      onError: (message) => console.warn('[tts]', message),
      refreshGrant: () => this.#refreshTtsGrant(),
      onAudio: (blob, _text, durationMs) => this.#collectTurnAudio(blob, durationMs),
    });
    this.#speech.setRate(this.#speed);
  }

  get character(): Character | null {
    return this.#character;
  }

  get voiceMode(): VoiceMode {
    return this.#voiceMode;
  }

  // -------------------------------------------------------- toc do AI doc

  get speed(): number {
    return this.#speed;
  }

  /**
   * Doi toc do doc cua AI.
   *
   * Mode 'google' / 'polly': `playbackRate` cua the <audio> — an NGAY, ke ca
   * giua chung mot cau dang doc.
   *
   * Mode 'openai': `audio.output.speed` cua session — an TU LUOT SAU. Realtime
   * API khong co duong nao doi toc do cua audio dang phat, va do la mot phan
   * cai gia cua mode nay.
   *
   * Tra ve gia tri that su duoc dat (da chan trong 0.25–1.5).
   */
  setSpeed(value: number): number {
    this.#speed = clampSpeed(value, this.#speed);
    this.#applyRate();
    return this.#speed;
  }

  /**
   * Toc do that = slider x he so nen cua nhan vat.
   *
   * Leo doc nhanh hon mot chut (1.05) la mot net tinh cach, khong phai cai
   * nguoi hoc chinh. Nen no nhan vao chu khong de len.
   */
  #applyRate(): void {
    const rate = clampSpeed(this.#speed * (this.#character?.speed ?? 1));

    if (!aiSpeaksItself(this.#voiceMode)) {
      this.#speech.setRate(rate);
      return;
    }

    this.#conn?.send({
      type: 'session.update',
      session: { type: 'realtime', audio: { output: { speed: rate } } },
    });
  }

  // Bo chon giong da bo: khong he co cho nao goi `setVoice`, va giu mot nguon
  // su that thu hai ben canh grant chi tao ra duong lech. Giong gio di theo
  // grant — xem `speech-queue.ts`.

  /**
   * Bat/tat luu mp3 cua AI len S3.
   *
   * Tat (mac dinh): khong luu gi, man tong ket doc lai bang nha TTS — ton tien
   * moi lan bam nghe, doi lai khong ton luu tru.
   * Bat: giu file, nghe lai khong ton them tien nhung ton luu tru.
   */
  setSaveAiAudio(enabled: boolean): void {
    this.#saveAiAudio = enabled;
    // Bat giua buoi thi dung recorder ngay. Tat thi KHONG go: `TrackRecorder`
    // khong dung lai roi chay tiep duoc, va bat/tat vai lan trong mot buoi la
    // chuyen thuong — go rong roi dung lai moi lan la dat hon nhieu so voi de
    // no chay khong. Luot nao khong luu thi don gian la khong cat.
    void this.#ensureAiRecorder();
  }

  get saveAiAudio(): boolean {
    return this.#saveAiAudio;
  }

  // ------------------------------------------------------------- han muc

  #callId: string | null = null;
  #presence: EventSource | null = null;

  /**
   * Bao call_id ve server roi mo kenh presence.
   *
   * Kenh nay dut la server cat cuoc goi (co an han), nen no khong phai thu
   * "nen co" — mat no la mat quyen goi tiep.
   */
  async #registerCall(): Promise<void> {
    const callId = this.#conn?.callId;
    if (!callId) {
      console.warn('[quota] khong lay duoc call_id — server se khong hen gio cat duoc');
      return;
    }
    this.#callId = callId;

    try {
      this.on.quota?.(await api.startCall(this.sessionId, callId));
    } catch (err) {
      console.warn('[quota] khong dang ky duoc cuoc goi:', errorMessage(err));
    }

    this.#openPresence(callId);
  }

  #openPresence(callId: string): void {
    this.#closePresence();
    // EventSource tu ket noi lai khi mang chop — dung tu viet vong retry.
    const es = new EventSource(`/api/calls/${callId}/presence`);
    this.#presence = es;

    es.addEventListener('sync', (e) => {
      try {
        this.on.quota?.(JSON.parse((e as MessageEvent<string>).data) as Quota);
      } catch {
        /* bo qua goi tin hong */
      }
    });

    es.addEventListener('ended', () => {
      this.#closePresence();
      this.#onQuotaCut();
    });
  }

  #closePresence(): void {
    this.#presence?.close();
    this.#presence = null;
  }

  /** Server da cat vi het gio. Dung han, khong thu ket noi lai. */
  #onQuotaCut(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#setPttState('locked');
    this.#conn?.close();
    this.on.quotaExhausted?.();
  }

  // ------------------------------------------------------------- lifecycle

  /** resume=true: noi lai mot buoi dang do thay vi bat dau tu dau. */
  async start({ resume = false }: { resume?: boolean } = {}): Promise<void> {
    this.on.status('connecting');

    this.#micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    this.#ctx = new AudioContext();
    await this.#ctx.audioWorklet.addModule('/js/pcm-worklet.js');
    if (this.#ctx.state === 'suspended') await this.#ctx.resume();

    this.#micRec = await TrackRecorder.create(this.#ctx!, this.#micStream);

    await this.#connect({ resume });
    this.on.status('live');
    this.#setPttState('ready');
  }

  async #connect({ resume }: { resume: boolean }): Promise<void> {
    const token = await api.getToken(this.sessionId, resume);
    // Cap lai moi lan connect, ke ca reconnect: buoi hoc keo dai hon han cua
    // grant thi quyen ghi cu da het, va lan xin token nay la dip re nhat de
    // co cai moi.
    this.#uploadGrant = token.uploadGrant ?? null;
    // Ky mot lan cho ca buoi. Cap lai o day la du: reconnect di qua chinh
    // duong nay, va han cua grant dai hon moi buoi hoc.
    this.#speech.setGrant(token.ttsGrant ?? null);
    this.#character = token.character;
    // Server chot mode, khong phai client. Doc lai o moi lan connect vi
    // reconnect di qua chinh duong nay — mode phai giu nguyen ca buoi.
    this.#voiceMode = token.voiceMode;
    this.on.character?.(token.character);

    for (const p of token.progress ?? []) {
      this.#progress.set(p.objectiveId, p);
    }
    this.on.progress(this.progressList());

    // Hai mode TTS client: KHONG dang ky onRemoteStream — session cau hinh
    // output_modalities:["text"] nen OpenAI khong gui audio ve, va the <audio>
    // thuoc ve SpeechQueue.
    //
    // Mode 'openai': stream cua OpenAI cam thang vao chinh the <audio> do.
    // Mot the cho ca hai mode la co y: `fake-mouth.ts` chi tao duoc DUNG MOT
    // source node tren mot the, vinh vien.
    this.#conn = new RealtimeConnection({
      onEvent: (e) => this.#handleEvent(e),
      onDisconnect: (state) => this.#handleDisconnect(state),
      onRemoteStream:
        aiSpeaksItself(this.#voiceMode) ? (stream) => this.#attachRemote(stream) : undefined,
    });

    await this.#conn.connect({
      clientSecret: token.clientSecret,
      micStream: this.#micStream!,
    });

    // He so toc do cua nhan vat nhan voi slider — phai ap lai sau khi biet
    // nhan vat, neu khong luot dau tien se doc bang toc do cua nguoi khac.
    //
    // Sau connect() chu khong truoc: mode 'openai' gui toc do bang
    // `session.update` qua data channel, ma truoc bat tay thi chua co kenh nao.
    this.#applyRate();

    if (!aiSpeaksItself(this.#voiceMode)) this.on.voiceMode?.(this.#voiceMode, null);

    // Push-to-talk: mic im cho toi khi user giu nut. Track van nam trong
    // WebRTC (chi phat ra khoang lang) nen bat/tat khong phai thuong luong
    // lai SDP — re hon nhieu so voi them/bot track.
    this.#conn.setMicEnabled(false);

    await this.#registerCall();

    if (resume) await this.#seedConversation(token.seedItems);
  }

  /**
   * Mode 'openai': cam stream cua OpenAI vao the <audio>.
   *
   * `srcObject` chu khong phai `src`: day la stream song, khong co file nao de
   * tai. Keo theo hai he qua ma cho khac trong file nay dua vao —
   *
   *   - `playbackRate` khong con nghia gi, nen toc do phai di bang
   *     `session.update` (xem #applyRate).
   *   - the <audio> khong bao gio phat `ended`, nen "AI noi xong" phai lay tu
   *     event `output_audio_buffer.stopped` (xem #handleEvent).
   */
  #attachRemote(stream: MediaStream): void {
    this.#remoteStream = stream;
    this.audioElement.srcObject = stream;
    // Bi chan autoplay thi im tieng ma khong co loi nao trong console. Buoi hoc
    // luon bat dau bang mot cu bam nut nen gan nhu khong xay ra, con neu co
    // that thi ghi log con hon im lang.
    this.audioElement.play().catch((err) => console.warn('[audio]', errorMessage(err)));
    void this.#ensureAiRecorder();
    this.on.voiceMode?.(this.#voiceMode, stream);
  }

  /**
   * Dung recorder cho tieng AI, neu can va neu chua co.
   *
   * Goi tu hai cho: luc cam stream (nguoi hoc da bat san cong tac), va luc
   * nguoi hoc bat cong tac giua buoi. Khong bat thi khong co AudioWorklet nao
   * chay cho AI ca.
   */
  async #ensureAiRecorder(): Promise<void> {
    if (this.#aiRec || !this.#saveAiAudio) return;
    if (!this.#remoteStream || !this.#ctx) return;
    try {
      this.#aiRec = await TrackRecorder.create(this.#ctx, this.#remoteStream);
    } catch (err) {
      // Ghi lai tieng AI la tien ich, khong phai duong song cua buoi hoc.
      console.warn('[audio] khong dung duoc recorder cho tieng AI:', errorMessage(err));
    }
  }

  /**
   * Cat luot AI vua noi xong thanh WAV va day len.
   *
   * `output_audio_buffer.stopped` noi ve luc SERVER gui xong, con tai nguoi hoc
   * thi jitter buffer con dang phat not — cat ngay tai moc do se hut mat duoi
   * cau. Doi mot nhip roi moi chot, giong het `PTT_TAIL_MS` ben phia user.
   *
   * Khong `await` o cho goi: nut micro phai mo ngay khi `stopped` toi, khong
   * cho phan cat.
   */
  #cutAiTurn(seq: number | null): void {
    const rec = this.#aiRec;
    const startMs = this.#aiTurnStartMs;
    this.#aiTurnStartMs = null;
    // `#saveAiAudio` phai hoi lai o day chu khong chi luc dung recorder:
    // recorder da chay thi khong go, nen tat cong tac giua buoi ma khong hoi
    // lai la van luu tiep.
    if (!rec || !this.#saveAiAudio || startMs === null || seq === null) return;

    void sleep(AI_TAIL_MS).then(() => {
      if (this.#stopped) return;
      void this.#cutAndUpload({ seq, rec, startMs, endMs: rec.nowMs() }, 'assistant');
    });
  }

  /**
   * Xin lai quyen goi nha TTS khi token het han hoac lech IP (doi Wi-Fi
   * sang 4G giua buoi hoc).
   *
   * Duong rieng chu khong goi lai `/token`: `/token` mint mot client secret
   * moi cua OpenAI va dung lai ca ngu canh resume — tat ca deu bi vut di neu
   * thu ta can chi la mot credential AWS.
   */
  async #refreshTtsGrant(): Promise<TtsGrant | null> {
    if (this.#ended) return null;
    try {
      return (await api.getTtsGrant(this.sessionId)).ttsGrant;
    } catch (err) {
      console.warn('[tts] khong xin lai duoc quyen goi nha TTS:', errorMessage(err));
      return null;
    }
  }

  /**
   * Sau khi reconnect: bom lai vai luot gan nhat vao conversation moi.
   * Phan lich su cu hon da duoc nen thanh tom tat va nhet san trong
   * instructions o server, nen o day khong replay toan bo.
   */
  async #seedConversation(seedItems: SeedItem[] | undefined): Promise<void> {
    for (const item of seedItems ?? []) {
      this.#conn?.send({
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

  async #handleDisconnect(state: RTCPeerConnectionState): Promise<void> {
    if (this.#ended || this.#reconnecting) return;
    this.#reconnecting = true;
    this.#setPttState('locked');
    this.#ptt = null;
    this.#activeResponse = null;
    this.#hintsResponseId = null;
    this.#pendingUser = [];
    // Doc not nua cau cua mot ket noi da chet chi lam nguoi hoc roi tri.
    this.#speech.cancel();
    this.#turnAudio = null;
    this.#speakingSeq = null;

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
        // Het han muc thi thu lai bao nhieu lan cung vo ich, va con hien sai
        // nguyen nhan cho user suot 30 giay backoff. Dung han o day.
        if (err instanceof ApiError && err.status === 429) {
          this.#reconnecting = false;
          this.#onQuotaCut();
          return;
        }
        console.warn(`[rtc] thu lai lan ${attempt + 1} that bai:`, errorMessage(err));
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
    this.#setPttState('locked');
    this.#ptt = null;
    // Truoc khi doi hang doi upload: `cancel()` co the sinh them mot doan can
    // day (khuc mp3 cuoi cua luot dang doc dang do).
    this.#flushTurnAudio();
    this.#speech.cancel();
    this.#closePresence();
    this.#conn?.close();

    // Mode 'openai': go stream ra khoi the <audio>. Khong go thi track da chet
    // van treo o do va the <audio> ket o trang thai dang phat mai mai.
    if (this.#remoteStream) {
      this.audioElement.srcObject = null;
      this.#remoteStream = null;
    }

    // Dong ban ghi ngay thay vi de server doi het an han — dung gio cua user
    // vao dung luc user thoi goi.
    if (this.#callId) {
      api
        .endCall(this.#callId)
        .then((quota) => this.on.quota?.(quota))
        .catch(() => {});
      this.#callId = null;
    }

    // Doi cac doan audio dang cat/upload kip hoan tat.
    //
    // Truoc day day la sleep(400) — mot con so doan, va gio thi khong doan noi
    // nua: duong S3 co hai chang (POST bucket roi confirm) cong them retry.
    // Doi dung hang doi, kem tran cung de mang chet khong treo man tong ket.
    await Promise.race([
      Promise.allSettled([...this.#pendingUploads]),
      sleep(UPLOAD_DRAIN_TIMEOUT_MS),
    ]);

    this.#micRec?.stop();
    this.#aiRec?.stop();
    this.#aiRec = null;
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

  #handleEvent(event: RealtimeEvent): void {
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

      // Session dat output_modalities:["text"] nen chu ve bang hai event dau.
      // Hai event audio_transcript giu lai lam luoi: neu cau hinh khong an
      // (phien ban API khac, hoac ai do bat lai giong) thi it nhat chu van
      // hien ra, thay vi mot bong bong rong khong ai hieu vi sao.
      //
      // Goi y chu tren man hinh cung di bang chinh cac event nay, nhung luc do
      // `#activeResponse` la null (xem #onResponseCreated) — do la thu duy nhat
      // tach hai dong chu ra khoi nhau.
      case 'response.output_text.delta':
      case 'response.text.delta':
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (this.#activeResponse) {
          const delta = event.delta ?? '';
          this.#activeResponse.text += delta;
          this.on.messageUpdate(this.#activeResponse.seq, this.#activeResponse.text);
          // Cat khuc va doc ngay, khong doi het cau tra loi.
          //
          // Chi o hai mode TTS client. Mode 'openai' cung di qua day — chu ve bang
          // `output_audio_transcript.delta` — nhung tieng thi OpenAI da phat
          // roi, day them vao hang doi la nghe hai giong chong len nhau.
          if (!aiSpeaksItself(this.#voiceMode)) this.#speech.push(delta);
        }
        break;

      // Hai event nay CHI co tren WebRTC, va chi o mode 'openai'.
      //
      // `stopped` la moc "AI noi xong" — server da xa het buffer audio, khong
      // con gi gui nua. Day la thu duong audio cu khong bao gio co: no phai
      // DOAN moc do bang mot vong do im lang 12 giay tren track, cong mot tran
      // an toan 8 giay phong khi doan truot.
      //
      // Con lech mot khoang: `stopped` noi ve luc SERVER gui xong, con tai
      // nguoi hoc thi jitter buffer con phat not vai chuc ms. Nho hon nhieu so
      // voi sai so cua vong do im lang, va doi lai khong ton CPU nao.
      case 'output_audio_buffer.started':
        this.#outputAudioActive = true;
        this.#aiTurnStartMs = this.#aiRec?.nowMs() ?? null;
        break;

      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.#outputAudioActive = false;
        // Cat doan truoc khi #onSpeechDone xoa #speakingSeq di.
        this.#cutAiTurn(this.#speakingSeq);
        this.#onSpeechDone();
        break;

      case 'response.output_text.done':
      case 'response.text.done':
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (this.#activeResponse) {
          this.#activeResponse.text = event.text ?? event.transcript ?? this.#activeResponse.text;
        }
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

  #setPttState(state: PttState): void {
    if (this.#pttState === state) return;
    this.#pttState = state;
    this.on.pttState?.(state);
  }

  /**
   * User giu nut — mo mic, bat dau mot luot noi.
   * Tra ve false neu chua den luot (dang ket noi, hoac AI dang noi).
   */
  startTalking(): boolean {
    if (this.#ended || this.#pttState !== 'ready') return false;

    // Trong luc mic tat, buffer phia server van dang nhan khoang lang.
    // Khong don sach thi doan commit se co mot dau im lang dai lam
    // transcription doan sai.
    this.#conn?.send({ type: 'input_audio_buffer.clear' });
    this.#conn?.setMicEnabled(true);

    const seq = ++this.#seq;
    this.#ptt = { seq, rec: this.#micRec!, startMs: this.#micRec!.nowMs(), endMs: null };

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
  async stopTalking(): Promise<void> {
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
  sendText(raw: string): boolean {
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
  #releaseHintsSlot(): void {
    if (this.#hintsResponseId) {
      this.#conn?.send({ type: 'response.cancel', response_id: this.#hintsResponseId });
      this.#hintsResponseId = null;
    }
    // Yeu cau goi y chua kip thanh response thi vut luon, khong de no nhan
    // nham response cua chinh luot nay.
    this.#hintsPending = false;
  }

  /** Mo lai nut sau khi AI da noi het cau. */
  #unlockPtt(): void {
    if (this.#ended) return;
    if (this.#pttState === 'ai' || this.#pttState === 'thinking') this.#setPttState('ready');
  }

  // ------------------------------------------------------------ user turns

  async #onUserTranscript(text: string): Promise<void> {
    const entry = this.#pendingUser.shift();
    if (!entry) return;

    entry.endMs ??= entry.rec.nowMs();

    // Transcribe co luc tra ve rong. Bubble trong trong nhu app hong, ma audio
    // thi van con — noi thang ra la khong nghe ro, va van giu doan ghi de user
    // bam nghe lai duoc.
    const heard = text.trim();
    this.on.messageUpdate(entry.seq, heard || '(không nghe rõ)', { pending: false });

    // Noi duoc mot cau tu te thi reset thang goi y ve 0
    if (heard.split(/\s+/).length >= 3) this.#hintLevel = 0;

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

  #onResponseCreated(response: RealtimeEvent['response']): void {
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
    // Luot moi, buffer audio chua chay. Dat lai o day chu khong tin vao lan
    // truoc: mot response bi huy giua chung co the de co bang true.
    this.#outputAudioActive = false;

    const seq = ++this.#seq;
    this.#activeResponse = { id: response?.id, seq, text: '' };
    this.#speakingSeq = seq;
    this.#turnAudio = this.#saveAiAudio ? { blobs: [], durationMs: 0 } : null;
    this.on.message({ seq, role: 'assistant', text: '', pending: true });
  }

  async #onResponseDone(response: RealtimeEvent['response']): Promise<void> {
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
    if (!entry) {
      this.#unlockPtt();
      return;
    }

    if (!entry.text) entry.text = extractTranscript(response) ?? '';
    this.on.messageUpdate(entry.seq, entry.text, { pending: false });

    // `response.done` chi bao model sinh xong CHU. Tieng noi thi con dang phat
    // — nut micro mo lai o #onSpeechDone, va moi mode chot moc do mot kieu:
    //
    //   TTS client — hang doi doc canh (SpeechQueue.onDrain).
    //   'openai' — event `output_audio_buffer.stopped`.
    //
    // Ca hai deu la su kien CHAC CHAN, khong phai suy doan.
    if (!aiSpeaksItself(this.#voiceMode)) {
      this.#speech.end();
    } else if (!this.#outputAudioActive) {
      // Luot khong sinh ra audio nao (chi goi tool, hoac response rong): se
      // khong co `output_audio_buffer.stopped` de doi. Mo nut ngay, neu khong
      // la khoa vinh vien.
      this.#onSpeechDone();
    }

    await api
      .saveMessage(this.sessionId, { seq: entry.seq, role: 'assistant', text: entry.text })
      .catch((e) => console.warn('[save] message ai:', e.message));

    this.#requestHints();
  }

  /** Hang doi doc da canh: AI that su noi xong. */
  #onSpeechDone(): void {
    this.on.speaking(null);
    this.#unlockPtt();
    this.#flushTurnAudio();
  }

  #onToolCall(event: RealtimeEvent): void {
    let args: { objective_id?: string; status?: ProgressStatus; evidence?: string; reason?: string; closing_note?: string } = {};
    try {
      args = JSON.parse(event.arguments || '{}');
    } catch {
      console.warn('[tool]', event.name, 'arguments khong phai JSON:', event.arguments);
      return;
    }

    // `end_lesson` khong cham server va khong ghi DB, nen day la dau vet duy
    // nhat cho thay model da goi tool nao voi tham so gi.
    console.info('[tool]', event.name, args);

    if (event.name === 'mark_objective' && args.objective_id && args.status) {
      const record: ProgressRecord = {
        objectiveId: args.objective_id,
        status: args.status,
        evidence: args.evidence ?? null,
        messageSeq: this.#seq,
      };
      // Model chi de xuat; client moi la noi chot trang thai va hien thi.
      this.#progress.set(record.objectiveId, record);
      this.on.progress(this.progressList());
      api.saveProgress(this.sessionId, record).catch((e) => console.warn('[save] progress:', e.message));
      this.#maybeOfferFinish();
    }

    if (event.name === 'end_lesson') {
      // Ba ly do, chi mot dang chuc mung: chuc mung nguoi dang duoi
      // (learner_struggling) la phan tac dung.
      //
      // Va van phai doi chieu voi checklist cua client — model *de xuat*, client
      // moi chot. Model quen goi mark_objective mot muc tieu la se ra the ghi
      // "hoan thanh bai hoc" ngay tren dong "Du 2/3 muc tieu".
      this.#offerFinish({
        reason: args.reason,
        note: args.closing_note,
        completed: args.reason === 'objectives_complete' && this.#finishConditionsMet(),
      });
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
  #finishConditionsMet(): boolean {
    const { done, total } = this.#requiredCount();
    return done === total && this.#seq >= this.lesson.minTurns;
  }

  #maybeOfferFinish() {
    if (!this.#finishConditionsMet()) return;
    this.#offerFinish({
      reason: 'objectives_complete',
      note: 'Bạn đã hoàn thành tất cả mục tiêu của bài. Có thể kết thúc bất cứ lúc nào.',
      completed: true,
    });
  }

  #requiredCount(): { done: number; total: number } {
    const required = this.lesson.objectives.filter((o) => o.required);
    return {
      done: required.filter((o) => this.#progress.get(o.id)?.status === 'done').length,
      total: required.length,
    };
  }

  /**
   * Cua duy nhat bao "co the ket thuc" ra ngoai.
   *
   * `#maybeOfferFinish()` chay sau MOI lan `mark_objective`, nen mot khi da du
   * dieu kien thi no bao lai o moi luot tiep theo. Khong chot lai thi the chuc
   * mung se dung lai lien tuc — truoc day khong ai thay vi no chi doi mot dong
   * banner.
   */
  #offerFinish(info: { reason?: string; note?: string; completed: boolean }): void {
    const completed = info.completed && !this.#congratulated;
    if (completed) this.#congratulated = true;

    const { done, total } = this.#requiredCount();
    this.on.canFinish({ ...info, completed, doneCount: done, totalCount: total });
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

  #applyHints(response: RealtimeEvent['response']): void {
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
   * Gom mp3 cua tung khuc lai. Chi chay khi nguoi hoc bat luu audio cua AI.
   *
   * `durationMs` la uoc luong tu do dai chu — xem `estimateDuration` trong
   * `speech-queue.ts`. No chi dung de hien do dai o man tong ket.
   */
  #collectTurnAudio(blob: Blob, durationMs: number): void {
    if (!this.#turnAudio) return;
    this.#turnAudio.blobs.push(blob);
    this.#turnAudio.durationMs += durationMs;
  }

  /**
   * Noi cac khuc thanh mot file roi day len, ung voi dung mot message.
   *
   * MP3 la dong frame lien tiep nen noi thang byte la phat duoc — khong phai
   * giai ma roi ma hoa lai chi de dan hai doan vao nhau.
   */
  #flushTurnAudio(): void {
    const turn = this.#turnAudio;
    const seq = this.#speakingSeq;
    this.#turnAudio = null;
    this.#speakingSeq = null;

    if (!turn?.blobs.length || seq === null) return;
    const blob = new Blob(turn.blobs, { type: 'audio/mpeg' });
    void this.#queueUpload(seq, 'assistant', turn.durationMs, blob);
  }

  /** Cat doan audio cua mot message va day len ngay, khong doi cuoi buoi. */
  async #cutAndUpload(entry: PendingTurn, role: Role): Promise<void> {
    // Khong co endMs thi chua chot duoc doan — bo qua con hon cat bua.
    if (entry.endMs == null) return;
    const blob = entry.rec.sliceToWav(entry.startMs, entry.endMs);
    if (!blob) return;
    await this.#queueUpload(entry.seq, role, entry.endMs - entry.startMs, blob);
  }

  /**
   * Dua mot doan vao hang doi day len.
   *
   * Ghi vao `#pendingUploads` TRUOC khi await: `stop()` phai doi duoc ca nhung
   * doan vua moi bat dau day, khong thi dong tab la mat.
   */
  async #queueUpload(seq: number, role: Role, durationMs: number, blob: Blob): Promise<void> {
    const task = this.#upload(seq, role, durationMs, blob).catch((err) => {
      console.warn(`[audio] khong luu duoc doan seq=${seq}:`, errorMessage(err));
    });
    this.#pendingUploads.add(task);
    await task.finally(() => this.#pendingUploads.delete(task));
  }

  /**
   * Hai chang khi co S3: POST thang len bucket, roi bao server gan vao message.
   * Khong co grant thi lui ve duong cu — WAV di xuyen qua backend.
   */
  async #upload(seq: number, role: Role, durationMs: number, blob: Blob): Promise<void> {
    const grant = this.#uploadGrant;

    if (!grant || grant.expiresAt <= Date.now()) {
      const { audioUrl } = await retry(() =>
        api.uploadAudio(this.sessionId, seq, role, durationMs, blob)
      );
      this.on.messageAudio(seq, audioUrl, durationMs);
      return;
    }

    // Duoi file phai khop het voi `audioKey` ben server, khong thi `verifyKey`
    // tu choi: WAV cho doan ghi cua nguoi hoc, MP3 cho cau nha TTS doc.
    const ext = role === 'assistant' ? 'mp3' : 'wav';
    const key = `${grant.keyPrefix}${String(seq).padStart(3, '0')}-${role}.${ext}`;
    await retry(() => putAudioToS3(grant, key, blob));

    // Chi bao len UI sau khi server da gan xong: bao som thi nut nghe lai tro
    // vao mot object server chua biet, bam vao la hong.
    const { audioUrl } = await retry(() =>
      api.confirmAudio(this.sessionId, seq, {
        key,
        role,
        bytes: blob.size,
        durationMs: Math.round(durationMs),
      })
    );
    this.on.messageAudio(seq, audioUrl, durationMs);
  }
}

// -------------------------------------------------------------------- utils

function extractTranscript(response: RealtimeEvent['response']): string | null {
  for (const item of response?.output ?? []) {
    for (const c of item.content ?? []) {
      if (c.transcript) return c.transcript;
    }
  }
  return null;
}

function extractText(response: RealtimeEvent['response']): string | null {
  for (const item of response?.output ?? []) {
    for (const c of item.content ?? []) {
      if (c.type === 'output_text' || c.type === 'text') return c.text ?? null;
    }
  }
  return null;
}
