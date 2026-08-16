/**
 * Toc do noi cua AI. Dung chung server va client vi ca hai deu phai chan:
 * server chan gia tri trong lesson JSON, client chan gia tri tu slider.
 *
 * Day la HAU KY tren audio da sinh, khong phai model noi cham lai. No khong
 * lam AI chon tu de hon hay ngat nghi nhieu hon — muon vay thi phai viet vao
 * `instructions` (server/prompt.ts). Voi nguoi moi hoc, noi cham ma cau van
 * phuc tap thi gan nhu khong giup duoc gi.
 */

/** Gioi han cua Realtime API. Duoi ~0.7 giong bat dau nghe meo. */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 1.5;
export const SPEED_DEFAULT = 1;

/** Buoc keo slider. 0.05 la du min ma khong cho ra so le lung tung. */
export const SPEED_STEP = 0.05;

const clamp = (n: number): number => Math.min(SPEED_MAX, Math.max(SPEED_MIN, n));

/**
 * Chi nhan number hoac chuoi so KHONG rong.
 *
 * `Number(null)`, `Number('')` va `Number(false)` deu ra 0 — de nguyen thi
 * `REALTIME_SPEED=` bo trong trong .env se chan xuong 0.25 va AI bo ra noi,
 * chu khong roi ve mac dinh nhu nguoi doc file .env tuong.
 */
export function clampSpeed(value: unknown, fallback = SPEED_DEFAULT): number {
  const safeFallback = Number.isFinite(fallback) ? clamp(fallback) : SPEED_DEFAULT;

  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;

  return Number.isFinite(n) ? clamp(n) : safeFallback;
}
