# Khẩu hình — viseme từ Amazon Polly, avatar 3D

Tài liệu này mô tả cách avatar nhép mồm theo lời AI **ngay trong hội thoại**.

Bám sát code hiện tại: `shared/viseme.ts`, `shared/chunk.ts`, `public/src/polly-client.ts`,
`public/src/speech-queue.ts`, `public/src/talk-avatar.ts`, `public/src/viseme-player.ts`,
`public/src/avatar.ts`.

> **Từng có một màn "luyện khẩu hình" riêng, nay đã bỏ.** Nó tồn tại vì hội thoại không thể có
> khẩu hình — xem [mục 1](#1-ràng-buộc-gốc-và-cách-gỡ). Khi hội thoại có rồi thì một màn riêng đọc
> sẵn từ vựng của bài chỉ còn là một đường Polly thứ hai phải nuôi, với một giọng có thể lệch so
> với giọng người học đã chọn. Lịch sử nằm trong git.

---

## 1. Ràng buộc gốc và cách gỡ

Ràng buộc vẫn còn nguyên:

> **OpenAI Realtime API không phát ra event viseme hay phoneme nào, và cũng không có timestamp cho
> transcript.**

Chừng nào tiếng nói còn đến từ Realtime API, muốn avatar nhép chỉ còn cách suy viseme từ phổ âm
thanh. Cách đó cho chuyển động đúng **nhịp** nhưng sai **âm vị**: phụ âm bật (p, b, d, k) về bản
chất là một khoảng lặng rồi bung ra, gần như không tách được khỏi im lặng bằng phân tích phổ. Với
app chỉ cần "avatar có mặt cho sinh động" thì đủ. Với app **dạy phát âm** thì nhép sai là dạy sai.

Cách gỡ: **đừng suy từ audio — đổi nguồn tiếng nói.** Session chạy `output_modalities: ["text"]`,
OpenAI chỉ trả chữ, client đọc chữ đó bằng Polly. Câu AI vừa nói trở thành text biết trước, và
Polly trả thẳng **speech marks** kèm mốc ms cho từng viseme. Không còn gì phải đoán.

Luồng đầy đủ của một lượt nói: [`ai-talk-flow.md`](ai-talk-flow.md) mục 3.

---

## 2. Bốn tầng, tách rời có chủ đích

```
Polly (client tự ký)     →  timeline viseme đúng âm vị
  shared/viseme.ts       →  map 17 viseme Polly → 15 viseme Oculus
speech-queue.ts          →  khúc nào đang phát, nạp timeline của khúc đó
viseme-player.ts         →  timeline + audio.currentTime → trọng số 0..1
avatar.ts                →  trọng số → morphTargetInfluences
```

`viseme-player.ts` **không biết gì về three.js hay DOM** — nó chỉ trả ra một bảng trọng số. Nhờ vậy
thanh đo debug và avatar 3D dùng chung đúng một nguồn.

> **15 thanh đo viseme luôn chạy**, kể cả khi không cấu hình `AVATAR_URL` (gập trong `<details>`
> cạnh avatar). Khi mồm avatar đứng im, đây là cách nhanh nhất để biết lỗi ở tầng nào: thanh đo
> nhảy mà mồm đứng im → lỗi ở model/morph target. Thanh đo cũng đứng im → lỗi ở dữ liệu hoặc
> timeline.

Ba trường hợp hỏng của avatar được báo **khác nhau**, vì cách sửa khác hẳn nhau:

| Hiện tượng | Nguyên nhân | Sửa |
|---|---|---|
| "Chưa cấu hình AVATAR_URL" | thiếu env | đặt `AVATAR_URL` |
| "Không tải được avatar: …" | URL sai / mạng / CORS | kiểm tra URL |
| "Model tải được nhưng không có morph target viseme nào" | thiếu `?morphTargets=Oculus Visemes` | tải lại `.glb` kèm tham số |

---

## 3. Đồng hồ: bám `audio.currentTime`, không phải wall clock

```mermaid
sequenceDiagram
    autonumber
    participant SQ as SpeechQueue
    participant RAF as requestAnimationFrame
    participant VP as VisemePlayer
    participant A as HTMLAudioElement
    participant Av as Avatar

    SQ->>VP: load(frames) — sang khúc mới
    SQ->>A: src = blob mp3, play()

    loop mỗi frame
        RAF->>VP: tick()
        VP->>A: currentTime
        Note right of A: playbackRate 0.5× → currentTime<br/>chạy chậm lại theo, nên khẩu hình<br/>tự giãn mà không phải tính lại gì.
        VP->>VP: weightsAt(frames, t)
        Note right of VP: Timeline Polly là các mốc RỜI RẠC.<br/>Một viseme giữ cho tới mốc kế tiếp;<br/>70ms cuối thì chéo dần sang viseme sau.
        VP->>VP: w += (target − w) × (1 − e^(−dt/45ms))
        Note right of VP: Lọc theo dt THẬT, không theo số frame:<br/>máy yếu tụt fps thì tốc độ làm mượt<br/>vẫn y nguyên.
        VP->>Av: apply(weights)
    end
```

Vòng render **chạy cả khi audio đang tạm dừng** — nhờ vậy khoảng nghỉ giữa hai khúc, hay lúc người
học dừng lại, mồm vẫn giữ đúng khẩu hình của mốc đó chứ không đóng băng ở khung cuối của khúc trước.

**Vì sao có giao thoa 70ms:** miệng thật không nhảy cóc. Khi phát /b/ trong "about", môi đã chụm lại
từ trước đó. Nhảy tức thời giữa các viseme nhìn ra ngay là máy, và với người đang tập bắt chước thì
còn dạy sai cả cách chuyển âm.

**Dòng gợi ý tiếng Việt đọc từ timeline, không đọc từ bảng trọng số đã làm mượt.** Giữa hai khẩu
hình, trọng số bị chia đôi nên không cái nào vượt ngưỡng, và dòng chữ sẽ nháy về "Miệng nghỉ" một
cái — đúng lúc người học đang đọc nó.

---

## 4. Bảng map Polly → Oculus

Polly trả bộ viseme của nó (17 giá trị + `sil`, theo IPA). Avatar Ready Player Me nhận bộ Oculus
OVR LipSync (15 morph target, tên có tiền tố `viseme_`).

| Polly | Âm | → Oculus |
|---|---|---|
| `p` | b, m, p | `PP` |
| `f` | f, v | `FF` |
| `T` | θ, ð | `TH` |
| `t` | d, n, t | `DD` |
| `k` | g, h, k, ŋ | `kk` |
| `S` | ʃ, tʃ, dʒ, ʒ | `CH` |
| `s` | s, z | `SS` |
| `l` | l | `nn` |
| `r` | ɹ | `RR` |
| `a` | æ, ɑ, aɪ, aʊ | `aa` |
| `e` / `E` | eɪ / ɛ, ʌ, ɜ | `E` *(gộp)* |
| `i` | i, ɪ, j | `I` |
| `o` / `O` | oʊ / ɔ, ɔɪ | `O` *(gộp)* |
| `u` | u, ʊ, w | `U` |
| `@` | ə, ɚ | `E` ở trọng số 0.55 |
| `sil` | — | `sil` |

**Hai chỗ gộp (`e`/`E`, `o`/`O`) là giới hạn của rig, không phải của Polly** — Polly phân biệt được,
RPM không có morph target riêng.

**Schwa (`@`) bị hạ trọng số xuống 0.55** vì nó là nguyên âm giảm, miệng chỉ hé ra. Cho nó trọng số
đầy như `E` thì avatar nhai quá mạnh ở các âm tiết không nhấn — nhìn ra ngay là sai.

Bảng map nằm ở `shared/viseme.ts` chứ không ở một trong hai phía. Client là nơi duy nhất gọi Polly
bây giờ, nhưng `parseSpeechMarks` và bảng map vẫn ở `shared/` vì chúng là **hợp đồng giữa dữ liệu
Polly và tên morph target trên mesh**: Polly ghi ra `p`, bảng đổi thành `PP`, client tra
`viseme_PP`. Lệch một ký tự là mồm đứng im mà không báo lỗi.

---

## 5. Chi phí

Mỗi khúc AI đọc là **hai** request Polly (mp3 và speech marks trả về *thay cho nhau*, không kèm
theo). Chạy song song nên không tốn thêm độ trễ, chỉ tốn tiền và TPS.

Neural: $16 / 1M ký tự, nhân đôi vì hai request → khoảng **$0.032 / 1M ký tự thật**. Một buổi học
10 phút AI nói chừng 3.000 ký tự ≈ **$0.0001**. Free tier neural còn 1 triệu ký tự/tháng.

**Không còn cache.** Đường cũ cache theo `sha256(giọng|engine|text)` vì câu drill cố định. Câu trong
hội thoại sinh ra lúc chạy nên gần như không bao giờ trùng — cache chỉ là chỗ chứa rác. Đổi lại phải
để ý: **quota TPS của Polly tính theo account**, và giờ mọi lượt hội thoại đều đụng vào.

---

## 6. Những phương án đã loại

| Phương án | Vì sao loại |
|---|---|
| **Suy viseme từ phổ âm thanh** (band energy / formant / `wawa-lipsync`) | Đúng nhịp, sai âm vị. Dạy phát âm bằng nó là dạy sai. `wawa-lipsync` còn đang ở v0.0.2 |
| **G2P từ transcript + forced alignment ngay trong hội thoại** | Realtime API không cho timestamp, nên phải tự align trực tiếp — rất khó và dễ trôi |
| **Forced alignment hậu kỳ (MFA)** | Chính xác nhưng không live, và MFA cần Python/Kaldi trong container riêng. Không còn cần tới |
| **Azure Speech thay vì Polly** | Tương đương về tính năng (`visemeReceived` + blendshape stream). Chọn Polly vì repo **đã** ký SigV4 bằng `node:crypto` trong `server/s3.ts` và **đã** có credential AWS trong `.env`. Azure là thêm vendor, credential và SDK mới |
| **Giữ audio của Realtime, avatar chỉ nhép trong màn luyện riêng** | Chính là kiến trúc cũ. Bỏ vì nó bắt nuôi hai đường Polly, và giọng ở hai màn có thể lệch nhau — cùng một app dạy bắt chước một người nói mẫu mà lại hai giọng |
| **Backend gọi Polly hộ client** | Khúc đầu tiên của mỗi lượt là toàn bộ độ trễ người dùng cảm thấy, và một vòng round trip qua backend nằm đúng trên đường nóng đó. Cắt khúc càng nhỏ để giảm độ trễ thì càng tốn nhiều vòng |

**Cái giá đã trả cho việc đổi:** mất prosody của giọng Realtime. Polly neural phẳng hơn rõ.

---

## 7. Giới hạn đã biết

**Rig không có lưỡi.** Với người Việt học tiếng Anh, những phân biệt khó nhất lại nằm ở lưỡi:
θ/ð (lưỡi giữa hai răng), l vs n, âm r. Avatar RPM không có lưỡi; morph target gần như chỉ có môi
và hàm, nên `TH` chỉ ra được một xấp xỉ môi/hàm. **Polly cho dữ liệu đúng nhưng rig không diễn ra
được.**

Bù tạm bằng `VISEME_HINT_VI` trong `shared/viseme.ts`: mỗi khẩu hình kèm một dòng tiếng Việt nói
thẳng vị trí lưỡi, ví dụ `TH: Dau luoi tho ra GIUA HAI RANG — cho de luoi sau rang`. Đây là bù đắp,
không phải giải pháp. Muốn giải thật thì đổi sang model có morph lưỡi (hoặc thêm sơ đồ cắt dọc
khoang miệng bên cạnh avatar) — và việc đó **không đụng tới tầng dữ liệu**, vì bảng trọng số vẫn y
nguyên.

**Trong hội thoại AI nói ~150 từ/phút.** Không ai nhìn kịp từng khẩu hình ở tốc độ đó. Kéo
`playbackRate` xuống 0.4× thì xem được — nhưng vẫn là nghe trôi qua một lần, không tua lại được
từng âm như màn luyện cũ cho phép. Nếu sau này thấy thiếu thì chỗ để thêm là **màn tổng kết**: ở đó
đã có nút đọc lại từng câu bằng Polly, và bản đọc lại đó mang sẵn viseme.

**Chưa gọi Polly thật lần nào — cả từ server lẫn từ browser.** Định dạng `Authorization` từng được
AWS chấp nhận (lỗi với credential giả là `UnrecognizedClientException` chứ không phải
`SignatureDoesNotMatch`), nhưng điều đó **không** chứng minh phép tính chữ ký đúng. Và bản ký bằng
WebCrypto trong browser là code hoàn toàn mới.

**Chưa biết Polly có trả CORS header không.** Request mang `authorization` + `x-amz-date` +
`x-amz-security-token` nên chắc chắn kích hoạt preflight `OPTIONS`. Đã quyết định không làm đường
lùi qua backend, nên CORS không qua là AI câm.

**`crypto.subtle` chỉ có trong secure context.** `http://localhost` có, `http://192.168.x.x` thì
**không** — mở trên điện thoại cùng mạng LAN sẽ thấy nó `undefined` chứ không phải lỗi chữ ký.

**Chưa render avatar 3D lần nào.** Ba nhánh hỏng ở mục 2 đều có mã xử lý, nhưng chưa ai nhìn thấy
nó chạy.
