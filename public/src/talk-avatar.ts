/**
 * Avatar nhep mom TRONG hoi thoai.
 *
 * Truoc day day la viec bat kha thi: audio cua AI ve bang media track cua
 * Realtime API, khong kem viseme, khong kem phoneme, khong kem timestamp — chi
 * con cach suy tu pho am thanh, ma cach do dung NHIP nhung sai AM VI. Voi app
 * day phat am thi nhep sai la day sai, nen ca man hoi thoai truoc gio khong co
 * avatar.
 *
 * Gio AI tra ve chu, tieng noi do Polly doc, va Polly tra thang timeline viseme
 * kem moc ms. Khong con gi phai doan.
 *
 * Dung lai nguyen `Avatar` va `VisemePlayer` cua man luyen khau hinh: cung mot
 * bang trong so, cung mot dong ho bam theo `audio.currentTime`. Khac moi mot
 * cho — timeline o day doi theo tung khuc AI doc, thay vi nap mot lan mot cau.
 */

import { Avatar } from './avatar.ts';
import { VisemePlayer } from './viseme-player.ts';
import type { VisemeFrame } from '../../shared/viseme.ts';

export interface TalkAvatar {
  /** Sang khuc moi: nap timeline cua khuc do. */
  load(frames: readonly VisemeFrame[]): void;
  dispose(): void;
}

export interface TalkAvatarOptions {
  canvas: HTMLCanvasElement;
  /** Cho bao ba truong hop hong khac nhau — xem docs/lip-sync.md muc 2. */
  note: HTMLElement;
  /** Chinh la the <audio> ma SpeechQueue dang phat. */
  audio: HTMLAudioElement;
  avatarUrl: string | null;
}

export async function createTalkAvatar({
  canvas,
  note,
  audio,
  avatarUrl,
}: TalkAvatarOptions): Promise<TalkAvatar> {
  const avatar = new Avatar(canvas);
  const player = new VisemePlayer(audio, { onWeights: (w) => avatar.apply(w) });

  // Ba truong hop hong duoc bao KHAC NHAU vi cach sua khac han nhau. Gop lai
  // thanh "khong tai duoc avatar" la bat nguoi doc phai doan.
  if (!avatarUrl) {
    note.textContent = 'Chưa cấu hình AVATAR_URL.';
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
    load: (frames) => player.load(frames),
    dispose: () => {
      player.stop();
      avatar.dispose();
    },
  };
}
