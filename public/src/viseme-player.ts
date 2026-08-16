/**
 * Bien timeline viseme thanh hai thu, moi thu cho mot ben tieu thu:
 *
 *   onViseme  — khau hinh dang mo (roi rac). Avatar Spine dung cai nay: no tu
 *               noi suy giua hai animation, khong can ta dua trong so.
 *   onWeights — bang trong so da lam muot (lien tuc). Thanh do debug dung cai
 *               nay, va no la cach duy nhat nhin thay du lieu co chay hay khong
 *               khi mom avatar dung im.
 *
 * Dong ho lay tu `audio.currentTime` chu khong phai wall clock: nguoi hoc keo
 * playbackRate xuong 0.5x, hoac trinh duyet nghen mot nhip, thi mieng van phai
 * bam theo tieng.
 *
 * Khong biet gi ve Spine hay DOM.
 */

import { VISEME_IDS, frameAt, type VisemeFrame, type VisemeId } from '../../shared/viseme.ts';

/** Trong so cua tung khau hinh, danh chi so theo viseme ID. */
export type VisemeWeights = number[];

/**
 * Thoi gian giao thoa giua hai khau hinh khi tinh TRONG SO.
 *
 * Avatar khong dung con so nay — Spine tu mix bang `MOUTH_MIX_SEC` cua rieng
 * no. Day chi de thanh do trong muot, va de hai ben nhin ra gan giong nhau.
 */
const BLEND_MS = 70;

/** Hang so thoi gian lam muot cho thanh do. */
const SMOOTH_TAU_MS = 45;

const zeroWeights = (): VisemeWeights => new Array<number>(VISEME_IDS.length).fill(0);

/**
 * Trong so MUC TIEU tai moc `tMs` — chua lam muot.
 *
 * Tach ra thanh ham thuan de test duoc ma khong can audio element hay rAF.
 * Timeline cua Polly la cac moc roi rac, moi viseme giu cho toi moc ke tiep;
 * doan cuoi truoc khi het thi cheo dan sang viseme sau.
 */
export function weightsAt(frames: readonly VisemeFrame[], tMs: number): VisemeWeights {
  const weights = zeroWeights();
  const active = frameAt(frames, tMs);
  if (!active) {
    weights[0] = 1; // 0 = im lang
    return weights;
  }

  const { index, frame, endMs } = active;
  const next = frames[index + 1];

  if (endMs === null || !next) {
    weights[frame.viseme] = frame.weight;
    return weights;
  }

  const remain = endMs - tMs;
  if (remain >= BLEND_MS) {
    weights[frame.viseme] = frame.weight;
    return weights;
  }

  // k: 1 o dau vung giao thoa, 0 dung luc doi sang frame sau.
  const k = Math.max(0, remain / BLEND_MS);
  weights[frame.viseme] = (weights[frame.viseme] ?? 0) + frame.weight * k;
  weights[next.viseme] = (weights[next.viseme] ?? 0) + next.weight * (1 - k);
  return weights;
}

export interface VisemePlayerHandlers {
  /** Goi khi khau hinh dang mo DOI. Khong goi lai moi frame. */
  onViseme?: (id: VisemeId, weight: number) => void;
  /** Goi moi frame render voi bang trong so da lam muot. */
  onWeights?: (weights: VisemeWeights) => void;
}

export class VisemePlayer {
  readonly #audio: HTMLAudioElement;
  readonly #on: VisemePlayerHandlers;

  #frames: readonly VisemeFrame[] = [];
  #weights = zeroWeights();
  #raf: number | null = null;
  #lastMs: number | null = null;
  #currentId: VisemeId | null = null;

  constructor(audio: HTMLAudioElement, handlers: VisemePlayerHandlers) {
    this.#audio = audio;
    this.#on = handlers;
  }

  /** Doi khuc dang doc. Khong tu phat — SpeechQueue lo phan phat. */
  load(frames: readonly VisemeFrame[]): void {
    this.#frames = frames;
    this.#weights = zeroWeights();
    this.#weights[0] = 1;
    this.#currentId = null;
    this.#on.onWeights?.(this.#weights);
  }

  /**
   * Bat vong render. Chay ca khi audio dang tam dung — nho vay khoang nghi
   * giua hai khuc, mom van giu dung khau hinh cua moc do.
   */
  start(): void {
    if (this.#raf !== null) return;
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
  }

  #step(): void {
    const now = performance.now();
    // Frame dau tien chua co moc truoc de tinh dt; coi nhu mot nhip 60fps.
    const dt = this.#lastMs === null ? 16 : Math.min(100, now - this.#lastMs);
    this.#lastMs = now;

    const tMs = this.#audio.currentTime * 1000;

    // Nhanh roi rac: doc thang tu TIMELINE, khong doc tu bang trong so da lam
    // muot. Giua hai khau hinh trong so bi chia doi nen khong cai nao vuot
    // nguong, va avatar se nhay ve "mieng nghi" mot cai giua cau.
    const active = frameAt(this.#frames, tMs);
    const id = active ? active.frame.viseme : 0;
    const weight = active ? active.frame.weight : 1;
    if (id !== this.#currentId) {
      this.#currentId = id;
      this.#on.onViseme?.(id, weight);
    }

    // Nhanh lien tuc: chi cho thanh do.
    if (this.#on.onWeights) {
      const target = weightsAt(this.#frames, tMs);
      // Loc bac mot theo dt THAT, khong theo so frame: tab chay nen hay may
      // yeu lam tut fps thi toc do lam muot van y nguyen.
      const alpha = 1 - Math.exp(-dt / SMOOTH_TAU_MS);
      for (const v of VISEME_IDS) {
        this.#weights[v] += ((target[v] ?? 0) - (this.#weights[v] ?? 0)) * alpha;
      }
      this.#on.onWeights(this.#weights);
    }
  }
}
