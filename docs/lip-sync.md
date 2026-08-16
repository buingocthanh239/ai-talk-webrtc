# Khẩu hình — viseme từ Amazon Polly, avatar Spine 2D

Tài liệu này mô tả cách avatar nhép mồm theo lời AI **ngay trong hội thoại**.

Bám sát code hiện tại: `shared/viseme.ts`, `shared/chunk.ts`, `public/src/polly-client.ts`,
`public/src/speech-queue.ts`, `public/src/talk-avatar.ts`, `public/src/viseme-player.ts`,
`public/src/avatar.ts`, `server/characters/*.json`.

Avatar là **Spine 2D** (`@esotericsoftware/spine-webgl`), không phải mô hình 3D.

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
  shared/viseme.ts       →  map 18 nhãn Polly → 17 trong bộ 22 ID của rig
speech-queue.ts          →  khúc nào đang phát, nạp timeline của khúc đó
viseme-player.ts         →  timeline + audio.currentTime → 2 đầu ra:
                            · khẩu hình đang mở (rời rạc) → avatar
                            · bảng trọng số (liên tục)    → thanh đo
avatar.ts                →  setAnimation(track 1, `viseme_N`), Spine tự mix
```

**Hai track là bắt buộc.** `Idle*` và `Blink` chạy track 0, viseme track 1 — vì `Idle` cũng animate
chính `Mouth1..Mouth8`. Nhét chung một track thì miệng vừa nhép vừa bị Idle kéo.

`viseme-player.ts` **không biết gì về Spine hay DOM** — nó chỉ trả ra khẩu hình đang mở và một bảng
trọng số. Nhờ vậy thanh đo debug và avatar đọc chung đúng một nguồn.

> **22 thanh đo viseme luôn chạy**, kể cả khi nhân vật chưa có asset (gập trong `<details>` cạnh
> avatar). Khi mồm avatar đứng im, đây là cách nhanh nhất để biết lỗi ở tầng nào: thanh đo nhảy mà
> mồm đứng im → lỗi ở rig hoặc runtime. Thanh đo cũng đứng im → lỗi ở dữ liệu hoặc timeline.
>
> Năm thanh bị làm mờ là năm khẩu hình Polly không bao giờ gọi tới (mục 4) — để không ai mất buổi
> chiều đi tìm xem vì sao chúng đứng im.

**Lỗi tầng mạng phải tự thử lại.** `net::ERR_CONNECTION_CLOSED` và `net::ERR_SOCKET_NOT_CONNECTED`
là triệu chứng của một cuộc đua: trình duyệt giữ socket sống trong pool để dùng lại, AWS đóng socket
rảnh sau một lát nằm không. Với `GET` trình duyệt tự âm thầm thử lại; với **`POST` thì không** — nó
không biết request có an toàn để gửi lại hay không.

App này dính đúng nhịp đó: nó bắn POST theo từng đợt (một lượt AI nói) rồi im trong lúc người học
nói. `fetch` **ném** trong trường hợp này chứ không trả về status, nên đường retry theo `429` không
hề chạm tới. `SynthesizeSpeech` cùng đầu vào cho ra cùng audio nên gửi lại là an toàn.

**Audio và speech marks không ngang hàng nhau.** Polly trả hai thứ này bằng **hai request riêng**
(speech marks trả về *thay cho* audio, không kèm theo — thiết kế của Polly, không gộp được). Hai
request đó từng đi bằng `Promise.all`, nghĩa là marks hỏng thì mất luôn audio.

Đó là một lỗi thật và nó bật ra thường xuyên: mỗi khúc bắn **hai** request, `MAX_IN_FLIGHT = 3` nên
tới **6 request đồng thời**, trong khi Polly tính TPS theo **cả account**. Bên bị throttle rơi vào
marks là chuyện bình thường — và khi đó khúc ấy im tiếng dù file mp3 đã về tới nơi.

Thứ tự ưu tiên thật: **audio là thứ người học nghe, marks chỉ để avatar nhép.** Mất khẩu hình thì
avatar đứng im một khúc; mất audio thì mất hẳn một đoạn bài học. Nên giờ marks được phép hỏng —
`frames: []` và khúc vẫn đọc bình thường. Cùng nguyên tắc với `Promise.allSettled` ở khâu chấm điểm.

Ba trường hợp hỏng của avatar được báo **khác nhau**, vì cách sửa khác hẳn nhau:

| Hiện tượng | Nguyên nhân | Sửa |
|---|---|---|
| "Nhân vật này chưa có avatar" | `avatar: null` trong file nhân vật | trỏ `skeleton` + `atlas` vào asset |
| "Không tải được avatar: …" | sai đường dẫn, hoặc runtime lệch phiên bản với bản export | kiểm tra `/character/...` và phiên bản Spine |
| "Skeleton tải được nhưng không có animation viseme_N nào" | export thiếu animation khẩu hình | export lại từ Spine |

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
        VP->>Av: playViseme(id) khi id ĐỔI
    end
```

Vòng render **chạy cả khi audio đang tạm dừng** — nhờ vậy khoảng nghỉ giữa hai khúc, hay lúc người
học dừng lại, mồm vẫn giữ đúng khẩu hình của mốc đó chứ không đóng băng ở khung cuối của khúc trước.

**Vì sao có giao thoa 70ms:** miệng thật không nhảy cóc. Khi phát /b/ trong "about", môi đã chụm lại
từ trước đó. Nhảy tức thời giữa các viseme nhìn ra ngay là máy, và với người đang tập bắt chước thì
còn dạy sai cả cách chuyển âm.

Với avatar, việc mix đó **giao cho Spine** (`AnimationStateData.defaultMix`) chứ không tự nội suy:
Spine nội suy trên chính các bone, còn ta chỉ nội suy được một con số. Bảng trọng số 70ms ở trên
giờ chỉ phục vụ thanh đo.

**Dòng gợi ý tiếng Việt đọc từ timeline, không đọc từ bảng trọng số đã làm mượt.** Giữa hai khẩu
hình, trọng số bị chia đôi nên không cái nào vượt ngưỡng, và dòng chữ sẽ nháy về "Miệng nghỉ" một
cái — đúng lúc người học đang đọc nó.

---

## 4. Bảng map Polly → viseme ID của rig

Rig dùng bộ **22 ID (0–21)** — chính là bảng viseme của Azure Speech. Hoạ sĩ vẽ theo bảng đó.
Polly thì dùng bộ nhãn riêng, **thô hơn**, nên ở giữa phải có một bảng đổi:

| Polly | Âm | → ID | Polly | Âm | → ID |
|---|---|---|---|---|---|
| `sil` | — | 0 | `r` | ɹ | 13 |
| `@` | ə, ɚ | 1 | `l` | l | 14 |
| `a` | æ, ɑ, aɪ, aʊ | 2 | `s` | s, z | 15 |
| `O` | ɔ, ɔɪ | 3 | `S` | ʃ, tʃ, dʒ, ʒ | 16 |
| `E` / `e` | ɛ,ʌ,ɜ / eɪ | 4 | `T` | θ, ð | 17 |
| `i` | i, ɪ, j | 6 | `f` | f, v | 18 |
| `u` | u, ʊ, w | 7 | `t` | d, n, t | 19 |
| `o` | oʊ | 8 | `k` | g, h, k, ŋ | 20 |
| | | | `p` | b, m, p | 21 |

**`T` cho về 17 chứ không phải 19**, dù Azure xếp θ vào 19: 17 là hình lưỡi thò ra giữa hai răng,
và đó đúng là thứ người học cần *nhìn thấy*. Với app dạy phát âm, chọn hình dễ thấy quan trọng hơn
khớp bảng.

### Năm khẩu hình Polly không bao giờ gọi tới

| ID | IPA | Vì sao |
|---|---|---|
| 5 | `ɝ` | Polly gộp vào `@` cùng schwa |
| 9 | `aʊ` | gộp vào `a` |
| 10 | `ɔɪ` | gộp vào `O` |
| 11 | `aɪ` | gộp vào `a` |
| 12 | `h` | gộp vào `k` |

Ba trong số đó là nguyên âm đôi — thứ người Việt học tiếng Anh hay nuốt mất. **Đây là cái giá đã
biết trước khi chọn Polly**, không phải bug. Đổi sang Azure thì cả bảng đổi ở trên biến mất và 22
hình đều sống.

Danh sách nằm ở `UNREACHABLE_BY_POLLY` trong `shared/viseme.ts` chứ không chỉ trong tài liệu — thanh
đo debug đọc từ đó để làm mờ, và có một test khoá nó với bảng map để hai thứ không lệch nhau.

**Bảng map nằm ở `shared/` chứ không ở client**, dù bây giờ chỉ client gọi Polly: nó là hợp đồng
giữa dữ liệu Polly và tên animation trên skeleton. Polly ghi ra `p`, bảng đổi thành `21`, client
phát `viseme_21`. Lệch một số là mồm đứng im mà không báo lỗi.

## 4b. Khung hình: neo vào mặt, không phải vào skeleton

Miệng nhép đúng mà không ai thấy thì cũng như không. Khung avatar trong hội thoại chỉ cao 220px, nên
ôm cả người là miệng còn vài pixel.

**Bẫy đã vấp.** `renderer.resize(ResizeMode.Fit, w, h)` trông như đặt được kích thước khung nhìn,
nhưng nhánh `Fit` của runtime **bỏ qua hai tham số đó** — nó chỉ giữ lại tỉ lệ của viewport *đang*
có. Mà viewport đang có là `new OrthoCamera(canvas.width, canvas.height)` đọc lúc dựng
`SceneRenderer`, và thẻ `<canvas>` không đặt thuộc tính `width`/`height` nên đó là **300×150 mặc
định của HTML**. Kết quả: khung nhìn ~150 đơn vị world trên một skeleton cao hơn 1.200 — một vệt cắt
phóng to đặt giữa người. Đường duy nhất nói được kích thước thật là `camera.setViewport()`.

**Neo vào đâu.** Không dùng bone tên `Head`: cả bốn rig đều có nó nhưng nó nằm ở world `(0,0)`, tức
đáy skeleton — đây là rig bán thân, không phải người đầy đủ. Thay vào đó lấy AABB của những *slot*
khớp `/face|eye|mouth|tooth|touth|tongue/i`, cùng cách `Skeleton.getBounds` làm nhưng lọc slot.

Tên slot không thống nhất giữa các rig (`Robot_Face`, `Macro_Face`, `Prof_Face`, `Face`) nên đo bằng
chính hình vẽ là cách duy nhất không phụ thuộc quy ước đặt tên. Đo bằng spine-core chạy headless:

| Rig | Mặt / cả người | Mặt chiếm khung | Miệng chiếm khung |
|---|---|---|---|
| Leo | 47% | 77% | 14% |
| Marco | 56% | 77% | 14% |
| Prof | 62% | 77% | 17% |
| Tina | 44% | 77% | 18% |

Khung chốt ở **tư thế gốc, một lần**. Đo ở tư thế đang chạy thì Idle kéo đầu đi mỗi frame và khung
nhìn sẽ trôi theo. `ResizeObserver` chỉ áp lại tỉ lệ, không đo lại.

---

## 5. Chi phí

Mỗi khúc AI đọc là **hai** request Polly (mp3 và speech marks trả về *thay cho nhau*, không kèm
theo).

Hai request đó đi **nối tiếp**, và đây là ràng buộc chứ không phải lựa chọn: endpoint HTTP/2 của
Polly báo `SETTINGS_MAX_CONCURRENT_STREAMS = 1`, mà trình duyệt thì gom cả origin vào **một** kết nối
h2 dùng chung. Bắn hai request cùng lúc là AWS giết cả kết nối, kéo theo mọi request đang đi trên đó
(`net::ERR_SOCKET_NOT_CONNECTED`, `net::ERR_CONNECTION_CLOSED`). Đo trong Chrome trên đúng endpoint
này: 6 request song song hỏng 41/48, cùng 6 request đó mà nối tiếp thì hỏng 0/48. Cửa xếp hàng nằm ở
`serial()` trong `public/src/polly-client.ts`.

Cái giá là mỗi khúc tốn hai vòng mạng chứ không phải một. Đổi lại khúc N+1 vẫn được tổng hợp trong
lúc khúc N đang **phát**, mà phát một câu thì lâu hơn nhiều so với một vòng mạng — nên chỉ khúc đầu
tiên của mỗi lượt thực sự chậm thêm.

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
| **Đổi sang Azure Speech cho khớp rig** | Rig được vẽ theo đúng bảng 22 viseme của Azure, và `VisemeReceived` trả thẳng ID + mốc thời gian nên bỏ được cả bảng đổi lẫn năm khẩu hình chết. Đã cân nhắc và **chọn ở lại Polly**: toàn bộ đường TTS, ký SigV4 và STS đã dựng xong cho AWS, đổi vendor là viết lại từ đầu |
| **Backend gọi Polly hộ client** | Khúc đầu tiên của mỗi lượt là toàn bộ độ trễ người dùng cảm thấy, và một vòng round trip qua backend nằm đúng trên đường nóng đó. Cắt khúc càng nhỏ để giảm độ trễ thì càng tốn nhiều vòng |

**Cái giá đã trả cho việc đổi:** mất prosody của giọng Realtime. Polly neural phẳng hơn rõ.

---

## 7. Giới hạn đã biết

**Rig CÓ lưỡi và răng** — giới hạn cũ đã hết. Bốn skeleton đều có slot `Tongue`, `Tooth_U`,
`Tooth_B`, `ToothU_Shadow`. Với người Việt học tiếng Anh, những phân biệt khó nhất nằm đúng ở lưỡi
(θ/ð, l vs n, âm r), và bộ rig này diễn được. Dòng `VISEME_HINT_VI` trong `shared/viseme.ts` vì thế
đổi vai: từ chỗ *thay thế* thành chỗ *xác nhận* — người học đọc để biết mình đang nhìn đúng chỗ.

**Các animation viseme không key cùng một bộ bone.** Leo `viseme_0` key `Mouth` và `Mouth2..8` nhưng
thiếu `Mouth1`; Marco `viseme_0` thiếu `Mouth2` và `Mouth6`. Bone không được key ở track 1 sẽ rơi về
track 0 (`Idle`, vốn cũng animate `Mouth1..8`), nên đổi khẩu hình có thể thấy bone giật nhẹ. **Sửa
thật nằm ở file Spine**: key đủ cả 8 bone miệng trong cả 22 animation.

**Runtime khoá theo phiên bản.** Skeleton export từ Spine 4.3.x chỉ nạp được bằng runtime 4.3.x.
Nâng cấp editor mà quên nâng npm là vỡ trắng, và thông báo lỗi không nói ra điều đó.

**Runtime Spine đòi giấy phép Spine Editor.** Xem header license trong `node_modules/@esotericsoftware/`.

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

**Chưa render avatar lần nào.** Ba nhánh hỏng ở mục 2 đều có mã xử lý, nhưng chưa ai nhìn thấy nó
chạy. Mỗi skeleton còn có animation `Test mieng` do hoạ sĩ để lại — phát nó là cách rẻ nhất để tách
"rig hỏng" khỏi "dữ liệu Polly hỏng".

**Asset nặng.** PNG 1.9–3.4 MB mỗi nhân vật, bốn nhân vật ~10 MB. Chỉ tải nhân vật đang chọn, và
dùng `.skel` (69 KB) chứ không phải `.json` (135 KB).
