/**
 * Kieu dung chung cho ca server va client.
 *
 * Day la cac hinh dang di qua ranh gioi HTTP, nen mot thay doi o day se lam
 * tsc bao loi o CA HAI phia — dung y la vay: truoc kia sua hinh dang JSON o
 * server ma quen sua client thi phai den luc chay moi biet.
 */

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
  sessionToken: string;
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
   * File .glb cua avatar cho man hoi thoai. null thi khong dung avatar.
   *
   * Di kem token chu khong co endpoint rieng: day la thu duy nhat man hoi thoai
   * con thieu, va no da goi `/token` roi.
   */
  avatarUrl: string | null;
}
