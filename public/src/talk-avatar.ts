/**
 * Avatar nhep mom trong hoi thoai, kem 15 thanh do viseme de soi loi.
 *
 * Truoc day day la viec bat kha thi: audio cua AI ve bang media track cua
 * Realtime API, khong kem viseme, khong kem phoneme, khong kem timestamp — chi
 * con cach suy tu pho am thanh, ma cach do dung NHIP nhung sai AM VI. Voi app
 * day phat am thi nhep sai la day sai.
 *
 * Gio AI tra ve chu, tieng noi do Polly doc, va Polly tra thang timeline viseme
 * kem moc ms. Khong con gi phai doan.
 *
 * Ba tang chong len nhau, moi tang kiem chung duoc rieng:
 *   Polly              -> timeline viseme dung am vi
 *   VisemePlayer       -> trong so theo audio.currentTime
 *   Avatar / thanh do  -> ve ra
 *
 * **Thanh do luon ve, ke ca khi khong cau hinh AVATAR_URL.** Khi mom avatar
 * dung im, do la cach duy nhat phan biet "du lieu khong chay" voi "model thieu
 * morph target" — va avatar thi chua ai tung thay chay lan nao.
 */

import { Avatar } from './avatar.ts';
import { VisemePlayer, type VisemeWeights } from './viseme-player.ts';
import {
  VISEMES,
  VISEME_HINT_VI,
  frameAt,
  type Viseme,
  type VisemeFrame,
} from '../../shared/viseme.ts';

/** Duoi nguong nay coi nhu khong co khau hinh nao dang mo — hien 'nghi'. */
const HINT_THRESHOLD = 0.35;

export interface TalkAvatar {
  /** Sang khuc moi: nap timeline cua khuc do. */
  load(frames: readonly VisemeFrame[]): void;
  dispose(): void;
}

export interface TalkAvatarOptions {
  canvas: HTMLCanvasElement;
  /** Cho bao ba truong hop hong khac nhau — xem bang o duoi. */
  note: HTMLElement;
  /** Chua 15 thanh do. */
  bars: HTMLElement;
  /** Mot dong tieng Viet mo ta khau hinh dang mo. */
  hint: HTMLElement;
  /** Chinh la the <audio> ma SpeechQueue dang phat. */
  audio: HTMLAudioElement;
  avatarUrl: string | null;
}

export async function createTalkAvatar({
  canvas,
  note,
  bars,
  hint,
  audio,
  avatarUrl,
}: TalkAvatarOptions): Promise<TalkAvatar> {
  const barFills = new Map<Viseme, HTMLElement>();
  let frames: readonly VisemeFrame[] = [];

  bars.replaceChildren(
    ...VISEMES.map((v) => {
      const row = document.createElement('div');
      row.className = 'viseme-bar';

      const label = document.createElement('span');
      label.className = 'viseme-name';
      label.textContent = v;

      const track = document.createElement('div');
      track.className = 'viseme-track';
      const fill = document.createElement('i');
      track.append(fill);
      barFills.set(v, fill);

      row.append(label, track);
      return row;
    })
  );

  const avatar = new Avatar(canvas);

  function paint(weights: VisemeWeights): void {
    for (const v of VISEMES) {
      const fill = barFills.get(v);
      if (fill) fill.style.transform = `scaleX(${weights[v].toFixed(3)})`;
    }
    avatar.apply(weights);

    // Doc tu TIMELINE chu khong tu bang trong so da lam muot: giua hai khau
    // hinh, trong so bi chia doi nen khong cai nao vuot nguong va dong chu se
    // nhay ve 'nghi' mot cai — dung luc nguoi hoc dang doc no.
    const active = frameAt(frames, audio.currentTime * 1000);
    const viseme = active && active.frame.weight >= HINT_THRESHOLD ? active.frame.viseme : 'sil';
    const text = VISEME_HINT_VI[viseme];
    if (hint.textContent !== text) hint.textContent = text;
  }

  const player = new VisemePlayer(audio, { onWeights: paint });

  // Ba truong hop hong duoc bao KHAC NHAU vi cach sua khac han nhau. Gop lai
  // thanh "khong tai duoc avatar" la bat nguoi doc phai doan.
  if (!avatarUrl) {
    note.textContent = 'Chưa cấu hình AVATAR_URL — chỉ hiện thanh đo viseme.';
  } else {
    try {
      await avatar.load(avatarUrl);
      note.textContent = avatar.targetCount
        ? ''
        : 'Model tải được nhưng không có morph target viseme nào — thiếu ?morphTargets=Oculus Visemes';
    } catch (err) {
      note.textContent = `Không tải được avatar: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  avatar.start();
  // Vong render chay ca khi audio dang dung: giua hai khuc, hay luc nguoi hoc
  // dang nghi, mom van phai giu dung khau hinh cua moc do chu khong dong bang
  // o khung cuoi cua khuc truoc.
  player.start();

  return {
    load: (next) => {
      frames = next;
      player.load(next);
    },
    dispose: () => {
      player.stop();
      avatar.dispose();
    },
  };
}
