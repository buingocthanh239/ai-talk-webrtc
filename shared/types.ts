/**
 * Kieu dung chung cho ca server va client.
 *
 * Day la cac hinh dang di qua ranh gioi HTTP, nen mot thay doi o day se lam
 * tsc bao loi o CA HAI phia — dung y la vay: truoc kia sua hinh dang JSON o
 * server ma quen sua client thi phai den luc chay moi biet.
 */

// Xuat lai de cho goi chi phai import mot cho. Dinh nghia va ham chan gia tri
// la nam o `shared/voice-mode.ts` — file nay chi chua kieu, khong chua logic.
export type { VoiceMode } from './voice-mode.ts';
import type { VoiceMode } from './voice-mode.ts';

export interface Objective {
  id: string;
  text: string;
  required: boolean;
  examples: string[];
}

export interface Vocabulary {
  term: string;
  meaning: string;
}

export interface Grammar {
  point: string;
  note: string;
}

export interface Lesson {
  id: string;
  title: string;
  level: string;
  estimatedMinutes: number;
  scenario: string;
  allowVietnameseHint: boolean;
  minTurns: number;
  /**
   * Toc do noi mac dinh cua AI cho bai nay (0.25–1.5). Bai trinh do thap de
   * cham lai. Nguoi hoc de len duoc bang slider; de trong = 1.0.
   */
  speed?: number;
  objectives: Objective[];
  vocabulary: Vocabulary[];
  grammar: Grammar[];
}

export type ProgressStatus = 'pending' | 'done' | 'struggling';

export interface ProgressRecord {
  objectiveId: string;
  status: ProgressStatus;
  evidence: string | null;
  messageSeq: number | null;
}

/** Muc tieu kem trang thai, dung de ve danh sach tren man hinh. */
export type ObjectiveProgress = Objective & {
  status: ProgressStatus;
  evidence: string | null;
};

export type Role = 'user' | 'assistant';

export interface Message {
  seq: number;
  role: Role;
  text: string;
  audioUrl: string | null;
  durationMs: number | null;
}

export interface Mistake {
  said: string;
  better: string;
  explanation_vi: string;
  type: string;
  message_seq: number;
}

export interface Summary {
  overall: number | null;
  pronunciation: number | null;
  grammar: number | null;
  vocabulary: number | null;
  fluency: number | null;
  turnCount: number;
  hintCount: number;
  coachNoteVi?: string;
  pronunciationNoteVi?: string;
  pronunciationSegments?: { message_seq: number; score: number; issues: string[] }[];
  objectives?: { id: string; passed: boolean; evidence?: string }[];
  mistakes?: Mistake[];
  strengths?: string[];
  nextFocus?: string[];
  warnings?: string[];
}

export interface SessionDetail {
  sessionId: string;
  status: 'active' | 'ended';
  startedAt: number;
  endedAt: number | null;
  hintCount: number;
  lesson: Lesson;
  messages: Message[];
  summary: Summary | null;
  character: Character;
  /**
   * Cap ngay tai day de man tong ket doc lai cau AI bang Polly ma khong phai
   * xin them mot vong. Buoi hoc cu thi credential luc hoc da het han tu lau,
   * nen phai la ban moi chu khong phai ban da luu.
   */
  pollyGrant: PollyGrant | null;
}

export interface SessionListItem {
  id: string;
  lessonTitle: string;
  startedAt: number;
  messageCount: number;
  status: 'active' | 'ended';
  overall: number | null;
}

/** Han muc goi mien phi con lai trong ngay. */
export interface Quota {
  usedMs: number;
  remainingMs: number;
  totalMs: number;
  resetAt: number;
}

/** Mot luot noi duoc bom lai vao hoi thoai sau khi noi lai ket noi. */
export interface SeedItem {
  role: Role;
  text: string;
}

/**
 * Quyen ghi thang len S3, cap mot lan cho ca buoi hoc.
 *
 * Chu ky rang buoc theo DIEU KIEN chu khong theo mot key cu the, nen client
 * dat duoc ten file cho tung luot noi ma khong phai xin lai — khong them round
 * trip nao tren duong nong sau moi cau. `fields` phai duoc dua vao FormData
 * TRUOC phan `file`, dung thu tu nay.
 *
 * null nghia la server dang luu audio tren dia: cu POST WAV len backend nhu cu.
 */
export interface UploadGrant {
  url: string;
  fields: Record<string, string>;
  keyPrefix: string;
  expiresAt: number;
}

/** Engine `generative` khong nam trong day: no khong tra speech marks. */
export type PollyEngine = 'standard' | 'neural' | 'long-form';

/** Asset Spine cua mot nhan vat. null = nhan vat chua co avatar. */
export interface AvatarBundle {
  /** `.skel` (nhi phan, nho hon nhieu) hoac `.json`. */
  skeleton: string;
  atlas: string;
}

/**
 * Mot nhan vat AI: khuon mat, giong noi va tinh cach.
 *
 * `personality` / `voiceStyle` / `greetingStyle` di THANG vao instructions
 * (`server/prompt.ts`). Khong co phan do thi doi nhan vat chi la doi anh voi
 * doi giong, con AI van noi y het nhau — tuc la khong co nhan vat nao ca.
 */
export interface Character {
  code: string;
  name: string;
  sort: number;
  tier: 'free' | 'paid';
  gender: 'male' | 'female' | 'neutral';
  tags: string[];
  personality: string;
  voiceStyle: string;
  /** De trong thi AI tu chao theo tinh cach cua no. */
  greetingStyle: string;
  /**
   * He so toc do NEN cua nhan vat, nhan voi slider cua nguoi hoc.
   * Leo 1.05 x slider 0.8 = 0.84.
   */
  speed: number;
  voice: { voiceId: string; engine: PollyEngine };
  /**
   * Giong ben OpenAI Realtime, dung o mode `openai`.
   *
   * Phai la mot truong RIENG chu khong tai su dung `voice.voiceId`: hai nha
   * cung cap co hai bo ten khong giao nhau (`Ruth` cua Polly vs `coral` cua
   * OpenAI), gui nham la Realtime API tra 400 ngay luc bat tay.
   */
  openaiVoice: string;
  avatar: AvatarBundle | null;
}

export interface CharacterList {
  characters: Character[];
  /** `code` cua nhan vat mac dinh. Luon tro toi mot nhan vat co that. */
  defaultCode: string;
}

/**
 * Quyen goi Amazon Polly, cap mot lan cho ca buoi hoc.
 *
 * Client tu ky SigV4 va goi thang Polly — backend khong nam tren duong audio.
 * Doi lai credential nam trong browser, nen no bi rang vao IP cua chinh client
 * va co han ngan; xem `server/sts.ts`.
 *
 * null nghia la chua cau hinh STS: hoi thoai se khong co tieng noi cua AI.
 */
export interface PollyGrant {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Vang mat khi backend dua thang credential dai han cua no xuong (khong qua
   * STS). Duong do chi danh cho demo — xem `server/sts.ts`.
   */
  sessionToken?: string;
  expiresAt: number;
  /** Giong mac dinh. Nguoi hoc doi duoc o phia client. */
  voiceId: string;
  engine: PollyEngine;
}

export interface TokenResponse {
  clientSecret: string;
  expiresAt: number;
  model: string;
  seedItems: SeedItem[];
  progress: ProgressRecord[];
  uploadGrant: UploadGrant | null;
  pollyGrant: PollyGrant | null;
  /**
   * Nhan vat cua buoi hoc nay. Di kem token chu khong co endpoint rieng: no la
   * nguon duy nhat cho ca giong doc, he so toc do lan asset avatar.
   */
  character: Character;
  /**
   * Duong dua tieng AI ra loa cua buoi hoc nay. Nguon la cot `voice_mode` cua
   * session chu khong phai thu client gui len — client doc localStorage de VE
   * nut chon, nhung thu chot la day, va no khong doi giua buoi (reconnect va
   * resume deu di lai duong nay).
   */
  voiceMode: VoiceMode;
}
