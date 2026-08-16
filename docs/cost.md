# Chi phí AI Learn — ước tính và so sánh OpenAI audio ↔ Amazon Polly

Tài liệu này trả lời hai câu hỏi: **một buổi học tốn bao nhiêu tiền**, và **để AI nói bằng
Polly hay bằng audio thẳng từ OpenAI thì rẻ hơn**.

Mô hình bám sát code hiện tại (`server/index.ts` mục `mintClientSecret`, `public/src/session.ts`,
`public/src/polly-client.ts`, `server/grader.ts`) và lấy tỉ lệ sử dụng từ số liệu thật trong
`data/app.db`.

Giá tra ngày **2026-08-16** từ `developers.openai.com/api/docs/pricing` và
`aws.amazon.com/polly/pricing`. Giá có thể đổi — mục [9](#9-cách-kiểm-chứng-lại-số) ghi cách đo lại.

> **Kết luận ngắn.** Một buổi 5 phút tốn khoảng **$0.18**, tức **~$0.036/phút kết nối**.
> Ở 1.000 DAU × 1 buổi/ngày là **~$5.400/tháng**.
>
> Polly **rẻ hơn ~2,9 lần** so với cho OpenAI phát audio trực tiếp, dù đã chịu phạt nhân đôi
> vì speech marks. Tính cả hiệu ứng giọng AI nằm lại trong context, chuyển sang audio-out sẽ
> làm **tổng hoá đơn tăng gấp đôi**. Quyết định dùng Polly để lấy viseme đang tiết kiệm tiền,
> không phải đánh đổi tiền lấy chất lượng nhép mồm.

---

## 1. Hoá đơn gồm những dòng nào

Session chạy `output_modalities: ['text']` — OpenAI **chỉ nghe và trả chữ**, Polly đọc. Nên tiền
chia làm năm dòng, mỗi dòng gắn với một chỗ cụ thể trong code:

| Dòng | Sinh ra ở đâu | Tính theo |
|---|---|---|
| `gpt-realtime` audio input | user giữ nút nói → `input_audio_buffer.commit` (`session.ts:683`) | token audio |
| `gpt-realtime` cached input | mỗi lượt đọc lại **toàn bộ** hội thoại | token, giá cache |
| `gpt-realtime` text output | câu trả lời + JSON gợi ý (`#requestHints`, `session.ts:944`) | token text |
| `whisper-1` transcription | `session.audio.input.transcription` (`index.ts:356`) | **phút, rate card riêng** |
| Amazon Polly neural | `synthesize()` (`polly-client.ts:283`) | ký tự, **×2** |

Hai chỗ dễ tính thiếu:

> **whisper-1 KHÔNG nằm trong audio input token.** Doc của OpenAI ghi rõ input transcription
> "billed from a different rate card", và mục chi phí per-Response nói trừ nó ra. Bạn trả cả hai:
> token audio cho model s2s, **cộng** $0.006/phút cho whisper. Lý do là model realtime nghe audio
> trực tiếp, transcript chỉ chạy song song để hiển thị và để chấm điểm.

> **Speech marks bị tính tiền y như synthesize.** AWS: *"characters of text that you convert either
> to speech **or to Speech Marks metadata**"*. `synthesize()` bắn hai request cho cùng một khúc chữ
> (một `OutputFormat: "mp3"`, một `SpeechMarkTypes: ["viseme"]`), nên **mỗi ký tự AI nói bị tính
> hai lần**. Đây là cái giá của viseme chuẩn âm vị, và nó đã nằm trong mọi con số dưới đây.

Ngoài ra còn khâu chấm điểm cuối buổi (`server/grader.ts`): `gpt-4o` cho transcript, và
`gpt-4o-audio-preview` cho tối đa 5 đoạn WAV dài nhất (`MAX_AUDIO_SEGMENTS`).

---

## 2. Bảng giá tham chiếu

### OpenAI Realtime (USD / 1M token)

| Model | Audio in | Cached in | Audio out | Text in | Text out |
|---|---|---|---|---|---|
| `gpt-realtime` | $32 | $0.40 | $64 | $4 | **$16** |
| `gpt-realtime-2` / `-2.1` | $32 | $0.40 | $64 | $4 | **$24** |
| `gpt-realtime-mini` | $10 | $0.30 | $20 | $0.60 | $2.40 |

Quy đổi thời lượng, theo doc `realtime-costs`: **audio input 1 token / 100 ms** (600 tok/phút),
**audio output 1 token / 50 ms** (1.200 tok/phút).

### Transcription (tính riêng, theo phút)

| Model | Giá |
|---|---|
| `gpt-4o-mini-transcribe` | ~$0.003/phút |
| `gpt-transcribe` | $0.0045/phút |
| **`whisper-1` (đang dùng)** | **$0.006/phút** |
| `gpt-realtime-whisper`, `gpt-live-transcribe` | $0.017/phút |

### Chấm điểm

| Model | Text in | Text out | Audio in |
|---|---|---|---|
| `gpt-4o` | $2.50 | $10 | — |
| `gpt-4o-audio-preview` (đang dùng) | $2.50 | $10 | **$40** |
| `gpt-audio` (bản thay thế) | $2.50 | $10 | **$32** |

### Amazon Polly (USD / 1M ký tự)

| Engine | Giá | Speech marks | Free tier |
|---|---|---|---|
| Standard | $4 | có | 5M ký tự/tháng |
| **Neural (đang dùng)** | **$16** | có | 1M ký tự/tháng, 12 tháng đầu |
| Generative | $30 | **KHÔNG có** | 100K/tháng, 12 tháng đầu |
| Long-form | $100 | có, nhưng chỉ `us-east-1` | 500K/tháng, 12 tháng đầu |

`ap-southeast-1` giá **giống hệt** `us-east-1` cho Standard và Neural (đối chiếu AWS Price List API).
Chuyện Generative không trả speech marks đã được ghi sẵn ở `.env.example` — nhắc lại vì nó khiến
bảng giá "avatar" trên trang AWS gây hiểu nhầm.

---

## 3. Số liệu đo được từ `data/app.db`

| Chỉ số | Giá trị |
|---|---|
| Cuộc gọi hoàn tất | 22 |
| Thời lượng kết nối trung bình | 68,8 s |
| Đoạn user nói | 127 đoạn, trung bình 4,1 s |
| **User thực sự nói / thời gian kết nối** | **35 %** |
| Câu AI | 153 câu, trung bình 77 ký tự |
| Lượt user mỗi buổi | 5,7 |

Con số 35% là điểm đáng giá nhất ở đây: **push-to-talk đang tiết kiệm gần hai phần ba tiền audio
input**. Mic bị tắt giữa các lượt (`setMicEnabled(false)`, `realtime.ts:141`) và buffer được dọn
bằng `input_audio_buffer.clear` trước mỗi lượt, nên khoảng lặng không bao giờ thành token. Nếu bật
VAD server-side thì dòng audio input sẽ nhân lên gần 3 lần.

Đây là số của giai đoạn dev nên buổi ngắn và câu AI ngắn. Mô hình dưới đây giữ nguyên **tỉ lệ** đó
nhưng scale lên độ dài buổi học thật.

---

## 4. Giả định của mô hình

| Tham số | Giá trị | Căn cứ |
|---|---|---|
| Instructions | 868 token | đo thật từ `buildInstructions()` + `cafe-order.json` |
| Tool definitions | 347 token | đo thật từ `buildTools()` |
| Instructions cho hints | ~90 token | `session.ts:955` |
| Tốc độ nói | 14 ký tự/giây | ~165 wpm |
| Ký tự / token | 4 | tiếng Anh |
| Cache | prefix append-only đều hit | context khởi điểm 1.215 token > ngưỡng 1.024 |
| Buổi 5 phút | 12 lượt, 96 s user nói, 1.800 ký tự AI | scale từ tỉ lệ mục 3 |

Cách tính context: mỗi token vào context bị tính **uncached đúng một lần**, các lần đọc sau là
cached. Với buổi 5 phút, tổng lượng đọc là **52.020 token** — trong đó chỉ 4.005 là uncached.

---

## 5. Ước tính một buổi

### Buổi 5 phút, chi tiết từng dòng

```
gpt-realtime  audio in       960 tok uncached @ $32     $0.0307
              text in      3.045 tok uncached @ $4      $0.0122
              cached in   48.015 tok @ $0.40            $0.0192
              text out       990 tok @ $16              $0.0158
                                                        ───────
                                                        $0.0779

whisper-1                  1,6 phút @ $0.006            $0.0096
Polly neural               1.800 ký tự × 2 @ $16        $0.0576
chấm điểm     gpt-4o                                    $0.0119
              gpt-4o-audio-preview                      $0.0217
                                                        ───────
TỔNG                                                    $0.179
```

### Ba độ dài buổi

| | Buổi 69 s (đo thật) | Buổi 5 phút | Buổi 10 phút |
|---|---|---|---|
| gpt-realtime | $0.029 | $0.078 | $0.168 |
| whisper-1 | $0.002 | $0.010 | $0.019 |
| Polly neural (×2) | $0.017 | $0.058 | $0.115 |
| Chấm điểm | $0.025 | $0.034 | $0.036 |
| **Tổng** | **$0.073** | **$0.179** | **$0.338** |

> **Chi phí tăng siêu tuyến tính theo độ dài buổi.** Buổi dài gấp đôi tốn gấp **1,9 lần** chứ không
> phải 2 — và riêng dòng cached đi từ $0.019 lên $0.055, tức gấp **2,9 lần**. Nguyên nhân là mỗi
> lượt đọc lại toàn bộ hội thoại, nên tổng lượng đọc lớn theo bình phương số lượt. `DAILY_QUOTA_MS`
> mặc định 5 phút vì vậy vừa là hàng rào chi phí vừa là hàng rào sản phẩm.

### Quy mô, 1 buổi 5 phút/người/ngày

| Phương án | /buổi | 100 DAU | 1.000 DAU | 10.000 DAU |
|---|---|---|---|---|
| **A. Hiện tại** (realtime text-out + Polly neural) | $0.179 | $536 | **$5.363** | $53.631 |
| A′. Đổi sang Polly standard | $0.136 | $407 | $4.067 | $40.671 |
| B. OpenAI audio-out, bỏ Polly | $0.379 | $1.138 | $11.380 | $113.803 |
| C. `gpt-realtime-mini` + Polly neural | $0.118 | $353 | $3.525 | $35.253 |

---

## 6. Câu hỏi chính: OpenAI audio hay Polly?

Quy tất cả về cùng một đơn vị — **giá cho 1 triệu ký tự AI nói ra**:

| Cách phát tiếng | Quy đổi / 1M ký tự | Buổi 5 phút |
|---|---|---|
| Polly standard + marks | **$8** | $0.014 |
| Polly neural, chỉ audio (nếu bỏ viseme) | $16 | $0.029 |
| Polly generative — **không có speech marks** | $30 | $0.054 |
| **Polly neural + marks — đang dùng** | **$32** | **$0.058** |
| **OpenAI realtime audio out** | **~$91** | **$0.165** |
| Polly long-form + marks | $200 | $0.360 |

Quy đổi lấy từ 1.200 token/phút × $64/1M ÷ 840 ký tự/phút.

**Polly neural rẻ hơn 2,9 lần**, dù đang trả tiền hai lần cho mỗi ký tự. Polly standard rẻ hơn
**11 lần**. Chỉ Long-form là đắt hơn OpenAI.

Nhưng chênh lệch thật lớn hơn con số đó, vì giọng AI do OpenAI sinh ra sẽ **nằm lại trong context**
và bị đọc lại ở mọi lượt sau:

| | Realtime | Polly | Whisper + chấm điểm | Tổng |
|---|---|---|---|---|
| **A.** text-out + Polly neural | $0.078 | $0.058 | $0.043 | **$0.179** |
| **B.** audio-out, bỏ Polly | $0.336 | — | $0.043 | **$0.379** |

Chuyển sang audio-out làm tổng hoá đơn **tăng 2,1 lần**. Trong $0.336 đó, $0.165 là audio output,
phần còn lại là 2.571 token audio của AI bị đọc đi đọc lại như input.

> Con số $0.336 giả định audio do AI sinh ra bị tính uncached ở lần đọc đầu. Nếu OpenAI ghi thẳng
> nó vào cache lúc sinh, chi phí là $0.255 — vẫn cao hơn phương án A **1,4 lần** ở riêng phần
> realtime, và vẫn mất viseme.

**Kết luận:** giữ Polly. Cái mất duy nhất là prosody của giọng Realtime — audio-out không rẻ hơn ở
bất kỳ kịch bản nào, kể cả khi bỏ hẳn viseme.

---

## 7. Bốn đòn bẩy giảm chi phí

Xếp theo mức tiết kiệm trên một buổi 5 phút.

### 7.1. Đổi sang `gpt-realtime-mini` — tiết kiệm $0.061/buổi (−34%)

Phần realtime tụt từ $0.078 xuống $0.017. Với vai trò "bạn hội thoại chạy theo kịch bản đã viết sẵn
trong instructions", đây là thứ đáng A/B trước tiên. Rủi ro: model nhỏ bám objectives kém hơn, cần
đo lại tỉ lệ pass ở `progress`.

### 7.2. Đổi Polly neural → standard — tiết kiệm $0.043/buổi (−24%)

`POLLY_ENGINE` vốn đã là biến môi trường và người học đổi được giọng ngay trên màn hình, nên đây là
thay đổi một dòng. Đánh đổi thẳng vào chất lượng giọng, cần nghe thử trước khi chốt.

### 7.3. Chỉ gọi hints khi người học mở panel — tiết kiệm $0.023/buổi (−13%)

`#requestHints()` chạy sau **mỗi** câu AI (`session.ts:826`), và mỗi lần đọc lại toàn bộ context.
Nó làm **gấp đôi số lần suy luận** trong một buổi và chiếm **30% chi phí realtime**. Nếu phần lớn
người học không dùng gợi ý thì đây là tiền đốt thẳng.

### 7.4. `gpt-4o-audio-preview` → `gpt-audio` — tiết kiệm $0.004/buổi

Audio input $32 thay vì $40. Bản preview đã bị thay thế trên trang giá; đổi sớm vừa rẻ hơn 20% vừa
tránh ngày nó bị tắt.

### Ngoài ra

- **Pin số hiệu snapshot của model.** `REALTIME_MODEL=gpt-realtime` là alias trôi. Snapshot `-2` và
  `-2.1` có **text output $24/1M** thay vì $16 — audio giữ nguyên, nhưng app này output toàn text
  nên đúng dòng bị tăng 50%, âm thầm.
- **Cache mp3 của những câu lặp lại.** Lời chào mở đầu và các mẫu gợi ý theo cấp độ
  (`HINT_INSTRUCTIONS`) gần như cố định, nhưng hiện mỗi buổi đều gọi Polly lại từ đầu. Đẩy sẵn lên
  S3/CDN là bỏ hẳn phần ký tự đó khỏi hoá đơn.
- **Free tier Polly** neural 1M ký tự/tháng trong 12 tháng đầu ≈ **550 buổi miễn phí/tháng**;
  standard 5M/tháng.

Áp cả 7.1 + 7.3 (hai thứ không đụng vào chất lượng cảm nhận được): **$0.179 → $0.095/buổi**, tức
1.000 DAU còn **$2.850/tháng**.

---

## 8. Những chỗ chưa chắc

| Chỗ | Vấn đề |
|---|---|
| **Tỉ lệ cache hit** | Là giả định, không phải đo. Chiếm $0.019/buổi ở phương án A và tăng theo bình phương độ dài buổi. |
| **Token audio in của `gpt-4o-audio-preview`** | Không có tài liệu nào công bố tok/phút cho model Chat Completions; đã giả định 1 tok/100 ms như Realtime. Chỉ ảnh hưởng $0.022/buổi. |
| **Free tier Polly standard** | Dòng 5M/tháng là dòng duy nhất không kèm chữ "first 12 months". Chưa xác minh được là vĩnh viễn hay chỉ thiếu chú thích. |
| **Doc OpenAI tự mâu thuẫn** | Bảng "endpoint support" của `whisper-1` ghi `v1/realtime` là "Not supported", trong khi guide realtime-costs lại nêu đích danh nó là model input transcription. API reference đáng tin hơn, nhưng nên đối chiếu hoá đơn thật. |

---

## 9. Cách kiểm chứng lại số

Ba phép đo, làm được ngay, sẽ thay hầu hết giả định ở trên bằng số thật:

1. **Cache hit.** Log `response.done.usage.input_token_details.cached_tokens` trong
   `#onResponseDone` (`session.ts:794`) một buổi. So với cột "cached" ở mục 4.
2. **Chi phí transcription thật.** Event `conversation.item.input_audio_transcription.completed`
   mang `usage` riêng, tách khỏi `response.done`.
3. **Ký tự Polly thật.** Cộng `text.length` của mỗi khúc trong `synthesize()`, nhân đôi. So với
   1.800 × 2 của mô hình.

Sau ba phép đo đó, con số duy nhất còn là ước lượng sẽ là hành vi người dùng: buổi dài bao lâu và
mỗi ngày mấy buổi.
