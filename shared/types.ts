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

export interface TokenResponse {
  clientSecret: string;
  expiresAt: number;
  model: string;
  seedItems: SeedItem[];
  progress: ProgressRecord[];
}
