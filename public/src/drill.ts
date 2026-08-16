/**
 * Man luyen khau hinh.
 *
 * Tach hoan toan khoi buoi hoi thoai — khong dung toi WebRTC, khong ton han
 * muc goi. Ly do: trong hoi thoai AI noi ~150 tu/phut, khong ai nhin kip
 * khau hinh. Cho hoc duoc that su la luc dung lai, keo cham xuong 0.4x, tua
 * ve dung am vua sai. O day text biet truoc nen viseme la CHINH XAC, khong
 * phai suy doan tu am thanh.
 *
 * Ba tang chong len nhau, moi tang kiem chung duoc rieng:
 *   Polly (server)     -> timeline viseme dung am vi
 *   VisemePlayer       -> trong so theo audio.currentTime
 *   Avatar / thanh do  -> ve ra
 * Thanh do luon hien, ke ca khi khong cau hinh avatar: no la cach nhanh nhat
 * de biet mom dung im la do du lieu hay do model.
 */

import { api } from './api.ts';
import { Avatar } from './avatar.ts';
import { VisemePlayer, type VisemeWeights } from './viseme-player.ts';
import {
  VISEMES,
  VISEME_HINT_VI,
  frameAt,
  type DrillItem,
  type Viseme,
} from '../../shared/viseme.ts';

/** Cac muc toc do. 0.4x la nguong con nghe ra tu, cham hon thi thanh tieng u. */
const RATES = [1, 0.7, 0.4] as const;

/** Duoi nguong nay coi nhu khong co khau hinh nao dang mo — hien 'nghi'. */
const HINT_THRESHOLD = 0.35;

export interface DrillScreen {
  /** Nap bai va bat vong render. */
  open(lessonId: string): Promise<void>;
  /** Dung het rAF va tieng. Phai goi khi roi man, neu khong avatar ve mai. */
  close(): void;
}

interface Dom {
  root: HTMLElement;
  list: HTMLElement;
  canvas: HTMLCanvasElement;
  avatarNote: HTMLElement;
  bars: HTMLElement;
  hint: HTMLElement;
  phrase: HTMLElement;
  audio: HTMLAudioElement;
  playBtn: HTMLButtonElement;
  rateBtns: HTMLElement;
  scrub: HTMLInputElement;
  status: HTMLElement;
}

export function createDrillScreen(dom: Dom): DrillScreen {
  let items: DrillItem[] = [];
  let current: DrillItem | null = null;
  let avatar: Avatar | null = null;
  let rate: number = RATES[0];

  const barFills = new Map<Viseme, HTMLElement>();
  buildBars();

  const player = new VisemePlayer(dom.audio, { onWeights: paint });

  function buildBars(): void {
    dom.bars.replaceChildren(
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
  }

  function paint(weights: VisemeWeights): void {
    for (const v of VISEMES) {
      const fill = barFills.get(v);
      if (fill) fill.style.transform = `scaleX(${weights[v].toFixed(3)})`;
    }
    avatar?.apply(weights);

    // Goi y bang chu doc tu TIMELINE chu khong tu bang trong so da lam muot:
    // giua hai khau hinh, trong so bi chia doi nen khong cai nao vuot nguong
    // va dong chu se nhay ve 'nghi' mot cai — dung luc nguoi hoc dang doc.
    const active = frameAt(current?.frames ?? [], dom.audio.currentTime * 1000);
    const viseme = active && active.frame.weight >= HINT_THRESHOLD ? active.frame.viseme : 'sil';
    const text = VISEME_HINT_VI[viseme];
    if (dom.hint.textContent !== text) dom.hint.textContent = text;

    if (dom.audio.duration > 0 && !scrubbing) {
      dom.scrub.value = String((dom.audio.currentTime / dom.audio.duration) * 1000);
    }
  }

  function select(item: DrillItem): void {
    current = item;
    dom.phrase.textContent = item.text;
    dom.audio.src = item.audioUrl;
    dom.audio.playbackRate = rate;
    dom.scrub.value = '0';
    player.load(item.frames);

    for (const node of dom.list.querySelectorAll('.drill-phrase')) {
      node.classList.toggle('active', (node as HTMLElement).dataset['id'] === item.id);
    }
    void dom.audio.play().catch(() => {
      /* trinh duyet chan autoplay thi cho bam nut */
    });
  }

  function renderList(): void {
    const groups: [DrillItem['source'], string][] = [
      ['vocabulary', 'Từ vựng'],
      ['example', 'Câu mẫu'],
    ];

    const nodes: HTMLElement[] = [];
    for (const [source, title] of groups) {
      const group = items.filter((i) => i.source === source);
      if (!group.length) continue;

      const heading = document.createElement('h3');
      heading.textContent = title;
      nodes.push(heading);

      for (const item of group) {
        const btn = document.createElement('button');
        btn.className = 'drill-phrase';
        btn.dataset['id'] = item.id;
        btn.textContent = item.text;
        btn.onclick = () => select(item);
        nodes.push(btn);
      }
    }
    dom.list.replaceChildren(...nodes);
  }

  function renderRates(): void {
    dom.rateBtns.replaceChildren(
      ...RATES.map((value) => {
        const btn = document.createElement('button');
        btn.className = `ghost-btn small${value === rate ? ' active' : ''}`;
        btn.textContent = `${value}×`;
        btn.onclick = () => {
          rate = value;
          dom.audio.playbackRate = value;
          renderRates();
        };
        return btn;
      })
    );
  }

  /** Keo thanh tua thi khong de vong render ghi de len gia tri dang keo. */
  let scrubbing = false;
  dom.scrub.oninput = () => {
    scrubbing = true;
    if (dom.audio.duration > 0) {
      dom.audio.currentTime = (Number(dom.scrub.value) / 1000) * dom.audio.duration;
    }
  };
  dom.scrub.onchange = () => {
    scrubbing = false;
  };

  dom.playBtn.onclick = () => {
    if (dom.audio.paused) void dom.audio.play().catch(() => {});
    else dom.audio.pause();
  };
  dom.audio.onplay = () => {
    dom.playBtn.textContent = '⏸ Tạm dừng';
  };
  dom.audio.onpause = () => {
    dom.playBtn.textContent = '▶ Phát lại';
  };
  dom.audio.onended = () => {
    dom.playBtn.textContent = '▶ Phát lại';
  };

  /**
   * Avatar la tuy chon. Chua cau hinh, hay tai hong, hay model khong co morph
   * target Oculus — ca ba deu chi lam mat phan 3D, thanh do van chay. Noi ro
   * la ba truong hop khac nhau, vi cach sua khac han nhau.
   */
  async function setupAvatar(url: string | null): Promise<void> {
    if (!url) {
      dom.avatarNote.textContent =
        'Chưa cấu hình AVATAR_URL — đang hiển thị thanh đo viseme thay cho mô hình 3D.';
      dom.canvas.classList.add('hidden');
      return;
    }

    try {
      const instance = new Avatar(dom.canvas);
      await instance.load(url);
      if (instance.targetCount === 0) {
        instance.dispose();
        dom.canvas.classList.add('hidden');
        dom.avatarNote.textContent =
          'Model tải được nhưng không có morph target viseme nào. Với Ready Player Me, ' +
          'tải lại file .glb kèm ?morphTargets=Oculus Visemes.';
        return;
      }
      instance.start();
      avatar = instance;
      dom.avatarNote.textContent = '';
    } catch (err) {
      dom.canvas.classList.add('hidden');
      dom.avatarNote.textContent = `Không tải được avatar: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  return {
    async open(lessonId: string): Promise<void> {
      dom.status.textContent = 'Đang chuẩn bị bài đọc…';
      dom.list.replaceChildren();
      renderRates();

      let data;
      try {
        data = await api.getDrill(lessonId);
      } catch (err) {
        dom.status.textContent = `Không tải được: ${
          err instanceof Error ? err.message : String(err)
        }`;
        return;
      }

      if (!data.enabled) {
        dom.status.textContent =
          'Chế độ luyện khẩu hình chưa bật. Đặt POLLY=on trong .env rồi khởi động lại server.';
        return;
      }
      if (!data.items.length) {
        dom.status.textContent = 'Bài học này chưa có từ vựng hoặc câu mẫu nào để luyện.';
        return;
      }

      items = data.items;
      dom.status.textContent = '';
      renderList();
      await setupAvatar(data.avatarUrl);
      player.start();
      select(items[0]!);
    },

    close(): void {
      dom.audio.pause();
      dom.audio.removeAttribute('src');
      player.stop();
      avatar?.dispose();
      avatar = null;
      current = null;
    },
  };
}
