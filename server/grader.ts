import { readAudio } from './audio-store.ts';

import type { Lesson, ProgressRecord, Summary } from '../shared/types.ts';
import type { SessionRow, StoredMessage } from './db.ts';

/** Message kem cho luu file wav — chi khau cham diem moi can. */
export type GradingMessage = StoredMessage;

const API = 'https://api.openai.com/v1/chat/completions';

/** So doan audio toi da gui di cham phat am — chan chi phi cho ban demo. */
const MAX_AUDIO_SEGMENTS = 5;

const TEXT_SCHEMA = {
  type: 'object',
  properties: {
    grammar: { type: 'integer', description: '0-100' },
    vocabulary: { type: 'integer', description: '0-100' },
    fluency: { type: 'integer', description: '0-100' },
    objectives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          passed: { type: 'boolean' },
          evidence: { type: 'string' },
        },
        required: ['id', 'passed', 'evidence'],
        additionalProperties: false,
      },
    },
    mistakes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          message_seq: { type: 'integer' },
          said: { type: 'string' },
          better: { type: 'string' },
          type: {
            type: 'string',
            enum: ['grammar', 'vocabulary', 'word_order', 'politeness', 'naturalness'],
          },
          explanation_vi: { type: 'string' },
        },
        required: ['message_seq', 'said', 'better', 'type', 'explanation_vi'],
        additionalProperties: false,
      },
    },
    strengths: { type: 'array', items: { type: 'string' } },
    next_focus: { type: 'array', items: { type: 'string' } },
    coach_note_vi: { type: 'string' },
  },
  required: [
    'grammar',
    'vocabulary',
    'fluency',
    'objectives',
    'mistakes',
    'strengths',
    'next_focus',
    'coach_note_vi',
  ],
  additionalProperties: false,
};

const AUDIO_SCHEMA = {
  type: 'object',
  properties: {
    pronunciation: { type: 'integer', description: '0-100' },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          message_seq: { type: 'integer' },
          score: { type: 'integer' },
          issues: { type: 'array', items: { type: 'string' } },
        },
        required: ['message_seq', 'score', 'issues'],
        additionalProperties: false,
      },
    },
    note_vi: { type: 'string' },
  },
  required: ['pronunciation', 'segments', 'note_vi'],
  additionalProperties: false,
};

interface ChatCompletion {
  choices?: { message?: { content?: string } }[];
}

/**
 * Ket qua cham. Hinh dang nay do TEXT_SCHEMA / AUDIO_SCHEMA phia duoi ep buoc
 * (json_schema strict), nen ep kieu o day la co can cu chu khong phai doan.
 */
export interface TextGrade {
  grammar: number;
  vocabulary: number;
  fluency: number;
  objectives: { id: string; passed: boolean; evidence?: string }[];
  mistakes: Summary['mistakes'];
  strengths: string[];
  next_focus: string[];
  coach_note_vi: string;
}

export interface AudioGrade {
  pronunciation: number;
  segments: { message_seq: number; score: number; issues: string[] }[];
  note_vi: string;
}

async function callOpenAI<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const json = (await res.json()) as ChatCompletion;
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI tra ve response rong');
  return JSON.parse(content) as T;
}

function renderTranscript(messages: GradingMessage[]): string {
  return messages
    .filter((m) => m.text?.trim())
    .map((m) => `[${m.seq}] ${m.role === 'user' ? 'LEARNER' : 'COACH'}: ${m.text}`)
    .join('\n');
}

/** Cham grammar / vocabulary / objectives tren transcript text. */
async function gradeText(
  lesson: Lesson,
  messages: GradingMessage[],
  progress: ProgressRecord[]
): Promise<TextGrade> {
  const model = process.env.GRADER_TEXT_MODEL || 'gpt-4o';

  const objectiveList = lesson.objectives
    .map((o) => `- ${o.id} (${o.required ? 'required' : 'optional'}): ${o.text}`)
    .join('\n');

  const liveProgress = progress.length
    ? progress.map((p) => `- ${p.objectiveId}: ${p.status} — "${p.evidence ?? ''}"`).join('\n')
    : '(the coach marked nothing during the lesson)';

  const prompt = `You are grading a spoken English practice session for a Vietnamese learner at CEFR level ${lesson.level}.

LESSON: ${lesson.title}
OBJECTIVES:
${objectiveList}

WHAT THE COACH MARKED DURING THE LESSON (treat as a hint, verify it yourself against the transcript):
${liveProgress}

TRANSCRIPT (numbers in brackets are message ids — you MUST reference them in "message_seq"):
${renderTranscript(messages)}

Grade ONLY the LEARNER's turns. Rules:
- Scores are 0-100, calibrated for level ${lesson.level}, not for a native speaker.
- The transcript comes from speech recognition, so ignore punctuation and capitalisation entirely.
- Report at most 6 mistakes, the ones most worth fixing. Every mistake MUST cite a real message_seq
  from a LEARNER turn and quote what they actually said.
- "explanation_vi" is written in Vietnamese, one short sentence, for a Vietnamese learner.
- "coach_note_vi" is 2-3 encouraging sentences in Vietnamese.
- If the learner barely spoke, say so honestly and score low rather than inventing praise.`;

  return callOpenAI({
    model,
    messages: [{ role: 'user', content: prompt }],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'lesson_grade', strict: true, schema: TEXT_SCHEMA },
    },
  });
}

/**
 * Cham phat am tren chinh cac doan wav cua user.
 * Day la ly do phai ghi audio theo tung message: cham phat am tu transcript text
 * la khong dang tin, vi ASR da "sua ho" nguoi hoc roi.
 */
async function gradeAudio(
  lesson: Lesson,
  messages: GradingMessage[]
): Promise<AudioGrade | null> {
  const model = process.env.GRADER_AUDIO_MODEL;
  if (!model) return null;

  const segments = messages
    .filter((m): m is GradingMessage & { audioPath: string } =>
      Boolean(m.role === 'user' && m.audioPath && (m.durationMs ?? 0) > 700)
    )
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, MAX_AUDIO_SEGMENTS)
    .sort((a, b) => a.seq - b.seq);

  if (segments.length === 0) return null;

  type AudioPart =
    | { type: 'text'; text: string }
    | { type: 'input_audio'; input_audio: { data: string; format: 'wav' } };

  // Tai song song va chiu loi TUNG file: mot doan hong thi bo doan do, khong
  // keo do ca khau cham phat am. Voi S3 chuyen nay thuc te hon so voi doc dia
  // — client co the da tat may giua chung khi dang day len.
  const loaded = await Promise.all(
    segments.map(async (seg) => {
      try {
        const buf = await readAudio(seg.audioStore, seg.audioPath);
        return { seq: seg.seq, base64: buf.toString('base64') };
      } catch (err) {
        console.warn(`[grader] bo qua audio seq=${seg.seq}:`, (err as Error).message);
        return null;
      }
    })
  );

  // Prompt dung sau khi tai xong: danh sach seq phai khop dung nhung clip that
  // su gui di, neu khong model se gan diem cho nham cau.
  const usable = loaded.filter((x): x is { seq: number; base64: string } => x !== null);
  if (usable.length === 0) return null;

  const content: AudioPart[] = [
    {
      type: 'text',
      text:
        `Assess the pronunciation of a Vietnamese learner of English at CEFR level ${lesson.level}. ` +
        `You will hear ${usable.length} short clips of the learner speaking, in order. ` +
        `Clip message_seq values are, in order: ${usable.map((s) => s.seq).join(', ')}.\n` +
        `For each clip, score 0-100 and list concrete pronunciation issues you actually hear ` +
        `(specific sounds, word stress, intonation, dropped final consonants). ` +
        `Common Vietnamese-speaker patterns to listen for: dropped final /s/ /z/ /t/ /d/, ` +
        `/θ/ and /ð/ substitutions, consonant clusters, flat sentence intonation.\n` +
        `Do not invent issues you cannot hear. "note_vi" is one or two sentences in Vietnamese.`,
    },
    ...usable.map(
      (seg): AudioPart => ({
        type: 'input_audio',
        input_audio: { data: seg.base64, format: 'wav' },
      })
    ),
  ];

  return callOpenAI({
    model,
    modalities: ['text'],
    messages: [{ role: 'user', content }],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'pronunciation_grade', strict: true, schema: AUDIO_SCHEMA },
    },
  });
}

/**
 * Cham ca buoi hoc. Phan audio va phan text chay song song va doc lap:
 * neu cham phat am hong thi van tra ve duoc summary text.
 */
export async function gradeSession({
  lesson,
  session,
  messages,
  progress,
}: {
  lesson: Lesson;
  session: SessionRow;
  messages: GradingMessage[];
  progress: ProgressRecord[];
}): Promise<Summary> {
  const learnerTurns = messages.filter((m) => m.role === 'user' && m.text?.trim());

  if (learnerTurns.length === 0) {
    return {
      overall: 0,
      grammar: 0,
      vocabulary: 0,
      fluency: 0,
      pronunciation: null,
      objectives: lesson.objectives.map((o) => ({ id: o.id, passed: false, evidence: '' })),
      mistakes: [],
      strengths: [],
      nextFocus: [],
      coachNoteVi: 'Buổi này chưa ghi nhận được câu nói nào của bạn. Thử lại và nói to hơn nhé!',
      hintCount: session.hint_count,
      turnCount: 0,
      warnings: ['no_learner_speech'],
    };
  }

  const warnings = [];
  const [textResult, audioResult] = await Promise.allSettled([
    gradeText(lesson, messages, progress),
    gradeAudio(lesson, messages),
  ]);

  if (textResult.status === 'rejected') {
    throw new Error(`Cham diem that bai: ${textResult.reason?.message ?? textResult.reason}`);
  }
  const text = textResult.value;

  let pronunciation: number | null = null;
  let pronunciationSegments: AudioGrade['segments'] = [];
  let pronunciationNoteVi: string | undefined;
  if (audioResult.status === 'fulfilled' && audioResult.value) {
    pronunciation = audioResult.value.pronunciation;
    pronunciationSegments = audioResult.value.segments;
    pronunciationNoteVi = audioResult.value.note_vi;
  } else if (audioResult.status === 'rejected') {
    warnings.push('pronunciation_grading_failed');
    console.warn('[grader] cham phat am that bai:', audioResult.reason?.message);
  }

  // Diem tong: phat am chiem 25% khi cham duoc, con lai chia deu.
  const overall =
    pronunciation === null
      ? Math.round((text.grammar + text.vocabulary + text.fluency) / 3)
      : Math.round(
          text.grammar * 0.25 + text.vocabulary * 0.25 + text.fluency * 0.25 + pronunciation * 0.25
        );

  return {
    overall,
    grammar: text.grammar,
    vocabulary: text.vocabulary,
    fluency: text.fluency,
    pronunciation,
    pronunciationSegments,
    pronunciationNoteVi,
    objectives: text.objectives,
    mistakes: text.mistakes,
    strengths: text.strengths,
    nextFocus: text.next_focus,
    coachNoteVi: text.coach_note_vi,
    hintCount: session.hint_count,
    turnCount: learnerTurns.length,
    warnings,
  };
}
