# AI Learn — luyện nói tiếng Anh với AI qua WebRTC

Demo luồng học nói tiếng Anh thời gian thực bằng **OpenAI Realtime API over WebRTC**.
Zero dependency — chỉ dùng core module của Node (`node:http`, `node:sqlite`), không cần `npm install`.

## Chạy

```bash
cp .env.example .env      # rồi điền OPENAI_API_KEY
npm start                 # http://localhost:3000
```

Yêu cầu Node >= 22.5 (đang test trên v24). Mở bằng Chrome/Edge/Safari — cần cấp quyền micro.
`localhost` được coi là secure origin nên không cần HTTPS khi chạy máy local.

## Năm luồng chính

### 1. Truyền thông tin bài học

Bài học là JSON trong `server/lessons/*.json`: mục tiêu, từ vựng, ngữ pháp, kịch bản, `minTurns`.
`server/prompt.js` rap thành `instructions` và **nhét thẳng vào ephemeral token** lúc mint
(`server/index.js` → `mintClientSecret`). Browser chỉ nhận về một chuỗi secret ngắn hạn, nên
không sửa được luật bài học hay luật chấm điểm. API key thật không bao giờ rời server.

### 2. Điểm dừng

Ba lớp, cố ý không giao hết cho model:

| Lớp | Ở đâu | Làm gì |
|---|---|---|
| Model | `server/tools.js` | Gọi tool `mark_objective` ngay khi user đạt mục tiêu, kèm câu nói làm bằng chứng |
| Client | `session.js` → `#maybeOfferFinish` | Giữ checklist thật, model chỉ *đề xuất* |
| Rule | cùng chỗ | Đủ mục tiêu `required` **và** đủ `minTurns` → mở nút "Kết thúc" |

Model có thêm tool `end_lesson` để chủ động xin dừng, nhưng nó chỉ bật nút — user mới là người bấm.

### 3. Summary & chấm điểm

Chạy sau khi đã ngắt WebRTC, ở server (`server/grader.js`), không dùng model realtime:

- **Grammar / vocabulary / fluency / mục tiêu** → model text đọc transcript, structured output JSON.
- **Phát âm** → gửi thẳng các file WAV của user cho model audio. Chấm phát âm từ transcript text
  là không đáng tin, vì ASR đã "sửa hộ" người học rồi.

Hai phần chạy song song bằng `Promise.allSettled` — chấm phát âm hỏng thì vẫn có summary text.
Mỗi lỗi gắn `message_seq` nên ở màn tổng kết bấm vào lỗi là nghe lại đúng câu đó.

### 4. Lưu trữ & tái sử dụng

**Ghi âm:** hai `AudioWorklet` chạy song song (mic + track của AI), ghi PCM 16kHz liên tục vào buffer
(`public/js/recorder.js`). Không dùng `MediaRecorder.start()/stop()` theo từng lượt vì recorder khởi
động chậm hơn tiếng nói ~100–200ms nên luôn cụt đầu câu. Việc cắt thành từng message làm sau, bằng
timestamp lấy từ event realtime:

- User: `input_audio_buffer.speech_started` → `speech_stopped`
- AI: `response.created` → dò im lặng sau `response.done` (audio còn đang phát nốt qua WebRTC)

Cắt xong upload ngay từng đoạn, không đợi cuối buổi — crash giữa chừng vẫn còn dữ liệu.

**DB** (`data/app.db`, SQLite): `session` / `message` / `progress`. File WAV nằm ở
`data/audio/<sessionId>/<seq>-<role>.wav`.

**Học lại:** buổi đã lưu chính là content — nghe lại cả buổi, nghe lại riêng câu sai, hoặc nạp
buổi cũ làm ngữ cảnh cho buổi mới.

### 5. Reconnect

Trạng thái bài học nằm ở server, WebRTC chỉ là đường truyền. Mất kết nối thì chỉ mất đường truyền.

```
LIVE ──(connectionState = failed/disconnected)──► RECONNECTING
                                                       │
                        backoff 0.8s, 2s, 4s, 8s, 15s  │
                                                       ▼
  token mới (resume=true) → PC mới → seed lại hội thoại → LIVE
```

Khi resume **không replay toàn bộ lịch sử** (tốn token, và session realtime có giới hạn thời lượng).
`server/prompt.js` → `buildResumeContext` nén các lượt cũ thành tóm tắt nhét vào instructions, còn
6 lượt gần nhất được bơm lại nguyên văn qua `conversation.item.create`. Kèm theo trạng thái progress
để AI không bắt user làm lại mục tiêu đã đạt. Rồi `response.create` với chỉ thị "đừng chào lại".

Audio của message cũ không nạp lại được vào session mới — chỉ nạp text. Không sao, audio cũ vẫn nằm
nguyên trong DB để phát lại.

## Lớp gợi ý

Hai kênh cho hai tình huống khác nhau:

- **Chip trên màn hình** — sau mỗi lượt AI nói, client xin 2 mẫu câu bằng *out-of-band response*
  (`conversation: 'none'`): model vẫn đọc được ngữ cảnh nhưng không chèn thêm lượt nói nào.
- **Gợi ý bằng giọng** — user im quá 6 giây (hoặc bấm nút 💡) thì AI nhắc miệng, leo thang 3 nấc:
  gợi nhẹ → cho khung câu → cho nguyên câu. Số lần dùng gợi ý được đếm và hiển thị ở tổng kết.

## Cấu trúc

```
server/
  index.js      HTTP + routing, mint ephemeral token
  db.js         SQLite schema + query
  prompt.js     rap instructions, nén ngữ cảnh khi reconnect
  tools.js      định nghĩa tool cho model
  grader.js     chấm điểm sau buổi (text + audio)
  lessons/      bài học dạng JSON
public/
  index.html    3 màn: chọn bài / đang học / tổng kết
  js/realtime.js   transport WebRTC thuần
  js/recorder.js   ghi PCM liên tục + cắt WAV theo message
  js/session.js    điều phối buổi học, reconnect, gợi ý, điểm dừng
  js/main.js       DOM
data/           app.db + audio/ (tự tạo, đã gitignore)
```

## Cấu hình

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `OPENAI_API_KEY` | — | bắt buộc |
| `REALTIME_MODEL` | `gpt-realtime` | model hội thoại |
| `REALTIME_VOICE` | `marin` | giọng AI |
| `GRADER_TEXT_MODEL` | `gpt-4o` | chấm grammar/vocab/mục tiêu |
| `GRADER_AUDIO_MODEL` | `gpt-4o-audio-preview` | để trống = tắt chấm phát âm |

Thêm bài học mới: bỏ một file JSON vào `server/lessons/` rồi restart. Không cần sửa code.
