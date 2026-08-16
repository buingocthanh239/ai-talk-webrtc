/**
 * Che do luyen khau hinh: doc truoc cac cau muc tieu cua bai hoc bang Polly,
 * cache lai, roi tra ve cho client kem timeline viseme.
 *
 * Vi sao lam truoc chu khong lam trong luc hoi thoai: trong hoi thoai AI noi
 * ~150 tu/phut, khong ai nhin kip khau hinh. Cho nguoi hoc THAT SU hoc duoc
 * la luc dung lai, xem cham, lap lai — ma o do text biet truoc, nen khong
 * phai doan gi ca. Duong audio nong cua buoi hoc khong bi dong toi mot dong.
 *
 * Cache la vinh vien theo (giong, engine, text). Sinh mot lan roi thoi: hai
 * bai hien co cong lai 527 ky tu, ton khoang $0.017 cho ca hai lan goi.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AUDIO_DIR } from './db.ts';
import { drillId, synthesize, type PollyConfig } from './polly.ts';
import type { Lesson } from '../shared/types.ts';
import type { DrillItem, VisemeFrame } from '../shared/viseme.ts';

/** Nam trong AUDIO_DIR de dung nho route tinh `/audio/` co san. */
const DRILL_DIR = join(AUDIO_DIR, 'drill');

const audioPath = (id: string): string => join(DRILL_DIR, `${id}.mp3`);
const framesPath = (id: string): string => join(DRILL_DIR, `${id}.json`);
const audioUrl = (id: string): string => `/audio/drill/${id}.mp3`;

interface Target {
  text: string;
  source: DrillItem['source'];
}

/**
 * Cac cau dang de luyen khau hinh trong mot bai.
 *
 * Tu vung va vi du cua muc tieu — dung nhung thu bai hoc DA khai bao, khong
 * de nguoi soan bai phai viet them mot danh sach thu ba roi de no troi khoi
 * noi dung bai.
 */
export function drillTargets(lesson: Lesson): Target[] {
  const seen = new Set<string>();
  const targets: Target[] = [];

  const add = (raw: string, source: Target['source']): void => {
    const text = raw.trim();
    // Trung nhau thi giu ban dau: mot tu vung cung xuat hien trong vi du thi
    // khong co ly do doc va tra tien hai lan.
    if (!text || seen.has(text.toLowerCase())) return;
    seen.add(text.toLowerCase());
    targets.push({ text, source });
  };

  for (const v of lesson.vocabulary ?? []) add(v.term, 'vocabulary');
  for (const o of lesson.objectives ?? []) {
    for (const ex of o.examples ?? []) add(ex, 'example');
  }
  return targets;
}

/** Doc cache tren dia. null = chua co, phai goi Polly. */
async function cached(id: string): Promise<VisemeFrame[] | null> {
  try {
    const [raw] = await Promise.all([readFile(framesPath(id), 'utf8'), readFile(audioPath(id))]);
    return JSON.parse(raw) as VisemeFrame[];
  } catch {
    return null; // thieu mot trong hai file thi coi nhu chua co
  }
}

async function store(id: string, audio: Buffer, frames: VisemeFrame[]): Promise<void> {
  await mkdir(DRILL_DIR, { recursive: true });
  // Ghi audio TRUOC: neu chet giua chung thi lan sau `cached` thay thieu file
  // json va sinh lai, con nguoc lai se tra ve timeline khong co tieng di kem.
  await writeFile(audioPath(id), audio);
  await writeFile(framesPath(id), JSON.stringify(frames));
}

/**
 * Timeline + audio cho ca bai hoc.
 *
 * Cac cau chua co cache duoc doc TUAN TU chu khong song song: day la duong
 * lanh, chay mot lan cho moi bai, va ban song song vai chuc request len Polly
 * chi de tiet kiem vai giay thi de an throttle hon la duoc gi.
 *
 * Mot cau hong khong lam hong ca bai — bo cau do ra khoi ket qua va ghi log.
 */
export async function buildDrill(cfg: PollyConfig, lesson: Lesson): Promise<DrillItem[]> {
  const items: DrillItem[] = [];

  for (const target of drillTargets(lesson)) {
    const id = drillId(cfg, target.text);
    try {
      let frames = await cached(id);
      if (!frames) {
        const result = await synthesize(cfg, target.text);
        await store(id, result.audio, result.frames);
        frames = result.frames;
      }
      items.push({ id, text: target.text, source: target.source, audioUrl: audioUrl(id), frames });
    } catch (err) {
      console.warn(
        `[drill] bo qua "${target.text}" trong bai ${lesson.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return items;
}
