# AI Learn — luyện nói tiếng Anh với AI qua WebRTC

Demo luồng học nói tiếng Anh thời gian thực bằng **OpenAI Realtime API over WebRTC**.

**Backend zero dependency** — chỉ dùng core module của Node (`node:http`, `node:sqlite`, `node:crypto`).
Ký SigV4 cho S3 và Polly, ký CloudFront đều viết tay, không kéo AWS SDK về.

Client có đúng **một** runtime dependency: `@esotericsoftware/spine-webgl` cho avatar 2D nhép mồm
theo lời AI. Nó nằm ở chunk riêng, chỉ tải khi nhân vật có asset — `bundle.js` vẫn ~80KB.

## Chạy

```bash
cp .env.example .env      # rồi điền OPENAI_API_KEY
npm install               # esbuild + spine-webgl
npm start                 # http://localhost:3000
```

Yêu cầu Node >= 22.5 (đang test trên v24). Mở bằng Chrome/Edge/Safari — cần cấp quyền micro.
`localhost` được coi là secure origin nên không cần HTTPS khi chạy máy local.

## Năm luồng chính

### 1. Truyền thông tin bài học

Bài học là JSON trong `server/lessons/*.json`: mục tiêu, từ vựng, ngữ pháp, kịch bản, `minTurns`,
`speed`.
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

**Chúc mừng hoàn thành.** Khi đủ điều kiện thật, một thẻ nổi mời người học bấm Kết thúc để nhận đánh
giá. Ba ràng buộc, mỗi cái chặn một kiểu hiển thị sai:

| Ràng buộc | Chặn gì |
|---|---|
| Chỉ `reason = objectives_complete` | Chúc mừng người vừa xin dừng vì đuối (`learner_struggling`) |
| `end_lesson` vẫn phải qua `#finishConditionsMet()` | Model quên gọi `mark_objective` → thẻ ghi "hoàn thành" ngay trên dòng "Đủ 2/3 mục tiêu" |
| Chốt `#congratulated`, cả buổi một lần | `#maybeOfferFinish()` chạy sau **mỗi** `mark_objective` nên nó bắn lại ở mọi lượt sau đó |

Thẻ **không tự tắt** — nó là lời mời bấm nút chứ không phải thông báo thoáng qua — và **không chặn
màn hình**, vì lúc nó bật thì AI vẫn đang nói nốt câu của nó. Đóng thẻ rồi học tiếp thì nút "Kết
thúc bài học" vẫn được làm nổi.

**Xem model gọi tool nào:** mở DevTools console, `#onToolCall` in ra `[tool] <tên> {tham số}`. Đây
là dấu vết duy nhất cho `end_lesson` — khác `mark_objective`, nó không chạm server và không ghi DB.

### 3. Summary & chấm điểm

Chạy sau khi đã ngắt WebRTC, ở server (`server/grader.js`), không dùng model realtime:

- **Grammar / vocabulary / fluency / mục tiêu** → model text đọc transcript, structured output JSON.
- **Phát âm** → gửi thẳng các file WAV của user cho model audio. Chấm phát âm từ transcript text
  là không đáng tin, vì ASR đã "sửa hộ" người học rồi.

Hai phần chạy song song bằng `Promise.allSettled` — chấm phát âm hỏng thì vẫn có summary text.
Mỗi lỗi gắn `message_seq` nên ở màn tổng kết bấm vào lỗi là nghe lại đúng câu đó.

### 4. Lưu trữ & tái sử dụng

**Ghi âm:** một `AudioWorklet` trên micro, ghi PCM 16kHz liên tục vào ring buffer
(`public/src/recorder.ts`). Không dùng `MediaRecorder.start()/stop()` theo từng lượt vì recorder
khởi động chậm hơn tiếng nói ~100–200ms nên luôn cụt đầu câu. Việc cắt thành từng message làm sau,
bằng timestamp mốc lúc người học nhấn và thả nút giữ-để-nói.

**Chỉ ghi tiếng của người học.** Câu của AI không được ghi: nó do Polly đọc từ text, mà text thì đã
nằm trong DB — nghe lại thì đọc lại. Bật công tắc "Lưu giọng AI" thì mp3 của Polly được đẩy lên S3
như một file bình thường.

Cắt xong upload ngay từng đoạn, không đợi cuối buổi — crash giữa chừng vẫn còn dữ liệu.

**DB** (`data/app.db`, SQLite): `session` / `message` / `progress`. Mỗi message ghi kèm
`audio_store` (`disk` | `s3`) nên hai kiểu lưu sống chung được — bật S3 giữa chừng thì các buổi cũ
vẫn nghe lại bình thường.

**Nơi để file WAV**, chọn bằng `AUDIO_STORE`:

| | `disk` (mặc định) | `s3` |
|---|---|---|
| Đường đi | WAV đi xuyên qua backend | client `POST` thẳng lên bucket |
| Chỗ nằm | `data/audio/<sessionId>/<seq>-<role>.wav` | `audio/<sessionId>/<seq>-<role>.wav` |
| Backend nhận | cả file | chỉ metadata `{key, bytes, durationMs}` |

Ở chế độ `s3`, server cấp **một** presigned POST policy cho cả buổi lúc mint token
(`starts-with $key → audio/<sessionId>/`, `content-length-range 45..5MB`, hạn 2h). Client tự đặt tên
file cho từng lượt nói nên **không phải xin URL trước mỗi câu** — số request tới backend không đổi so
với trước, chỉ có byte audio là biến mất khỏi Node. Policy ràng theo prefix nên một client sửa vài
dòng cũng không ghi lấn được sang buổi của người khác; server còn dựng lại key từ
`(sessionId, seq, role)` để đối chiếu chứ không tin key client gửi.

Ký SigV4 và ký CloudFront đều viết tay bằng `node:crypto` (`server/s3.ts`, `server/cdn.ts`) — kéo cả
AWS SDK về chỉ để làm hai việc này là không đáng với một dự án không có dependency nào.

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

Audio của message cũ không nạp lại được vào session mới — chỉ nạp text. Không sao: đoạn ghi của
người học vẫn nằm nguyên trong DB, còn câu của AI thì đọc lại được từ text bất cứ lúc nào.

## Tốc độ nói của AI

Bài học đặt mặc định (`"speed": 0.85` trong lesson JSON), người học kéo slider đè lên được; lựa chọn
được nhớ trong `localStorage` và áp dụng cho mọi bài sau đó.

Tốc độ là `playbackRate` của thẻ `<audio>` đang phát mp3 của Polly, với `preservesPitch` nên chậm
0.5× vẫn đúng cao độ. **Đổi được ngay cả giữa chừng một câu**, và khẩu hình tự bám theo vì
`VisemePlayer` đọc `audio.currentTime`.

Trước đây đây là `session.update` của Realtime API, vốn chỉ nhận giữa các lượt — nên slider phải
khoá lúc AI đang nói và thay đổi bị xếp hàng chờ. Cả cơ chế đó đã bỏ.

**Điều dễ hiểu nhầm: đây là hậu kỳ trên audio đã sinh, không phải model nói chậm lại.** Nó không
làm AI chọn từ dễ hơn hay ngắt nghỉ nhiều hơn — muốn vậy thì phải viết vào `instructions`
(`server/prompt.ts`). Nói chậm mà câu vẫn phức tạp thì gần như không giúp được người mới học.

## Tiếng nói của AI trong hội thoại (Polly, gọi thẳng từ client)

Session Realtime chạy `output_modalities: ["text"]` — **OpenAI chỉ nghe và trả về chữ.** Client gom
chữ thành từng khúc, tự ký SigV4 và gọi thẳng Amazon Polly lấy mp3 kèm viseme, rồi tự phát.

```
response.output_text.delta
  → SentenceChunker           khúc đầu 15–40 ký tự, khúc sau tới 200
  → Polly SynthesizeSpeech ×2  (client tự ký, không qua backend)
  → <audio src=blob:> + VisemePlayer → avatar Spine nhép ngay trong hội thoại
```

**Vì sao đổi.** Realtime API không phát ra viseme/phoneme nào, nên chừng nào tiếng nói còn đến từ
nó thì avatar chỉ có thể đoán từ phổ âm thanh — đúng nhịp, sai âm vị. Với app dạy phát âm thì nhép
sai là dạy sai. Cho model trả text rồi tự đọc thì viseme lại chính xác theo định nghĩa.

Lý do từng loại phương án này (*"mất cơ chế ngắt lời tự nhiên"*) **sai ngay từ đầu**: app đã chạy
`turn_detection: null` + push-to-talk, không có barge-in nào để mất.

**Vì sao client gọi thẳng chứ không qua backend.** Toàn bộ độ trễ người học cảm thấy nằm ở khúc đầu
tiên của mỗi lượt — các khúc sau được đọc trong lúc khúc trước đang phát nên không lộ ra. Một vòng
round trip qua backend nằm đúng trên đường nóng đó, và cắt khúc càng nhỏ thì càng tốn nhiều vòng.

Backend chỉ `AssumeRole` một lần cho cả buổi rồi đưa credential tạm cho client:

- session policy chỉ cho `polly:SynthesizeSpeech`, ràng vào **IP của chính client**
  (`aws:SourceIp`) và có `DateLessThan` cứng
- `DateLessThan` cắt được hạn xuống dưới sàn 900 giây của `AssumeRole`
- đổi Wi-Fi ↔ 4G là 403 → client xin lại qua `POST /api/sessions/:id/polly`

**Đổi lại được gì trong code:** bỏ audio output của Realtime cũng xoá luôn `TrackRecorder` cho
remote track, vòng dò im lặng 300ms/12s để *đoán* khi nào AI nói xong, và trần an toàn đi kèm.
"AI nói xong" giờ là sự kiện chắc chắn: hàng đợi đọc cạn. Tốc độ đọc là `playbackRate` của thẻ
`<audio>` (có `preservesPitch`) nên đổi được **giữa chừng một câu** — `session.update` của Realtime
API chỉ cho đổi giữa các lượt.

**Cái mất, có ý thức:** prosody của giọng Realtime. Polly neural phẳng hơn rõ.

**Ba chỗ chưa ai chạy thử** (đã quyết định bỏ spike để đi nhanh — xem
[spec](docs/superpowers/specs/2026-08-16-client-side-tts-viseme-design.md) mục 6):

- Polly có trả CORS header cho preflight `OPTIONS` không. Không có đường lùi qua backend
- Chữ ký SigV4 chưa từng được AWS chấp nhận thật — hỏng thì hỏng cả hai màn
- `crypto.subtle` chỉ có trong secure context: `http://localhost` được, `http://192.168.x.x`
  **không** — mở trên điện thoại cùng LAN sẽ thấy nó `undefined` chứ không phải lỗi chữ ký

## Lớp gợi ý

Hai kênh cho hai tình huống khác nhau:

- **Chip trên màn hình** — sau mỗi lượt AI nói, client xin 2 mẫu câu bằng *out-of-band response*
  (`conversation: 'none'`): model vẫn đọc được ngữ cảnh nhưng không chèn thêm lượt nói nào.
- **Gợi ý bằng giọng** — user im quá 6 giây (hoặc bấm nút 💡) thì AI nhắc miệng, leo thang 3 nấc:
  gợi nhẹ → cho khung câu → cho nguyên câu. Số lần dùng gợi ý được đếm và hiển thị ở tổng kết.

## Cấu trúc

```
server/
  index.ts      HTTP + routing, mint ephemeral token
  db.ts         SQLite schema + query
  prompt.ts     rap instructions, nén ngữ cảnh khi reconnect
  tools.ts      định nghĩa tool cho model
  grader.ts     chấm điểm sau buổi (text + audio)
  s3.ts         ký SigV4 + presigned POST/GET
  cdn.ts        ký CloudFront
  polly.ts      đọc cấu hình Polly (giọng/engine/region) — KHÔNG gọi Polly
  sts.ts        AssumeRole → credential tạm cho client gọi Polly
  lessons/      bài học dạng JSON
  characters/   nhân vật AI dạng JSON
shared/         kiểu + logic dùng chung hai phía
  types.ts      hình dạng JSON qua ranh giới HTTP
  speed.ts      chặn tốc độ nói
  chunk.ts      cắt dòng text của AI thành khúc gửi lên Polly
  viseme.ts     map Polly → 22 viseme ID của rig, đọc speech marks, gợi ý VI
public/
  index.html    3 màn: chọn bài / đang học / tổng kết
  src/realtime.ts      transport WebRTC thuần
  src/recorder.ts      ghi PCM liên tục + cắt WAV theo message (chỉ mic)
  src/session.ts       điều phối buổi học, reconnect, gợi ý, điểm dừng
  src/polly-client.ts  ký SigV4 bằng WebCrypto, gọi thẳng Polly
  src/speech-queue.ts  cắt khúc → đọc trước → phát đúng thứ tự
  src/main.ts          DOM
  src/talk-avatar.ts   avatar + 22 thanh đo viseme (nạp bằng dynamic import)
  src/viseme-player.ts timeline → khẩu hình đang mở + trọng số
  src/avatar.ts        Spine WebGL, 2 track (Idle / miệng)
character/      asset Spine: <Tên>.skel / .atlas.txt / .png
data/           app.db + audio/ (tự tạo, đã gitignore)
```

Client build bằng esbuild có **code splitting**: `talk-avatar.ts` được nạp bằng dynamic import nên
runtime Spine rơi vào chunk riêng, không nằm trong `bundle.js`.

## Nhân vật

Bốn nhân vật, mỗi cái một file JSON trong `server/characters/` — cùng lối với bài học. `GET
/api/characters` trả cả danh sách, người học chọn ở trang chủ, lựa chọn nhớ trong `localStorage`.

| | Giọng Polly | Tier | Nét |
|---|---|---|---|
| LEO *(mặc định)* | Joanna | free | nhiệt tình, kiên nhẫn; đọc nhanh hơn 1.05× |
| MARCO | Matthew | free | ấm, kể chuyện |
| PROF | Brian *(Anh-Anh)* | free | nghiêm, chính xác |
| TINA | Ruth | paid | tưng bừng, Gen Z |

**Nhân vật đổi cả cách AI nói chuyện, không chỉ đổi giọng.** `personality` / `voiceStyle` /
`greetingStyle` được nhét vào đầu `instructions` (`server/prompt.ts`), **trước** kịch bản bài học —
đảo thứ tự thì model bám kịch bản và bỏ qua tính cách.

`speed` cấp nhân vật là **hệ số nền**, nhân với slider của người học: Leo 1.05 × slider 0.8 = 0.84.

**`tier: paid` chặn ở server** (402 lúc tạo session), không phải ẩn nút ở client — nút ẩn thì một
request gửi tay vẫn mở được.

**Không có ô chọn giọng riêng.** Giọng thuộc về nhân vật; một ô chọn giọng toàn cục sẽ đè lên cả
bốn, tức là xoá sạch cái khiến chúng khác nhau. Đổi giọng một nhân vật = sửa file JSON của nó.

**Avatar là Spine 2D**, asset nằm ở `character/<Tên>/`. Mỗi skeleton có 22 animation `viseme_0…21`
(bộ viseme của Azure). Polly chỉ chạm được 17/22 — xem [`docs/lip-sync.md`](docs/lip-sync.md) mục 4.

## Cấu hình

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `OPENAI_API_KEY` | — | bắt buộc |
| `REALTIME_MODEL` | `gpt-realtime` | model hội thoại |
| `GRADER_TEXT_MODEL` | `gpt-4o` | chấm grammar/vocab/mục tiêu |
| `GRADER_AUDIO_MODEL` | `gpt-4o-audio-preview` | để trống = tắt chấm phát âm |
| `PORT` | `3000` | |
| `DAILY_QUOTA_MS` | `300000` | thời lượng gọi miễn phí mỗi thiết bị mỗi ngày (5 phút) |
| `QUOTA_TZ_OFFSET_MS` | `25200000` | mốc reset hạn mức, lệch so với UTC (GMT+7) |
| `AUDIO_STORE` | `disk` | `s3` = client đẩy thẳng lên bucket |
| `S3_REGION` / `S3_BUCKET` | — | bắt buộc khi `AUDIO_STORE=s3` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | nt. Dùng chung cho S3, Polly và STS |
| `AWS_SESSION_TOKEN` | — | chỉ khi chạy bằng credential tạm (IAM role trên EC2/ECS) |
| `S3_ENDPOINT` | — | chỉ khi dev với MinIO; có giá trị = dùng path-style URL |
| `CDN_DOMAIN` | — | để trống thì phát lại bằng presigned GET |
| `CF_KEY_PAIR_ID` | — | bắt buộc khi có `CDN_DOMAIN` |
| `CF_PRIVATE_KEY` / `CF_PRIVATE_KEY_PATH` | — | đặt **một** trong hai; `CF_PRIVATE_KEY` được ưu tiên |
| `POLLY` | `off` | `on` = AI có tiếng nói. Tắt thì AI chỉ hiện chữ |
| `POLLY_REGION` | theo `S3_REGION` | bucket và Polly không bắt buộc cùng vùng |
| `POLLY_VOICE` | `Joanna` | chỉ là phương án cuối; giọng thật lấy từ file nhân vật |
| `POLLY_ENGINE` | `neural` | `standard` \| `neural` \| `long-form`. **Không** dùng được `generative` |
| `POLLY_STS_ROLE_ARN` | — | để trống = AI **không nói được** trong hội thoại (vẫn hiện chữ). Role chỉ nên cho `polly:SynthesizeSpeech` |
| `POLLY_STS_TTL_SEC` | `3600` | hạn credential tạm; AWS chặn trong 900..3600 |
| `POLLY_STS_BIND_IP` | `on` | ràng credential vào IP client. Tắt khi sau reverse proxy không đặt `X-Forwarded-For` |

Polly dùng chung `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` với S3 — cùng một tài khoản AWS,
không bắt khai hai lần.

Thiếu biến bắt buộc thì server ngã ra ngay lúc khởi động, không đợi tới lúc người học nói xong câu
đầu tiên mới phát hiện không lưu được audio.

Thêm bài học mới: bỏ một file JSON vào `server/lessons/` rồi restart. Nhân vật cũng vậy —
`server/characters/`. Không cần sửa code.

## Test

```bash
npm test        # test vector SigV4 + chữ ký CloudFront + map viseme (không cần mạng)
npm run test:s3 # thêm: chạy thật trên MinIO qua docker compose
```

Test vector chỉ chứng minh mình ký ra đúng chuỗi đó; nó không chứng minh S3 **chấp nhận** chữ ký.
Hai lỗi hay gặp nhất — thứ tự field trong `FormData` và điều kiện policy sai — chỉ lộ ra ở
`npm run test:s3`. Không có `S3_ENDPOINT` thì các test đó tự skip.

Phần viseme cũng vậy, và còn thiếu nhiều hơn. `shared/viseme.test.ts` và `server/polly.test.ts`
phủ được bảng map, `frameAt`, đọc speech marks, định dạng header SigV4 và đọc config — toàn bộ đều
là logic thuần, chạy offline. **Chưa được kiểm chứng:**

- **Chưa gọi Polly thật.** Định dạng `Authorization` đã được AWS chấp nhận (lỗi trả về là
  `UnrecognizedClientException` chứ không phải `SignatureDoesNotMatch`, nghĩa là header đọc được và
  chỉ không tìm thấy access key), nhưng điều đó **không** chứng minh phép tính chữ ký đúng. Cần một
  lần chạy với credential thật.
- **Chưa render avatar 3D lần nào.** Ba nhánh hỏng (không cấu hình / tải lỗi / model thiếu morph
  target) đều có mã xử lý và báo khác nhau, nhưng chưa ai nhìn thấy nó chạy.
