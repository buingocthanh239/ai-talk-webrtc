/**
 * Tool duoc cap cho model realtime.
 *
 * Nguyen tac: model chi *de xuat*, client moi la noi chot trang thai.
 * Vi vay khong co tool nao tu dong ket thuc buoi hoc — end_lesson chi
 * bat nut "Ket thuc" tren UI cho user bam.
 */
export function buildTools(lesson) {
  const objectiveIds = lesson.objectives.map((o) => o.id);

  return [
    {
      type: 'function',
      name: 'mark_objective',
      description:
        'Call this the moment the learner demonstrably achieves one of the lesson objectives. ' +
        'Call it as soon as it happens, in the same turn — do not wait until the end of the lesson. ' +
        'Also call it with status "struggling" when the learner has clearly tried and failed twice.',
      parameters: {
        type: 'object',
        properties: {
          objective_id: {
            type: 'string',
            enum: objectiveIds,
            description: 'Which lesson objective this refers to.',
          },
          status: {
            type: 'string',
            enum: ['done', 'struggling'],
          },
          evidence: {
            type: 'string',
            description:
              "The learner's exact words that prove it, quoted verbatim. Keep under 120 characters.",
          },
        },
        required: ['objective_id', 'status', 'evidence'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'end_lesson',
      description:
        'Call this when the lesson should wrap up: all required objectives are done, or the learner ' +
        'explicitly asks to stop. This does NOT end the session by itself — it only offers the learner ' +
        'a "finish lesson" button. Keep talking naturally after calling it.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            enum: ['objectives_complete', 'learner_requested', 'learner_struggling'],
          },
          closing_note: {
            type: 'string',
            description: 'One short encouraging sentence to show the learner on screen.',
          },
        },
        required: ['reason', 'closing_note'],
        additionalProperties: false,
      },
    },
  ];
}
