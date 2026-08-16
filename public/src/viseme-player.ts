/**
 * Bien timeline viseme thanh trong so khau hinh theo tung frame render.
 *
 * Dong ho lay tu `audio.currentTime` chu khong phai wall clock: nguoi hoc keo
 * thanh tua, doi playbackRate xuong 0.5x, hoac trinh duyet nghen mot nhip thi
 * mieng van phai bam theo tieng. Do la ca diem cua man luyen khau hinh.
 *
 * Khong biet gi ve three.js hay DOM — chi tra ra mot bang trong so. Nho vay
 * cai thanh do debug va avatar 3D dung chung mot nguon, va khi mom avatar sai
 * thi biet ngay loi nam o tang nao.
 */

import { VISEMES, frameAt, type Viseme, type VisemeFrame } from '../../shared/viseme.ts';

export type VisemeWeights = Record<Viseme, number>;

/**
 * Thoi gian giao thoa giua hai khau hinh lien tiep.
 *
 * Mieng that khong nhay coc: khi phat /b/ trong "about", moi da chum lai tu
 * truoc do. Nhay tuc thoi giua cac viseme nhin ra ngay la may — va voi nguoi
 * dang tap bat chuoc thi con day sai ca cach chuyen am.
 */
const BLEND_MS = 70;

/**
 * Hang so thoi gian lam muot. Du de khu giat khi frame render thua ra, nhung
 * khong du de lam tre khau hinh mot cach nhin thay duoc.
 */
const SMOOTH_TAU_MS = 45;

const zeroWeights = (): VisemeWeights =>
  Object.fromEntries(VISEMES.map((v) => [v, 0])) as VisemeWeights;

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
    weights.sil = 1;
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
  weights[frame.viseme] += frame.weight * k;
  weights[next.viseme] += next.weight * (1 - k);
  return weights;
}

export interface VisemePlayerHandlers {
  /** Goi moi frame render voi bang trong so da lam muot. */
  onWeights: (weights: VisemeWeights) => void;
}

export class VisemePlayer {
  readonly #audio: HTMLAudioElement;
  readonly #onWeights: VisemePlayerHandlers['onWeights'];

  #frames: readonly VisemeFrame[] = [];
  #weights = zeroWeights();
  #raf: number | null = null;
  #lastMs: number | null = null;

  constructor(audio: HTMLAudioElement, { onWeights }: VisemePlayerHandlers) {
    this.#audio = audio;
    this.#onWeights = onWeights;
  }

  /** Doi cau dang luyen. Khong tu phat — nguoi hoc bam nut moi phat. */
  load(frames: readonly VisemeFrame[]): void {
    this.#frames = frames;
    this.#weights = zeroWeights();
    this.#weights.sil = 1;
    this.#onWeights(this.#weights);
  }

  /**
   * Bat vong render. Chay ca khi audio dang tam dung — nho vay keo thanh tua
   * hay dung hinh giua cau van thay dung khau hinh cua moc do.
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

    const target = weightsAt(this.#frames, this.#audio.currentTime * 1000);
    // Loc bac mot theo dt that, khong theo so frame: tab chay nen hay may yeu
    // lam tut fps thi toc do lam muot van y nguyen.
    const alpha = 1 - Math.exp(-dt / SMOOTH_TAU_MS);

    for (const v of VISEMES) {
      this.#weights[v] += (target[v] - this.#weights[v]) * alpha;
    }
    this.#onWeights(this.#weights);
  }
}
