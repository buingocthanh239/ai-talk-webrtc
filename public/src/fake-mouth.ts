/**
 * Nhep mom FAKE: suy khau hinh tu bien do audio, khong hoi ai ca.
 *
 * TRUNG THUC VE THU NAY LA GI. Truoc day khau hinh den tu speech marks cua
 * Polly, tuc la dung AM VI: chu `p` ra hinh mim moi, chu `s` ra hinh rang khep.
 * Duong do da bo. Cai o day chi doc DO TO cua tieng roi mo mom theo — dung
 * NHIP, sai AM VI, va khong co cach nao lam no dung am vi ca.
 *
 * `docs/lip-sync.md` muc 6 tung xep dung phuong an nay vao bang "da loai", ly do
 * "day phat am bang no la day sai". Ly do do con nguyen gia tri — no chi khong
 * con AP DUNG, vi man luyen khau hinh (noi nguoi hoc that su nhin vao hinh
 * mieng de bat chuoc) da bo o commit 89979c8. Trong hoi thoai AI noi ~150
 * tu/phut, khong ai nhin kip tung khau hinh, va viec duy nhat avatar dang lam
 * la "co mat cho sinh dong". Fake lam duoc dung viec do.
 *
 * **Neu sau nay quay lai day phat am bang hinh mieng thi phai bat lai speech
 * marks** — dung sua file nay cho chinh xac hon, no khong the chinh xac hon.
 *
 * Vi the o day KHONG co dong goi y tieng Viet nao. Dan mot cai nhan "dau luoi
 * cham loi sau rang tren" len mot khau hinh doan tu do to la day sai that, chu
 * khong con la "nhin cho vui".
 *
 * Chia lam hai tang, tang duoi thuan de test duoc:
 *   FakeMouth        — bien do -> khau hinh. Khong biet gi ve DOM hay WebAudio.
 *   FakeMouthPlayer  — cai voi cam vao the <audio>, cong vong rAF.
 */

import type { VisemeId } from '../../shared/viseme.ts';

// ------------------------------------------------------- bo khau hinh dung toi

/** Mieng nghi. */
export const MOUTH_CLOSED: VisemeId = 0;

/**
 * Hai moi mim chat.
 *
 * Dung cho khoang lang NGAN giua luc dang noi. `lip-sync.md` muc 1 noi dung
 * rang phu am bat (p, b, m, d, k) "gan nhu khong tach duoc khoi im lang bang
 * phan tich pho" — nhung fake thi khong can tach: mot khoang lang 50-200ms
 * giua mot cau dang noi gan nhu luon la phu am bat, va mim moi la thu dung
 * nhat co the doan ma khong biet gi them.
 */
export const MOUTH_PRESSED: VisemeId = 21;

/**
 * Thang do mo, tu dong toi ha ham.
 *
 * Bon bac chu khong phai hai: hai bac nhin nhu ban le cua. Va khong nhieu hon
 * bon: moi bac them la mot lan doi animation nua tren track 1, ma khong co
 * thong tin nao bien minh cho no — bia them hinh chi lam nhep nhin loan hon.
 */
const LADDER: readonly VisemeId[] = [
  MOUTH_CLOSED,
  19, // dau luoi cham loi — mom he
  4, //  mom he vua
  2, //  ha ham rong
];

/** Nhung ID ma `step()` co the tra ve. `talk-avatar.ts` ve thanh do theo bo nay. */
export const FAKE_VISEME_IDS: readonly VisemeId[] = [...LADDER, MOUTH_PRESSED];

// ------------------------------------------------------------------ nguong

/**
 * Nguong len giua cac bac, tinh tren MUC da chuan hoa (0..1).
 *
 * `UP[i]` la ranh giua bac i va bac i+1.
 */
const UP: readonly number[] = [0.14, 0.35, 0.62];

/** Do tre nguong. Xem test "muc dao dong quanh nguong khong lam mom rung". */
const HYST = 0.05;

/**
 * Bac do mo tai `level`, biet bac dang giu la `current`.
 *
 * Ham thuan, tach rieng vi day la cho duy nhat co tre nguong — va tre nguong
 * sai thi hong theo hai huong doi nhau (mom rung, hoac mom liet), nen no dang
 * duoc hoi bang mot cau hoi rieng.
 */
export function shapeStep(level: number, current: number): number {
  let step = Math.min(Math.max(current, 0), LADDER.length - 1);
  while (step < LADDER.length - 1 && level >= (UP[step] ?? 1) + HYST) step++;
  while (step > 0 && level < (UP[step - 1] ?? 0) - HYST) step--;
  return step;
}

// -------------------------------------------------------------- chuan hoa

/**
 * Dinh truot tut cham the nay. Ngan hon thi giua cau dinh tut theo tung am
 * tiet va MOI am tiet deu thanh "to het co" — mom ha ham lien tuc.
 */
const PEAK_TAU_MS = 900;

/**
 * Duoi san nay thi coi nhu im, khong chuan hoa nua.
 *
 * Mat trai cua chuan hoa: chia cho mot dinh be ti thi tieng u u con lai trong
 * mp3 cung thanh "dang noi", va mom se may may suot ca khoang nghi.
 */
const PEAK_FLOOR = 0.005;

/** Lam muot muc. Ngan hon thi mom giat theo tung chu ky song. */
const LEVEL_TAU_MS = 30;

/** dt lon hon nay thi kep lai — tab chay nen co the nhay vai giay mot buoc. */
const MAX_DT_MS = 250;

/** Im ngan hon nay giua luc dang noi thi mim moi, dai hon thi ve mieng nghi. */
const DIP_WINDOW_MS = 220;

/** Alpha cua track 1 khi mom dang mo. Xem `weight` duoi day. */
const MIN_OPEN_ALPHA = 0.45;

export interface MouthFrame {
  id: VisemeId;
  /**
   * Alpha cua track viseme tren Spine, 0..1.
   *
   * Day la cho fake duoc nhieu nhat so voi bon bac roi rac: `playViseme` ap
   * alpha MOI frame chu chi doi animation khi ID doi, nen do mo chay lien tuc
   * theo do to thay vi nhay theo bac.
   */
  weight: number;
  /** Do to da chuan hoa, 0..1. Thanh do debug dung cai nay. */
  level: number;
}

/**
 * Bien do -> khau hinh, co nho trang thai giua cac frame.
 *
 * Co trang thai nhung khong cham DOM: bom mot mang so vao la test duoc.
 */
export class FakeMouth {
  #peak = 0;
  #level = 0;
  #step = 0;
  #quietMs = 0;
  #spoke = false;

  /**
   * Mot nhip render.
   *
   * @param rms  Bien do RMS cua khung audio vua roi, 0..1.
   * @param dtMs Thoi gian THAT tu nhip truoc — khong phai so frame. May yeu tut
   *             fps thi toc do lam muot van y nguyen.
   */
  step(rms: number, dtMs: number): MouthFrame {
    const dt = Number.isFinite(dtMs) ? Math.min(Math.max(dtMs, 0), MAX_DT_MS) : MAX_DT_MS;
    // `getByteTimeDomainData` tren mot context vua bi suspend tra ve toan 0, va
    // mot phep chia khong canh se nem NaN thang vao alpha cua Spine — mom se
    // bien mat chu khong phai dung im, ma dau vet thi khong o day.
    const x = Number.isFinite(rms) ? Math.min(Math.max(rms, 0), 1) : 0;

    this.#peak = Math.max(x, this.#peak * Math.exp(-dt / PEAK_TAU_MS));

    // CHUAN HOA THEO DINH TRUOT, khong doc bien do tuyet doi. Polly khong chuan
    // hoa loudness giua cac giong va nguoi hoc con keo duoc volume; doc thang
    // thi giong nho tieng nhep hoi hot ca buoi con giong to tieng ha ham moi
    // am tiet.
    const target = this.#peak > PEAK_FLOOR ? Math.min(1, x / this.#peak) : 0;
    this.#level += (target - this.#level) * (1 - Math.exp(-dt / LEVEL_TAU_MS));

    this.#step = shapeStep(this.#level, this.#step);

    if (this.#step === 0) {
      this.#quietMs += dt;
    } else {
      this.#quietMs = 0;
      this.#spoke = true;
    }

    if (this.#step === 0) {
      const dip = this.#spoke && this.#quietMs < DIP_WINDOW_MS;
      // Mieng nghi va moi mim deu la mom dong, nen alpha day du — de Idle o
      // track 0 khong keo mom he ra.
      return { id: dip ? MOUTH_PRESSED : MOUTH_CLOSED, weight: 1, level: this.#level };
    }

    return {
      id: LADDER[this.#step] ?? MOUTH_CLOSED,
      weight: MIN_OPEN_ALPHA + (1 - MIN_OPEN_ALPHA) * this.#level,
      level: this.#level,
    };
  }
}

// ------------------------------------------------------- voi cam vao <audio>

export interface FakeMouthHandlers {
  /**
   * Goi MOI frame, khong phai chi khi ID doi — `weight` chay lien tuc.
   * `Avatar.playViseme` tu biet chi goi `setAnimation` khi ID that su doi.
   */
  onMouth: (frame: MouthFrame) => void;
}

/** Cua so FFT. 1024 mau ~ 23ms o 44.1kHz — du ngan de bat duoc tung am tiet. */
const FFT_SIZE = 1024;

/**
 * Doc bien do cua the <audio> dang phat va day ra khau hinh moi frame.
 *
 * BA CAI BAY, ca ba deu bieu hien giong het "Polly hong":
 *
 * 1. `createMediaElementSource` CAT tieng ra khoi loa. Tu luc goi no, am thanh
 *    chi con di theo do thi WebAudio — quen `connect` toi `destination` la cam
 *    hoan toan, ma trong console khong co loi nao.
 *
 * 2. Moi the <audio> chi tao duoc MOT source node, VINH VIEN. Goi lan hai nem
 *    `InvalidStateError`. Chay duoc la nho `SpeechQueue` da chon dung MOT the
 *    <audio> cho ca buoi (xem comment dau `speech-queue.ts`) — thiet ke hai the
 *    luan phien ban dau thi duong nay da chet tu dau.
 *
 * 3. `AudioContext` sinh ra o trang thai `suspended` cho toi khi co cu chi
 *    nguoi dung. Khong `resume()` thi bien do doc ve toan 0 va mom dung im
 *    trong khi tai van nghe thay tieng.
 *
 * Con `playbackRate` 0.5x thi khong phai lo: chinh the <audio> gian thoi gian
 * (va `preservesPitch` giu cao do), WebAudio chi cam vao SAU do — nen mom tu
 * cham theo, khong phai tinh lai gi.
 *
 * HAI KIEU VOI, tuy mode giong cua buoi hoc:
 *
 *   'polly'  — voi vao THE <audio>, va phai noi tiep toi `destination` (bay 1).
 *   'openai' — voi vao chinh MediaStream cua WebRTC, va TUYET DOI khong noi
 *              toi `destination`: the <audio> dang phat stream do roi, noi
 *              them la nghe dup.
 *
 * Kieu thu hai khong phai chuyen thich thi doi: `createMediaElementSource` tren
 * mot the dang chay `srcObject` doc ve toan 0 tren Chrome — mom se dung im ma
 * tai van nghe thay tieng, dung bieu hien cua bay 3 nen rat de chan doan nham.
 */
export class FakeMouthPlayer {
  readonly #audio: HTMLAudioElement;
  readonly #stream: MediaStream | null;
  readonly #on: FakeMouthHandlers;
  readonly #mouth = new FakeMouth();

  #ctx: AudioContext | null = null;
  #analyser: AnalyserNode | null = null;
  #buf: Uint8Array<ArrayBuffer> | null = null;
  #raf: number | null = null;
  #lastMs: number | null = null;

  readonly #resume = (): void => {
    void this.#ctx?.resume().catch(() => {});
  };

  constructor(
    audio: HTMLAudioElement,
    handlers: FakeMouthHandlers,
    { stream = null }: { stream?: MediaStream | null } = {}
  ) {
    this.#audio = audio;
    this.#stream = stream;
    this.#on = handlers;
  }

  /**
   * Dung voi va bat vong render.
   *
   * Khong tao voi trong constructor: dung day la mot tac dung phu len the
   * <audio> khong go lai duoc, nen no phai nam o mot lan goi co ten.
   */
  start(): void {
    if (this.#raf !== null) return;
    this.#tap();

    this.#lastMs = null;
    const tick = (): void => {
      this.#step();
      this.#raf = requestAnimationFrame(tick);
    };
    this.#raf = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.#raf !== null) cancelAnimationFrame(this.#raf);
    this.#raf = null;
    this.#audio.removeEventListener('play', this.#resume);
    // KHONG dong AudioContext: source node cua the <audio> khong go ra duoc, va
    // dong context la cat tieng vinh vien. Buoi hoc chi co mot the <audio> va
    // mot context, nen de no song toi khi dong tab.
    this.#analyser = null;
  }

  #tap(): void {
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;

      if (this.#stream) {
        // Mode 'openai'. Nhanh cut, khong noi toi destination — the <audio> lo
        // phan phat. Rieng voi MediaStream thi nhanh cut van duoc do thi keo,
        // vi nguon la mot track song chu khong phai mot node cho duoc keo.
        ctx.createMediaStreamSource(this.#stream).connect(analyser);
      } else {
        // Mode 'polly'. Chuoi source -> analyser -> destination. Cho analyser
        // NAM TRONG duong ra chu khong treo mot nhanh rieng: mot nhanh khong
        // noi toi destination co the khong duoc do thi keo qua, va luc do bien
        // do doc ve toan 0.
        const source = ctx.createMediaElementSource(this.#audio);
        source.connect(analyser);
        analyser.connect(ctx.destination);
      }

      this.#ctx = ctx;
      this.#analyser = analyser;
      this.#buf = new Uint8Array(analyser.fftSize);

      this.#audio.addEventListener('play', this.#resume);
      this.#resume();
    } catch (err) {
      // Avatar la trang tri, khong phai duong song. Hong thi mom dung im va
      // buoi hoc chay tiep bang chu va tieng.
      console.warn('[fake-mouth]', err);
      this.#analyser = null;
    }
  }

  #step(): void {
    const now = performance.now();
    const dt = this.#lastMs === null ? 16 : now - this.#lastMs;
    this.#lastMs = now;

    this.#on.onMouth(this.#mouth.step(this.#rms(), dt));
  }

  #rms(): number {
    const analyser = this.#analyser;
    const buf = this.#buf;
    if (!analyser || !buf) return 0;

    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const b of buf) {
      // Mien thoi gian tra ve byte khong dau, 128 la muc khong.
      const v = (b - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }
}
