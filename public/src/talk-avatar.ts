/**
 * Avatar nhep mom TRONG hoi thoai, kem 22 thanh do viseme de soi loi.
 *
 * Truoc day day la viec bat kha thi: audio cua AI ve bang media track cua
 * Realtime API, khong kem viseme, khong kem phoneme, khong kem timestamp — chi
 * con cach suy tu pho am thanh, ma cach do dung NHIP nhung sai AM VI.
 *
 * Gio AI tra ve chu, tieng noi do Polly doc, va Polly tra thang timeline viseme
 * kem moc ms. Khong con gi phai doan.
 *
 * Ba tang chong len nhau, moi tang kiem chung duoc rieng:
 *   Polly              -> timeline viseme dung am vi
 *   VisemePlayer       -> khau hinh dang mo + bang trong so, theo audio.currentTime
 *   Avatar (Spine)     -> phat animation viseme_N
 *
 * **Thanh do luon ve, ke ca khi khong cau hinh avatar.** Khi mom avatar dung
 * im, do la cach duy nhat phan biet "du lieu khong chay" voi "rig khong nhan".
 * Nam thanh do bi lam mo la nam khau hinh Polly khong bao gio goi toi duoc —
 * de khong ai mat buoi chieu di tim xem vi sao chung dung im.
 */

import { Avatar, type AvatarBundle } from './avatar.ts';
import { VisemePlayer, type VisemeWeights } from './viseme-player.ts';
import {
  UNREACHABLE_BY_POLLY,
  VISEME_HINT_VI,
  VISEME_IDS,
  type VisemeFrame,
} from '../../shared/viseme.ts';

export interface TalkAvatar {
  /** Sang khuc moi: nap timeline cua khuc do. */
  load(frames: readonly VisemeFrame[]): void;
  dispose(): void;
}

export interface TalkAvatarOptions {
  canvas: HTMLCanvasElement;
  /** Cho bao ba truong hop hong khac nhau — xem bang trong docs/lip-sync.md. */
  note: HTMLElement;
  /** Chua 22 thanh do. */
  bars: HTMLElement;
  /** Mot dong tieng Viet mo ta khau hinh dang mo. */
  hint: HTMLElement;
  /** Chinh la the <audio> ma SpeechQueue dang phat. */
  audio: HTMLAudioElement;
  /** null = nhan vat chua co asset Spine. */
  bundle: AvatarBundle | null;
}

export async function createTalkAvatar({
  canvas,
  note,
  bars,
  hint,
  audio,
  bundle,
}: TalkAvatarOptions): Promise<TalkAvatar> {
  const unreachable = new Set(UNREACHABLE_BY_POLLY);
  const barFills = new Map<number, HTMLElement>();

  bars.replaceChildren(
    ...VISEME_IDS.map((id) => {
      const row = document.createElement('div');
      row.className = unreachable.has(id) ? 'viseme-bar unreachable' : 'viseme-bar';
      if (unreachable.has(id)) row.title = 'Polly không tạo được khẩu hình này';

      const label = document.createElement('span');
      label.className = 'viseme-name';
      label.textContent = String(id);

      const track = document.createElement('div');
      track.className = 'viseme-track';
      const fill = document.createElement('i');
      track.append(fill);
      barFills.set(id, fill);

      row.append(label, track);
      return row;
    })
  );

  const avatar = new Avatar(canvas);
  let loaded = false;

  if (!bundle) {
    note.textContent = 'Nhân vật này chưa có avatar — chỉ hiện thanh đo viseme.';
  } else {
    try {
      await avatar.load(bundle);
      loaded = true;
      // Ba truong hop hong duoc bao KHAC NHAU vi cach sua khac han nhau.
      note.textContent = avatar.visemeCount
        ? ''
        : 'Skeleton tải được nhưng không có animation viseme_N nào — sai bản export.';
    } catch (err) {
      note.textContent = `Không tải được avatar: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  function paintBars(weights: VisemeWeights): void {
    for (const id of VISEME_IDS) {
      const fill = barFills.get(id);
      if (fill) fill.style.transform = `scaleX(${(weights[id] ?? 0).toFixed(3)})`;
    }
  }

  const player = new VisemePlayer(audio, {
    onViseme: (id, weight) => {
      // Rig chua tai duoc thi bo qua, thanh do van chay — do la ca diem cua
      // viec tach hai nhanh nay.
      if (loaded) avatar.playViseme(id, weight);

      // Dong chu doc tu day — tuc la tu TIMELINE, khong tu bang trong so da
      // lam muot. Giua hai khau hinh trong so bi chia doi nen khong cai nao
      // vuot nguong, va dong chu se nhay ve "mieng nghi" mot cai dung luc
      // nguoi hoc dang doc no.
      const text = VISEME_HINT_VI[id] ?? '';
      if (hint.textContent !== text) hint.textContent = text;
    },
    onWeights: paintBars,
  });

  player.start();

  return {
    load: (frames) => player.load(frames),
    dispose: () => {
      player.stop();
      avatar.dispose();
    },
  };
}
