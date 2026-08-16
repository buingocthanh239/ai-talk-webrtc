/**
 * Doi mot khuc audio phat xong.
 *
 * Tach ra khoi `speech-queue.ts` vi mot ly do duy nhat: cho nay tung co mot
 * loi im lang lam mat tieng, va no chi lo ra khi mo phong dung hanh vi cua
 * the <audio>. Tach ra thi test duoc ma khong can trinh duyet.
 *
 * LOI DA TUNG CO O DAY. Danh sach su kien tung gom ca `emptied`, de `cancel()`
 * khong lam treo vong phat. Nhung `emptied` KHONG chi den tu cancel:
 *
 *   Gan `audio.src` se kich hoat "media element load algorithm" cua HTML, va
 *   thuat toan do xep hang mot task ban ra `emptied` moi khi `networkState` la
 *   NETWORK_LOADING hoac NETWORK_IDLE — tuc la moi lan element DA co nguon.
 *
 * Listener duoc gan ngay sau dong `src = ...` trong cung mot khoi dong bo, nen
 * no bat duoc chinh cai `emptied` cua minh. Ket qua: tu khuc thu HAI tro di,
 * lan cho ket thuc ngay lap tuc, vong phat chay tiep va ghi de `src` — khuc
 * dang doc bi cat ngang. Nghe ra la "AI bo mat vai doan".
 *
 * Cach dung o day: chi nghe hai su kien that su co nghia la "xong", con duong
 * huy thi goi thang `finish()` chu khong muon mot su kien nao lam tin.
 */

/** Phan be mat cua HTMLAudioElement ma cho nay dung toi. */
export interface PlaybackTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface PlaybackWait {
  /** Ket thuc khi audio phat xong, loi, hoac khi `finish()` duoc goi. */
  done: Promise<void>;
  /**
   * Ket thuc lan cho bang tay. Danh cho `cancel()`: go `src` ra khoi <audio>
   * khong ban ra `ended`, nen khong co no thi vong phat treo vinh vien.
   *
   * Goi nhieu lan la vo hai.
   */
  finish: () => void;
}

/** Su kien that su co nghia la khuc nay khong con phat nua. */
const END_EVENTS = ['ended', 'error'] as const;

export function waitForPlayback(audio: PlaybackTarget): PlaybackWait {
  let resolve: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolve = r;
  });

  const finish = (): void => {
    for (const e of END_EVENTS) audio.removeEventListener(e, finish);
    resolve();
  };
  for (const e of END_EVENTS) audio.addEventListener(e, finish);

  return { done, finish };
}
