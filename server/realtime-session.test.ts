/**
 *   node --test server/realtime-session.test.ts
 *
 * Cau hoi cua bo test nay: mode co doi dung MOT thu — duong dua tieng noi ra
 * loa — va khong doi thu gi khac khong.
 *
 * Cai de hong nhat la transcription. No khong lien quan gi den giong AI, nhung
 * no nam ngay canh trong cung mot object `audio`, nen mot lan sua tay o mode
 * `openai` la du de mat transcript hoc vien — tuc la mat ca bong bong chu lan
 * phan cham phat am, ma tieng AI van keu binh thuong nen khong ai thay ngay.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionPayload } from './realtime-session.ts';
import type { Character, Lesson } from '../shared/types.ts';

const LESSON: Lesson = {
  id: 'cafe',
  title: 'Goi ca phe',
  level: 'A2',
  estimatedMinutes: 5,
  scenario: 'Learner orders a coffee at a cafe.',
  allowVietnameseHint: true,
  minTurns: 4,
  speed: 1,
  objectives: [{ id: 'greet', text: 'Greet the barista', required: true, examples: ['Hi there'] }],
  vocabulary: [{ term: 'cappuccino', meaning: 'ca phe sua bot' }],
  grammar: [{ point: "I'd like", note: 'polite request' }],
};

const CHARACTER: Character = {
  code: 'tina',
  name: 'TINA',
  sort: 3,
  tier: 'paid',
  gender: 'female',
  tags: ['Cheerful'],
  personality: 'Hyper-enthusiastic.',
  voiceStyle: 'Cheerful and encouraging.',
  greetingStyle: '',
  speed: 1,
  voice: { voiceId: 'Ruth', engine: 'neural' },
  openaiVoice: 'coral',
  avatar: null,
};

const ALL_MODES = ['openai', 'polly'] as const;

const build = (voiceMode: (typeof ALL_MODES)[number], speed = 1) =>
  buildSessionPayload({
    model: 'gpt-realtime',
    lesson: LESSON,
    progress: [],
    resume: null,
    character: CHARACTER,
    voiceMode,
    speed,
  }).session;

test('mode polly: OpenAI chi tra ve chu, khong cau hinh giong nao', () => {
  const session = build('polly');
  assert.deepEqual(session.output_modalities, ['text']);
  assert.equal(session.audio.output, undefined);
});

test('mode openai: OpenAI tu phat audio bang giong cua nhan vat', () => {
  const session = build('openai');
  assert.deepEqual(session.output_modalities, ['audio']);
  assert.equal(session.audio.output?.voice, 'coral');
});

test('mode openai lay openaiVoice chu khong phai voiceId cua Polly', () => {
  // `Ruth` la giong Polly. Gui no sang Realtime API la 400.
  assert.notEqual(build('openai').audio.output?.voice, CHARACTER.voice.voiceId);
});

test('toc do bi kep vao gioi han cua Realtime API', () => {
  assert.equal(build('openai', 9).audio.output?.speed, 1.5);
  assert.equal(build('openai', 0).audio.output?.speed, 0.25);
  assert.equal(build('openai', 0.8).audio.output?.speed, 0.8);
});

test('MOI mode giu nguyen transcription cua hoc vien', () => {
  for (const mode of ALL_MODES) {
    const input = build(mode).audio.input;
    assert.equal(input.transcription.model, 'whisper-1', mode);
    assert.equal(input.transcription.language, 'en', mode);
    assert.ok(input.transcription.prompt.length > 0, `${mode}: thieu prompt chong bia`);
  }
});

test('MOI mode giu push-to-talk: khong co VAD nao tu chot luot noi', () => {
  for (const mode of ALL_MODES) {
    assert.equal(build(mode).audio.input.turn_detection, null, mode);
  }
});

test('MOI mode giu nguyen tinh cach nhan vat va bo tool', () => {
  for (const mode of ALL_MODES) {
    const session = build(mode);
    assert.ok(session.instructions.includes('TINA'), `${mode}: mat nhan vat`);
    assert.ok(
      session.tools.some((t) => t.name === 'mark_objective'),
      `${mode}: mat tool`
    );
  }
});
