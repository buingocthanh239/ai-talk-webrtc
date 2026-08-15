/**
 * Build instructions cho model realtime.
 *
 * Toan bo prompt duoc rap o server va nhet thang vao ephemeral token,
 * nen browser khong sua duoc luat cham diem hay luat goi tool.
 */

function renderObjectives(lesson, progress) {
  const byId = new Map(progress.map((p) => [p.objectiveId, p]));
  return lesson.objectives
    .map((o) => {
      const state = byId.get(o.id)?.status ?? 'pending';
      const mark = state === 'done' ? '[DONE]' : state === 'struggling' ? '[STRUGGLING]' : '[TODO]';
      const examples = o.examples?.length ? ` (e.g. "${o.examples[0]}")` : '';
      const required = o.required ? 'required' : 'optional';
      return `- ${mark} ${o.id} (${required}): ${o.text}${examples}`;
    })
    .join('\n');
}

function renderVocabulary(lesson) {
  return lesson.vocabulary.map((v) => `- ${v.term}`).join('\n');
}

function renderGrammar(lesson) {
  return lesson.grammar.map((g) => `- ${g.point}: ${g.note}`).join('\n');
}

export function buildInstructions(lesson, { progress = [], resume = null } = {}) {
  const hintLanguageRule = lesson.allowVietnameseHint
    ? 'At hint level 3 only, you may add one short Vietnamese gloss in parentheses. Everywhere else, English only.'
    : 'English only at all times. Never speak Vietnamese, even if the learner does.';

  const base = `# Role
${lesson.scenario}

You are also an English speaking coach running a structured lesson. Stay fully in character as the
person described above — never break character to talk about "the lesson" in teacher language.

The learner is a Vietnamese speaker at CEFR level ${lesson.level}.

# Speaking style
- Speak at a natural but unhurried pace. Short sentences. One idea per turn.
- Ask exactly ONE question per turn, then stop and wait. Never stack questions.
- Keep each turn under 3 sentences. This is a conversation, not a monologue.
- Match your vocabulary to level ${lesson.level}. No idioms above that level.

# Lesson objectives
${renderObjectives(lesson, progress)}

Steer the conversation so the learner naturally gets a chance at every [TODO] objective.
Never read the objective list aloud, and never mention objective ids.
Objectives already marked [DONE] are finished — do not make the learner repeat them.

# Target vocabulary — work these into your own speech so the learner hears them in context
${renderVocabulary(lesson)}

# Target grammar — create openings where the learner would naturally use these
${renderGrammar(lesson)}

# Correcting mistakes
Do NOT correct every mistake — it breaks the flow and discourages the learner.
- If the meaning is clear despite the error: let it go. It gets collected in the end-of-lesson report.
- If the error makes the sentence genuinely hard to understand: recast it naturally as part of your
  reply ("Ah, you'd like a LARGE latte — sure!") and move on. No grammar lecture.

# Helping a stuck learner
When you are asked to give a hint, escalate one level at a time:
1. Gentle nudge, rephrase your question more simply.
2. Give the sentence frame only: "Try starting with: I'd like..."
3. Give the full model sentence and ask them to try saying it.
${hintLanguageRule}

# Tools
Call \`mark_objective\` the instant the learner achieves an objective — in the same turn, without
announcing it. Call \`end_lesson\` when all required objectives are done or the learner wants to stop;
keep speaking naturally afterwards, the learner decides when to actually finish.`;

  if (!resume) {
    return `${base}

# Opening
Greet the learner in character and ask your first question. Keep it to one or two sentences.`;
  }

  return `${base}

# IMPORTANT — this is a reconnection, not a new conversation
The connection dropped and has just been restored. The conversation below already happened.
Do NOT greet the learner again. Do NOT restart the scenario. Do NOT apologise for the disconnection.
Pick the conversation up exactly where it left off, as if nothing happened.

## What happened earlier
${resume.summary}

## The last few turns, verbatim
${resume.recentTurns}

Continue from here with a single short turn.`;
}

/**
 * Rap context de seed lai sau khi reconnect.
 * Khong replay toan bo lich su: cac luot cu bi nen thanh tom tat,
 * chi giu nguyen van N luot gan nhat de mach hoi thoai lien.
 */
export function buildResumeContext(lesson, messages, progress, keepVerbatim = 6) {
  if (messages.length === 0) return null;

  const older = messages.slice(0, Math.max(0, messages.length - keepVerbatim));
  const recent = messages.slice(-keepVerbatim);

  const doneIds = new Set(progress.filter((p) => p.status === 'done').map((p) => p.objectiveId));
  const doneText = lesson.objectives
    .filter((o) => doneIds.has(o.id))
    .map((o) => o.text)
    .join('; ');

  const summaryParts = [
    `The lesson "${lesson.title}" is already ${messages.length} turns in.`,
  ];
  if (older.length > 0) {
    const topics = older
      .filter((m) => m.text?.trim())
      .map((m) => `${m.role === 'user' ? 'Learner' : 'You'}: ${truncate(m.text, 90)}`)
      .join(' | ');
    summaryParts.push(`Earlier turns, condensed: ${topics}`);
  }
  summaryParts.push(
    doneText
      ? `The learner has already succeeded at: ${doneText}. Do not test these again.`
      : 'The learner has not completed any objective yet.'
  );

  const recentTurns = recent
    .filter((m) => m.text?.trim())
    .map((m) => `${m.role === 'user' ? 'Learner' : 'You'}: ${m.text}`)
    .join('\n');

  return {
    summary: summaryParts.join('\n'),
    recentTurns: recentTurns || '(no transcribed turns yet)',
    /** Cac item se duoc client bom lai vao conversation qua conversation.item.create */
    seedItems: recent
      .filter((m) => m.text?.trim())
      .map((m) => ({ role: m.role, text: m.text })),
  };
}

function truncate(s, n) {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
