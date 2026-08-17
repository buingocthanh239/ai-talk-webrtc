/**
 * Cau hinh session gui kem ephemeral token cua OpenAI Realtime.
 *
 * Toan bo luat cua buoi hoc (instructions, tools, VAD, transcription) nam o
 * day chu khong o browser: client chi nhan duoc mot chuoi secret ngan han va
 * khong sua duoc luat cham diem hay luat goi tool.
 *
 * Tach thanh file rieng de test duoc mot cau hoi duy nhat ma khong phai dung
 * toi mang: **doi mode co lam roi mat thu gi khong dinh doi khong.**
 */

import { buildInstructions, buildTranscriptionPrompt } from './prompt.ts';
import type { ResumeContext } from './prompt.ts';
import { buildTools } from './tools.ts';
import type { RealtimeTool } from './tools.ts';
import { clampSpeed } from '../shared/speed.ts';
import { aiSpeaksItself } from '../shared/voice-mode.ts';
import type { Character, Lesson, ProgressRecord, VoiceMode } from '../shared/types.ts';

export interface SessionPayload {
  session: {
    type: 'realtime';
    model: string;
    instructions: string;
    output_modalities: ['text'] | ['audio'];
    audio: {
      input: {
        transcription: { model: string; language: string; prompt: string };
        turn_detection: null;
      };
      output?: { voice: string; speed: number };
    };
    tools: RealtimeTool[];
    tool_choice: 'auto';
  };
}

export interface SessionPayloadInput {
  model: string;
  lesson: Lesson;
  progress: ProgressRecord[];
  resume: ResumeContext | null;
  character: Character;
  voiceMode: VoiceMode;
  /** Toc do noi ban dau o mode `openai`. Hai mode TTS client bo qua — xem duoi. */
  speed: number;
}

export function buildSessionPayload({
  model,
  lesson,
  progress,
  resume,
  character,
  voiceMode,
  speed,
}: SessionPayloadInput): SessionPayload {
  const speaksItself = aiSpeaksItself(voiceMode);

  return {
    session: {
      type: 'realtime',
      model,
      instructions: buildInstructions(lesson, { progress, resume, character }),

      // Ba duong dua tieng AI ra loa, nguoi hoc chon luc bat dau bai:
      //
      //   'openai' — Realtime tu phat audio. Duoc ngu dieu that cua model.
      //   'google' — chi lay CHU ve, client tu goi Google Cloud TTS doc.
      //   'polly'  — nhu tren nhung Amazon Polly doc. Giu de lui ve duoc.
      //
      // MAC DINH LA MOT NHA TTS CLIENT, VA DO LA CHUYEN TIEN chu khong phai
      // chuyen ky thuat: cho OpenAI phat audio truc tiep lam tong hoa don gap
      // ~2,1 lan — audio out dat gap ~2,9 lan, va giong AI sinh ra con nam lai
      // trong context de bi doc lai o moi luot sau. Xem `docs/cost.md` muc 6
      // (con so o do tinh theo gia Polly, chua tinh lai theo gia Google).
      //
      // Ly do ban dau cua duong TTS client la khau hinh (Realtime khong phat ra
      // viseme/phoneme nao, con Polly tra thang speech marks). Ly do do da
      // het — avatar gio nhep fake tu bien do audio (`public/src/fake-mouth.ts`)
      // va khong can TTS noi gi ve am vi ca. Con lai dung mot ly do: tien.
      //
      // Google KHONG co gi tuong duong speech marks cua Polly, nen neu mot ngay
      // quay lai day phat am bang hinh mieng thi duong do khong con mo lai duoc
      // bang cach doi mode — do la chi phi chim cua viec doi nha.
      //
      // Push-to-talk nen mode nao cung khong mat gi ve ngat loi — khong co
      // barge-in de mat.
      output_modalities: speaksItself ? ['audio'] : ['text'],

      audio: {
        input: {
          // whisper-1 chu khong phai gpt-4o-transcribe: gpt-4o-transcribe la
          // model LLM, no rut gon va don dep loi hoc vien truoc khi tra chu ve
          // ("I want to order a cup of coffee. I like a cappuccino" -> "I wanna
          // order a coffee"). Voi app luyen noi thi do la mat du lieu: chinh cai
          // loi bi don di moi la thu can cham.
          //
          // Doi lai whisper bia dat tren doan ghi ngan, va `prompt` la thuoc
          // giai duy nhat o day — Realtime API khong nhan `temperature`.
          //
          // NHANH NAY KHONG PHU THUOC MODE. Ca hai mode deu can transcript cua
          // hoc vien: no la bong bong chu tren man hinh va la dau vao cham
          // phat am. Mode chi doi duong tieng AI DI RA.
          transcription: {
            model: 'whisper-1',
            language: 'en',
            prompt: buildTranscriptionPrompt(lesson),
          },
          // Push-to-talk: tat VAD hoan toan. Server khong doan luot noi va
          // khong tu tao response nua — client la noi duy nhat chot mot luot,
          // bang input_audio_buffer.commit + response.create gui tay khi user
          // tha nut. Bat VAD lai la AI se tu noi khi nghe thay tieng vong loa.
          turn_detection: null,
        },
        // Hai mode TTS client: khong co nhanh `output` — giong va toc do thuoc
        // ve nha TTS, va toc do la `playbackRate` cua the <audio> nen doi duoc
        // GIUA CHUNG mot cau.
        //
        // Mode 'openai': toc do la cau hinh session, nen doi duoc nhung chi an
        // TU LUOT SAU. Client van gui `session.update` khi keo slider — xem
        // `public/src/session.ts::#applyRate`.
        ...(speaksItself
          ? { output: { voice: character.openaiVoice, speed: clampSpeed(speed) } }
          : {}),
      },

      tools: buildTools(lesson),
      tool_choice: 'auto',
    },
  };
}
