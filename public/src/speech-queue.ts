/**
 * Bien dong text cua AI thanh tieng noi: cat khuc -> nha TTS -> phat theo dung
 * thu tu.
 *
 * Hang doi nay KHONG BIET dang noi chuyen voi nha nao. Moi khac biet giua Google
 * va Polly — cach ky, hinh dang than response, status bao het han — nam sau
 * `tts-client.ts`. Do la co y: file nay da du kho voi bo dem `#generation`, tran
 * `MAX_IN_FLIGHT` va lich su `emptied`, khong nen them mot chieu bien thien nua.
 *
 * Hang doi nay khong con biet gi ve khau hinh. Avatar tu doc bien do cua chinh
 * the <audio> duoi day (`fake-mouth.ts`), nen khong ai phai chuyen timeline qua
 * day nua.
 *
 * Diem quan trong nhat: khuc N+1 duoc tong hop TRONG LUC khuc N dang phat. Nho
 * vay chi khuc dau tien la nguoi dung that su phai doi; tu khuc thu hai tro di
 * do tre bi che hoan toan sau tieng noi.
 *
 * VI SAO MOT `<audio>` CHU KHONG PHAI HAI:
 * Ban dau thiet ke la cap `<audio>` luan phien de preload khuc ke. Nhung ca hai
 * nha deu tra ve ca file mp3 mot luc va ta giu no lam Blob trong RAM — khong con
 * gi de "tai truoc" ca. Cai duy nhat con lai la ham nong bo giai ma, vai chuc ms,
 * khong dang de doi lay viec avatar phai bam theo hai element.
 *
 * Rang buoc do gio CUNG hon nhieu: `createMediaElementSource` chi goi duoc MOT
 * lan cho moi the <audio>, vinh vien. Quay lai thiet ke hai the la duong nhep
 * mom chet han — xem `FakeMouthPlayer`.
 */

import { SentenceChunker } from '../../shared/chunk.ts';
import { waitForPlayback, type PlaybackWait } from '../../shared/playback.ts';
import { grantUsable, isAuthError, synthesize } from './tts-client.ts';
import type { SynthesisResult } from './tts-client.ts';
import type { TtsGrant } from '../../shared/types.ts';

/** Toi da bao nhieu khuc duoc tong hop cung luc. */
const MAX_IN_FLIGHT = 3;

/**
 * Tran cung cho ca mot luot noi.
 *
 * Hang doi canh la tin hieu duy nhat mo lai nut micro. Neu co mot nhanh nao do
 * khong dong — fetch treo kieu la, `ended` khong bao giu — thi khong co cai nay
 * nguoi hoc se ngoi nhin nut khoa vinh vien.
 */
const TURN_FAILSAFE_MS = 30_000;

export interface SpeechQueueHandlers {
  /** Het sach hang doi va dong text da dong — luot cua AI ket thuc. */
  onDrain: () => void;
  /** Mot khuc hong. Text da hien roi nen day chi de ghi log. */
  onError: (message: string) => void;
  /**
   * Xin grant moi khi nha TTS bao het han. Tra null nghia la khong xin duoc —
   * thoi khong co tieng.
   */
  refreshGrant: () => Promise<TtsGrant | null>;
  /**
   * Mot khuc mp3 da doc xong. Dung khi nguoi hoc bat luu audio cua AI.
   *
   * `durationMs` la UOC LUONG — xem `estimateDuration`.
   */
  onAudio?: (blob: Blob, text: string, durationMs: number) => void;
}

/**
 * Toc do doc, ky tu/giay. Cung con so ma `docs/cost.md` muc 4 dung de quy doi
 * tien (~165 wpm). Do tu Polly neural; giong Chirp3-HD cua Google doc xap xi
 * cung nhip, va sai vai tram ms thi khong ai thay — xem `estimateDuration`.
 */
const CHARS_PER_SEC = 14;

/**
 * Uoc do dai mot khuc tu DO DAI CHU.
 *
 * Truoc day con so nay doc tu moc viseme cuoi cung cua speech marks, tuc la gan
 * dung. Bo speech marks thi mat luon cai moc do, va khong con nguon nao re: giai
 * ma mp3 chi de biet do dai la qua dat, con `audio.duration` thi chi co sau khi
 * gan `src` — muon dung no phai doi `onAudio` xuong sau luc phat, ma nhu vay
 * khuc bi huy giua chung se khong duoc luu lai nua.
 *
 * Nen day la uoc luong thuan, va no chi chay vao MOT cho: dong thoi luong hien
 * canh cau AI o man tong ket. Uoc sai vai tram ms khong ai thay.
 */
const estimateDuration = (text: string): number =>
  Math.round((text.length / CHARS_PER_SEC) * 1000);

interface Job {
  text: string;
  result: Promise<SynthesisResult | null>;
}

export class SpeechQueue {
  readonly #audio: HTMLAudioElement;
  readonly #on: SpeechQueueHandlers;
  readonly #chunker = new SentenceChunker();

  #grant: TtsGrant | null = null;
  #rate = 1;

  #jobs: Job[] = [];
  #streamEnded = false;
  #pumping = false;
  #abort = new AbortController();

  /**
   * Tang len moi lan `cancel()`.
   *
   * Vong phat co the dang `await` mot khuc luc bi huy. Khong co moc nay thi khi
   * lan await do tra ve, no chay tiep vong lap va phat khuc cua LUOT SAU — hai
   * vong phat chong len nhau tren cung mot the <audio>.
   */
  #generation = 0;

  #inFlight = 0;
  #waiters: (() => void)[] = [];

  #failsafe: ReturnType<typeof setTimeout> | null = null;

  /** Lan cho cua khuc dang phat. `cancel()` dung no de go treo. */
  #playback: PlaybackWait | null = null;

  constructor(audio: HTMLAudioElement, handlers: SpeechQueueHandlers) {
    this.#audio = audio;
    this.#on = handlers;
  }

  // ------------------------------------------------------------- cau hinh

  /**
   * Grant mang theo ca giong cua nhan vat.
   *
   * Truoc day hang doi giu `voiceId`/`engine` rieng, khoi tao tu grant roi cho
   * `setVoice()` de len. Nhung khong co cho nao goi `setVoice` — khong he co bo
   * chon giong tren man hoc — nen hai nguon su that do chi de lai mot duong lech:
   * moi lan cap lai grant am tham keo giong ve mac dinh cua server. Gio giong di
   * theo grant, mot nguon duy nhat.
   */
  setGrant(grant: TtsGrant | null): void {
    this.#grant = grant;
  }

  /**
   * Toc do doc. Doi duoc GIUA CHUNG mot cau — khac han duong cu qua
   * `session.update` cua Realtime API, von chi doi duoc giua cac luot.
   *
   * `preservesPitch` giu nguyen cao do khi cham lai. Do la ly do ca duong nay
   * dung `<audio>` chu khong phai Web Audio.
   */
  setRate(rate: number): void {
    this.#rate = rate;
    this.#audio.preservesPitch = true;
    this.#audio.playbackRate = rate;
  }

  get speaking(): boolean {
    return this.#pumping || this.#jobs.length > 0;
  }

  // --------------------------------------------------------------- nap text

  /** Nap mot delta tu Realtime API. */
  push(delta: string): void {
    for (const text of this.#chunker.push(delta)) this.#enqueue(text);
  }

  /** Dong text da het: tra not phan con lai roi cho hang doi canh. */
  end(): void {
    for (const text of this.#chunker.flush()) this.#enqueue(text);
    this.#streamEnded = true;
    this.#armFailsafe();
    // Khong con khuc nao va cung chua tung co khuc nao — vd model tra ve rong.
    if (!this.#jobs.length && !this.#pumping) this.#finish();
  }

  /**
   * Huy tat ca: nguoi hoc bam micro giua luc AI dang noi.
   *
   * Phai `revokeObjectURL` cho ca cac khuc chua kip phat, neu khong moi luot bi
   * ngat lai bo lai vai MB mp3 trong bo nho cho toi khi dong tab.
   */
  cancel(): void {
    this.#generation++;
    this.#abort.abort();
    this.#abort = new AbortController();

    this.#audio.pause();
    this.#audio.removeAttribute('src');
    this.#audio.load();

    // Go src ra khong ban `ended`, nen vong phat dang `await` phai duoc danh
    // thuc tu day. Truoc kia viec nay nho vao `emptied`, va chinh cho do lam
    // moi lan gan src bi hieu nham la "phat xong".
    this.#playback?.finish();
    this.#playback = null;

    const jobs = this.#jobs;
    this.#jobs = [];
    for (const job of jobs) {
      job.result.then((r) => r && URL.revokeObjectURL(r.url)).catch(() => {});
    }

    this.#chunker.reset();
    this.#streamEnded = false;
    this.#pumping = false;
    this.#clearFailsafe();
  }

  // ------------------------------------------------------------- tong hop

  #enqueue(text: string): void {
    const job: Job = { text, result: this.#synthesize(text) };
    this.#jobs.push(job);
    this.#armFailsafe();
    void this.#pump();
  }

  async #synthesize(text: string): Promise<SynthesisResult | null> {
    await this.#acquire();
    const signal = this.#abort.signal;
    try {
      return await this.#trySynthesize(text, signal);
    } catch (err) {
      if (signal.aborted) return null;
      this.#on.onError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      this.#release();
    }
  }

  async #trySynthesize(text: string, signal: AbortSignal): Promise<SynthesisResult | null> {
    if (!grantUsable(this.#grant)) {
      const fresh = await this.#on.refreshGrant();
      if (!fresh) return null;
      this.setGrant(fresh);
    }
    const grant = this.#grant;
    if (!grant) return null;

    try {
      return await synthesize(grant, text, { signal });
    } catch (err) {
      // Credential het han — hoac, o duong Polly, nguoi hoc doi Wi-Fi <-> 4G nen
      // lech IP so voi luc ky. Hai nha bao chuyen nay bang hai status khac nhau,
      // va `isAuthError` la cho biet dieu do. Xin lai mot lan roi thoi.
      if (isAuthError(err) && !signal.aborted) {
        const fresh = await this.#on.refreshGrant();
        if (!fresh) return null;
        this.setGrant(fresh);
        return await synthesize(fresh, text, { signal });
      }
      throw err;
    }
  }

  async #acquire(): Promise<void> {
    if (this.#inFlight < MAX_IN_FLIGHT) {
      this.#inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#inFlight++;
  }

  #release(): void {
    this.#inFlight--;
    this.#waiters.shift()?.();
  }

  // ----------------------------------------------------------------- phat

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    const gen = this.#generation;

    try {
      for (;;) {
        const job = this.#jobs[0];
        if (!job) break;

        const result = await job.result;
        if (gen !== this.#generation) {
          if (result) URL.revokeObjectURL(result.url);
          return;
        }
        // `cancel()` da don sach trong luc dang cho tong hop.
        if (this.#jobs[0] !== job) {
          if (result) URL.revokeObjectURL(result.url);
          continue;
        }
        this.#jobs.shift();

        if (!result) continue;
        this.#on.onAudio?.(result.blob, job.text, estimateDuration(job.text));

        try {
          await this.#playOne(result);
        } finally {
          URL.revokeObjectURL(result.url);
        }
        if (gen !== this.#generation) return;
      }
    } finally {
      // Chi nha cho khi van con la vong phat hop le. Bi huy roi thi `cancel()`
      // da dat lai co nay, ghi de len se mo duong cho mot vong phat thu hai.
      if (gen === this.#generation) this.#pumping = false;
    }

    if (this.#streamEnded && !this.#jobs.length) this.#finish();
  }

  async #playOne(result: SynthesisResult): Promise<void> {
    // Nan lai dong ho an toan moi khi co tien trien. Neu chi len giay mot lan
    // luc het chu thi mot luot dai — hoac nghe o 0.25x — se bi cat giua chung
    // dung luc AI dang noi.
    this.#armFailsafe();

    const audio = this.#audio;
    audio.src = result.url;
    audio.preservesPitch = true;
    audio.playbackRate = this.#rate;

    // Chi nghe `ended`/`error`. Duong huy khong muon su kien nao lam tin ma
    // duoc `cancel()` goi thang — xem `shared/playback.ts` de biet vi sao
    // nghe `emptied` o day tung lam mat tieng.
    const wait = waitForPlayback(audio);
    this.#playback = wait;

    try {
      try {
        await audio.play();
      } catch (err) {
        // Trinh duyet chan tu dong phat. Khong nen xay ra vi nguoi hoc vua bam
        // nut micro, nhung neu co thi bo qua khuc nay con hon treo hang doi.
        this.#on.onError(err instanceof Error ? err.message : String(err));
        return;
      }
      await wait.done;
    } finally {
      wait.finish();
      if (this.#playback === wait) this.#playback = null;
    }
  }

  #finish(): void {
    this.#clearFailsafe();
    this.#streamEnded = false;
    this.#chunker.reset();
    this.#on.onDrain();
  }

  #armFailsafe(): void {
    this.#clearFailsafe();
    this.#failsafe = setTimeout(() => {
      this.#on.onError('Qua lau khong doc xong — mo lai nut micro.');
      this.cancel();
      this.#on.onDrain();
    }, TURN_FAILSAFE_MS);
  }

  #clearFailsafe(): void {
    if (this.#failsafe) clearTimeout(this.#failsafe);
    this.#failsafe = null;
  }
}
