/**
 * Avatar map may mom TRONG hoi thoai, kem vai thanh do de soi loi.
 *
 * NHEP O DAY LA FAKE. Khau hinh suy tu bien do audio, khong tu am vi — dung
 * nhip, sai am vi. Xem dau `fake-mouth.ts` de biet vi sao doi va khi nao phai
 * doi nguoc lai.
 *
 * Ba tang chong len nhau, moi tang kiem chung duoc rieng:
 *   FakeMouthPlayer  -> bien do the <audio> -> khau hinh + do mo
 *   Avatar (Spine)   -> phat animation viseme_N tren track 1
 *   thanh do         -> nhin thay du lieu co chay khong khi mom dung im
 *
 * **Thanh do luon ve, ke ca khi khong cau hinh avatar.** Khi mom avatar dung
 * im, do la cach duy nhat phan biet "du lieu khong chay" voi "rig khong nhan".
 *
 * Chi ve thanh do cho nhung khau hinh fake THAT SU dung toi, cong mot thanh do
 * mo. Truoc day o day ve du 22 thanh vi Polly cham toi 17 trong so do; gio chi
 * con nam hinh song, ma 17 thanh dung im vinh vien thi dung la cai bay ma hang
 * so `UNREACHABLE_BY_POLLY` ngay xua duoc sinh ra de tranh.
 */

import { Avatar, type AvatarBundle } from './avatar.ts';
import { FakeMouthPlayer, FAKE_VISEME_IDS, type MouthFrame } from './fake-mouth.ts';
import type { VisemeId } from '../../shared/viseme.ts';

export interface TalkAvatar {
  dispose(): void;
}

export interface TalkAvatarOptions {
  canvas: HTMLCanvasElement;
  /** Cho bao ba truong hop hong khac nhau — xem bang trong docs/lip-sync.md. */
  note: HTMLElement;
  /** Chua cac thanh do. */
  bars: HTMLElement;
  /** Chinh la the <audio> ma SpeechQueue dang phat. */
  audio: HTMLAudioElement;
  /** null = nhan vat chua co asset Spine. */
  bundle: AvatarBundle | null;
}

/** Nhan cua thanh do mo — no khong phai mot viseme ID nen khong nam trong bo kia. */
const LEVEL_LABEL = 'mở';

export async function createTalkAvatar({
  canvas,
  note,
  bars,
  audio,
  bundle,
}: TalkAvatarOptions): Promise<TalkAvatar> {
  const fills = new Map<VisemeId | typeof LEVEL_LABEL, HTMLElement>();

  const makeBar = (key: VisemeId | typeof LEVEL_LABEL, label: string): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'viseme-bar';

    const name = document.createElement('span');
    name.className = 'viseme-name';
    name.textContent = label;

    const track = document.createElement('div');
    track.className = 'viseme-track';
    const fill = document.createElement('i');
    track.append(fill);
    fills.set(key, fill);

    row.append(name, track);
    return row;
  };

  bars.replaceChildren(
    // Do mo di truoc: khi mom dung im, day la thanh phan biet "khong co tin
    // hieu audio nao" voi "co tin hieu ma rig khong nhan".
    makeBar(LEVEL_LABEL, LEVEL_LABEL),
    ...FAKE_VISEME_IDS.map((id) => makeBar(id, String(id)))
  );

  const avatar = new Avatar(canvas);
  let loaded = false;

  if (!bundle) {
    note.textContent = 'Nhân vật này chưa có avatar — chỉ hiện thanh đo.';
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

  const paint = (frame: MouthFrame): void => {
    const level = fills.get(LEVEL_LABEL);
    if (level) level.style.transform = `scaleX(${frame.level.toFixed(3)})`;

    for (const id of FAKE_VISEME_IDS) {
      const fill = fills.get(id);
      // Khau hinh la roi rac: chi mot cai dang mo, va no cao bang chinh alpha
      // dang day vao Spine. Nho vay nhin thanh do la biet Spine dang nhan gi.
      if (fill) {
        fill.style.transform = `scaleX(${(id === frame.id ? frame.weight : 0).toFixed(3)})`;
      }
    }
  };

  const player = new FakeMouthPlayer(audio, {
    onMouth: (frame) => {
      // Rig chua tai duoc thi bo qua, thanh do van chay — do la ca diem cua
      // viec tach hai nhanh nay.
      if (loaded) avatar.playViseme(frame.id, frame.weight);
      paint(frame);
    },
  });

  player.start();

  return {
    dispose: () => {
      player.stop();
      avatar.dispose();
    },
  };
}
