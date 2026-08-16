# Luồng AI Talk — sequence diagram (web + mobile app)

Tài liệu này mô tả luồng "nói chuyện với AI" của AI Learn dưới dạng sequence diagram,
viết cho trường hợp có **cả web và mobile app (iOS/Android native)** dùng chung backend.

Các diagram bám sát code hiện tại (`public/src/session.ts`, `public/src/realtime.ts`,
`server/index.ts`, `server/grader.ts`). Chỗ nào mobile phải làm khác web đều được ghi chú
bằng `Note over` hoặc nêu ở phần [Khác biệt web ↔ mobile](#khác-biệt-web--mobile).

---

## 0. Các nhân vật

| Ký hiệu | Là gì | Web | Mobile |
|---|---|---|---|
| **App** | UI + điều phối buổi học | `main.ts` + `LessonSession` | ViewModel / Bloc + `LessonSession` port sang Swift/Kotlin |
| **RTC** | Transport WebRTC thuần | `RealtimeConnection` (browser RTCPeerConnection) | libwebrtc (`WebRTC.framework` / `org.webrtc`) |
| **Rec** | Ghi PCM liên tục + cắt WAV | 2× `AudioWorklet` | `AVAudioEngine` tap / `JavaAudioDeviceModule.SamplesReadyCallback` |
| **BE** | Backend Node | `server/index.ts` | như nhau |
| **DB** | SQLite + chỗ để WAV (đĩa hoặc S3, xem [mục 11](#11-lưu-trữ-audio-client-tự-đẩy-thẳng-lên-s3)) | như nhau | như nhau |
| **OAI** | OpenAI Realtime API (WebRTC) | như nhau | như nhau |
| **Grader** | Chấm điểm sau buổi | `server/grader.ts` | như nhau |

Điểm quan trọng về kiến trúc, đúng cho cả hai nền tảng:

> **Media đi thẳng client ↔ OpenAI. Backend không nằm trên đường audio.**
> Với `AUDIO_STORE=s3` thì cả đường lưu trữ cũng vậy: client `POST` file thẳng lên bucket, backend
> chỉ nhận metadata. Backend giữ: mint ephemeral token, cấp quyền ghi, lưu transcript, đếm hạn mức,
> cắt cuộc gọi, chấm điểm.
> Trạng thái bài học nằm ở server; WebRTC chỉ là đường truyền — mất kết nối chỉ mất đường truyền.

---

## 1. Tổng quan một buổi học

```mermaid
sequenceDiagram
    autonumber
    actor U as Người học
    participant App as Mobile/Web App
    participant BE as Backend
    participant OAI as OpenAI Realtime
    participant DB as SQLite + WAV

    U->>App: Chọn bài học
    App->>BE: POST /api/sessions {lessonId}
    BE->>DB: createSession()
    BE-->>App: {sessionId, lesson}

    rect rgb(235, 244, 255)
        Note over App,OAI: A. Bắt tay (mục 2)
        App->>BE: POST /api/sessions/:id/token
        BE-->>App: clientSecret (đã nhúng instructions + tools)
        App->>OAI: SDP offer → answer
        App->>BE: POST /api/sessions/:id/call {callId}
    end

    loop Mỗi lượt nói (mục 3)
        U->>App: Giữ nút 🎤 … thả
        App->>OAI: audio + commit + response.create
        OAI-->>App: transcript + audio AI
        App->>BE: lưu message
        App->>DB: WAV → S3 (hoặc đĩa), xem mục 11
    end

    rect rgb(255, 245, 235)
        Note over App,DB: B. Kết thúc + chấm điểm (mục 8)
        U->>App: Bấm "Kết thúc"
        App->>OAI: đóng PeerConnection
        App->>BE: POST /api/sessions/:id/end
        BE->>DB: lưu summary
        BE-->>App: summary
    end

    App-->>U: Màn tổng kết (nghe lại từng câu sai)
```

---

## 2. Bắt tay: tạo session → mint token → WebRTC

Đây là chỗ mobile khác web nhiều nhất (định danh, quyền micro, audio session).

```mermaid
sequenceDiagram
    autonumber
    actor U as Người học
    participant App
    participant Rec as Recorder
    participant RTC as WebRTC layer
    participant BE as Backend
    participant OAI as OpenAI

    U->>App: Bấm "Bắt đầu"

    Note over App: MOBILE — làm trước khi đụng WebRTC<br/>1. Xin quyền micro (NSMicrophoneUsageDescription / RECORD_AUDIO)<br/>2. AVAudioSession .playAndRecord + .voiceChat + defaultToSpeaker<br/>   (Android: MODE_IN_COMMUNICATION, setSpeakerphoneOn)<br/>3. Đăng ký interruption observer (mục 9)
    App->>App: getUserMedia / AVAudioEngine start
    App->>Rec: TrackRecorder.create(mic)

    App->>BE: POST /api/sessions/:id/token {resume:false}
    Note over BE: Layer 1 chặn hạn mức:<br/>quotaFor(userId).remainingMs <= 0<br/>→ 429 {code:"quota_exhausted"}
    BE->>BE: buildInstructions(lesson, progress)
    BE->>OAI: POST /v1/realtime/client_secrets<br/>{instructions, tools, whisper-1,<br/> turn_detection:null, voice, speed}
    Note over BE: speed = lesson.speed (0.25–1.5).<br/>Người học đè lên bằng session.update<br/>giữa các lượt — API không cho đổi<br/>giữa chừng một câu đang nói.
    OAI-->>BE: {value, expires_at}
    BE-->>App: {clientSecret, model, seedItems[], progress[], uploadGrant}
    Note over BE,App: uploadGrant = presigned POST policy cho CẢ buổi:<br/>starts-with $key → audio/&lt;sessionId&gt;/, 45..5MB, hạn 2h.<br/>Cấp lại mỗi lần xin token nên reconnect luôn có bản còn hạn.<br/>null = server đang lưu audio trên đĩa.

    Note over App,OAI: API key thật không bao giờ rời server.<br/>App chỉ cầm secret ngắn hạn, không sửa được luật bài học.

    App->>RTC: connect(clientSecret, micStream)
    RTC->>RTC: addTrack(mic) + createDataChannel("oai-events")
    RTC->>RTC: createOffer → setLocalDescription → chờ ICE (tối đa 2s)
    RTC->>OAI: POST /v1/realtime/calls<br/>Authorization: Bearer <clientSecret><br/>Content-Type: application/sdp
    OAI-->>RTC: 201 + SDP answer<br/>Header Location: /v1/realtime/calls/rtc_xxx
    RTC->>RTC: callId = Location.split("/").pop()
    RTC->>RTC: setRemoteDescription(answer) → chờ DataChannel "open"

    OAI-->>RTC: ontrack (audio AI)
    RTC-->>App: onRemoteStream
    App->>Rec: TrackRecorder.create(remote track)
    Note over App: MOBILE: không có <audio srcObject>.<br/>libwebrtc tự phát ra loa qua AudioDeviceModule.<br/>Ghi track AI: RTCAudioRenderer (iOS) /<br/>AudioTrackSink (Android), không phải WebAudio.

    App->>RTC: setMicEnabled(false)
    Note over App,RTC: Push-to-talk: track vẫn nằm trong SDP,<br/>chỉ mute → không phải renegotiate.

    App->>BE: POST /api/sessions/:id/call {callId}
    BE->>BE: scheduleHangup(callId, remainingMs)  ← Layer 2
    BE-->>App: quota
    App->>BE: GET /api/calls/:callId/presence (SSE, giữ mở)
    BE-->>App: event: sync {usedMs, remainingMs, totalMs}

    App-->>U: PTT state = "ready" — micro sẵn sàng
```

---

## 3. Một lượt nói (push-to-talk) — luồng chính

VAD bị **tắt hoàn toàn** (`turn_detection: null`). Client là nơi duy nhất chốt một lượt.

```mermaid
sequenceDiagram
    autonumber
    actor U as Người học
    participant App
    participant Rec as Recorder
    participant RTC
    participant OAI as OpenAI
    participant BE as Backend
    participant S3 as S3 bucket

    Note over App: state = ready

    U->>App: NHẤN GIỮ nút 🎤
    App->>RTC: send {type:"input_audio_buffer.clear"}
    Note right of App: Xoá khoảng lặng đã trôi vào buffer<br/>lúc mic đang mute — không xoá thì<br/>transcription đoán sai.
    App->>RTC: setMicEnabled(true)
    App->>App: seq++, ghi mốc startMs = rec.nowMs()
    App-->>U: state = recording (sóng âm chạy)

    RTC-)OAI: audio frames (Opus, qua media track)

    U->>App: THẢ nút
    App->>RTC: setMicEnabled(false)
    App-->>U: state = thinking
    App->>App: sleep(300ms)  ← chờ gói audio cuối bay hết
    App->>Rec: endMs = nowMs()

    alt Đoạn < 300ms HOẶC không có tiếng nói (hasVoice = false)
        App->>RTC: send {type:"input_audio_buffer.clear"}
        App-->>U: xoá bubble, state = ready
        Note right of App: Bấm nhầm — không tốn lượt gọi model
    else Có tiếng nói
        App->>App: pendingUser.push({seq, startMs, endMs})
        App->>App: releaseHintsSlot() — huỷ response gợi ý đang chạy
        App->>RTC: send {type:"input_audio_buffer.commit"}
        App->>RTC: send {type:"response.create"}

        par Nhánh transcript của user
            OAI-->>App: conversation.item.input_audio_transcription.completed
            App-->>U: cập nhật bubble user (hoặc "(không nghe rõ)")
            App->>BE: POST /api/sessions/:id/messages<br/>{seq, role:"user", text, durationMs}
            App->>Rec: sliceToWav(startMs, endMs)
            App->>S3: POST (presigned policy)<br/>key = audio/:sid/:seq-user.wav
            App->>BE: POST /api/sessions/:id/messages/:seq/audio<br/>{key, bytes, durationMs}
            BE-->>App: {audioUrl}
        and Nhánh trả lời của AI
            OAI-->>App: response.created
            App->>App: seq++, mở bubble assistant, state = ai
            loop streaming
                OAI-->>App: response.output_audio_transcript.delta
                App-->>U: chữ chạy dần
            end
            OAI-)App: audio AI (media track) → loa
            OAI-->>App: response.done
            App->>BE: POST /messages {seq, role:"assistant", text}

            Note over App,Rec: response.done ≠ hết tiếng.<br/>Audio còn đang phát nốt qua WebRTC.
            loop mỗi 300ms, tối đa 12s
                App->>Rec: lastVoiceMs()
            end
            App->>App: im lặng > 700ms → chốt endMs
            App-->>U: state = ready (mở lại nút)
            App->>Rec: sliceToWav()
            App->>S3: POST → BE: xác nhận key (như nhánh trên)
        end

        App->>OAI: response.create {conversation:"none"} — xin gợi ý chip (mục 5)
    end
```

**Vì sao không dùng `MediaRecorder.start()/stop()` theo từng lượt (và trên mobile là
`AVAudioRecorder` / `MediaRecorder`):** recorder khởi động chậm hơn tiếng nói ~100–200ms nên luôn
cụt đầu câu. Thay vào đó ghi PCM 16kHz **liên tục** vào ring buffer, cắt sau bằng timestamp.

---

## 4. Nhánh gõ chữ (không nói)

Đường này không đi qua transcribe nào cả — miễn nhiễm với chuyện nghe sót. Đổi lại lượt này
không được chấm phát âm.

```mermaid
sequenceDiagram
    autonumber
    actor U
    participant App
    participant RTC
    participant OAI
    participant BE

    U->>App: Gõ câu + gửi
    App->>App: seq++, hiện bubble user ngay
    App->>App: releaseHintsSlot()
    App->>RTC: conversation.item.create<br/>{role:"user", content:[{type:"input_text"}]}
    App->>RTC: response.create
    App-->>U: state = thinking
    App->>BE: POST /messages {seq, role:"user", text}
    Note right of App: Không upload WAV → lượt này<br/>không có điểm phát âm
    OAI-->>App: response.created → … → response.done (như mục 3)
```

---

## 5. Hai kênh gợi ý

```mermaid
sequenceDiagram
    autonumber
    actor U
    participant App
    participant RTC
    participant OAI
    participant BE

    rect rgb(240, 248, 240)
        Note over App,OAI: Kênh 1 — chip gợi ý trên màn hình (tự động sau mỗi lượt AI)
        App->>RTC: response.create {<br/>  conversation:"none",<br/>  output_modalities:["text"],<br/>  metadata:{purpose:"hints"}<br/>}
        Note right of App: conversation:"none" → model đọc được<br/>ngữ cảnh nhưng KHÔNG chèn thêm lượt nói
        OAI-->>App: response.created (ghi nhớ hintsResponseId)
        OAI-->>App: response.done → JSON ["...", "..."]
        App-->>U: 2 chip gợi ý
    end

    rect rgb(255, 248, 240)
        Note over U,BE: Kênh 2 — gợi ý bằng giọng (user chủ động bấm 💡)
        U->>App: Bấm 💡
        App->>App: hintLevel = min(3, hintLevel + 1)
        App->>BE: POST /api/sessions/:id/hint (đếm để hiện ở tổng kết)
        App->>RTC: response.create {instructions: HINT_INSTRUCTIONS[level]}
        Note right of App: Nấc 1: gợi nhẹ, hỏi lại đơn giản hơn<br/>Nấc 2: cho khung câu, để user tự hoàn thành<br/>Nấc 3: đọc nguyên một câu mẫu
        OAI-->>App: AI nói ra loa (như một lượt bình thường)
        Note over App: Nói được ≥ 3 từ ở lượt sau → hintLevel reset về 0
    end

    Note over App,OAI: Ưu tiên: user bấm nút khi gợi ý đang chạy<br/>→ response.cancel(hintsResponseId).<br/>Session chỉ cho MỘT response chạy một lúc.
```

---

## 6. Điểm dừng: model đề xuất, client mới chốt

Ba lớp, cố ý không giao hết cho model.

```mermaid
sequenceDiagram
    autonumber
    participant OAI as Model
    participant App
    participant BE as Backend
    actor U as Người học

    OAI-->>App: response.function_call_arguments.done<br/>name = "mark_objective"<br/>{objective_id, status, evidence}
    App->>App: progress.set(objectiveId, record)  ← client giữ checklist THẬT
    App-->>U: tick mục tiêu trên UI
    App->>BE: POST /api/sessions/:id/progress
    BE->>BE: validate objectiveId thuộc bài học này
    BE-->>App: {progress[]}

    App->>App: maybeOfferFinish()
    alt Đủ objectives.required = done VÀ seq >= lesson.minTurns
        App-->>U: bật nút "Kết thúc" 🎉
    else Chưa đủ
        App-->>U: giữ nguyên, học tiếp
    end

    App->>OAI: conversation.item.create {function_call_output, {ok:true}}
    Note right of App: KHÔNG gọi response.create —<br/>model đã nói xong trong chính lượt này

    opt Model chủ động xin dừng
        OAI-->>App: function_call "end_lesson" {reason, closing_note}
        App-->>U: chỉ BẬT nút. User mới là người bấm.
    end
```

---

## 7. Reconnect (rất quan trọng với mobile)

Web mất mạng là chuyện hiếm. Mobile thì đi thang máy, chuyển Wi-Fi ↔ 4G, tàu điện ngầm — luồng này
sẽ chạy thường xuyên hơn nhiều.

```mermaid
sequenceDiagram
    autonumber
    participant RTC
    participant App
    participant BE as Backend
    participant OAI as OpenAI
    actor U

    RTC-->>App: onconnectionstatechange = failed / disconnected
    App->>App: state = locked, xoá pendingUser / activeResponse
    App-->>U: "Đang kết nối lại…"

    loop attempt 1..5 — backoff 0.8s, 2s, 4s, 8s, 15s
        App->>App: sleep(backoff[attempt])
        App->>BE: POST /api/sessions/:id/token {resume:true}

        alt 429 quota_exhausted
            BE-->>App: 429
            App-->>U: "Hết thời lượng hôm nay" — DỪNG HẲN, không retry
            Note right of App: Retry lúc này chỉ hiện sai nguyên nhân<br/>cho user suốt 30 giây backoff
        else OK
            BE->>BE: buildResumeContext(lesson, messages, progress)
            Note right of BE: KHÔNG replay toàn bộ lịch sử.<br/>Lượt cũ → nén thành tóm tắt nhét vào instructions.<br/>6 lượt gần nhất → trả về seedItems.<br/>Kèm progress để AI không bắt làm lại mục tiêu đã đạt.
            BE-->>App: {clientSecret, seedItems[], progress[]}
            App->>RTC: PeerConnection MỚI (mục 2)
            App->>BE: POST /call {callId mới}
            App->>BE: mở lại SSE presence
            loop mỗi seedItem (cách nhau 30ms)
                App->>OAI: conversation.item.create {role, text}
            end
            Note over App,OAI: KHÔNG gọi response.create sau khi seed.<br/>Push-to-talk: quyền mở lời vẫn thuộc về user.
            App-->>U: state = ready, "Đã kết nối lại"
        end
    end

    opt Hết 5 lần vẫn thất bại
        App-->>U: "Không kết nối lại được. Bài học đã lưu,<br/>bạn có thể kết thúc để xem tổng kết."
    end
```

> **Audio của message cũ không nạp lại được vào session realtime mới — chỉ nạp text.**
> Không sao: audio cũ vẫn nằm nguyên trong DB để phát lại ở màn tổng kết.

---

## 8. Kết thúc + chấm điểm

```mermaid
sequenceDiagram
    autonumber
    actor U
    participant App
    participant RTC
    participant BE as Backend
    participant DB
    participant GT as Grader text (gpt-4o)
    participant GA as Grader audio (gpt-4o-audio-preview)

    U->>App: Bấm "Kết thúc"

    rect rgb(245, 245, 255)
        Note over App,BE: stop() — tách khỏi chấm điểm để chấm hỏng còn retry được
        App->>App: đóng SSE presence
        App->>RTC: close() (closing=true → KHÔNG kích hoạt reconnect)
        App->>BE: POST /api/calls/:callId/end
        BE->>DB: endCall(reason:"client") — trừ giờ ngay, không đợi hết ân hạn
        App->>App: await Promise.allSettled(pendingUploads)<br/>race với timeout 5s
        Note right of App: Trước là sleep(400ms) — một con số đoán.<br/>Đường S3 có hai chặng (POST bucket rồi confirm)<br/>cộng retry nên không đoán nổi nữa; đợi đúng<br/>hàng đợi, kèm trần cứng để mạng chết không<br/>treo màn tổng kết.
        App->>App: stop recorders, stop mic tracks, close AudioContext
        Note over App: MOBILE: deactivate AVAudioSession /<br/>abandonAudioFocus, nếu không thì<br/>nhạc nền của app khác không quay lại được
    end

    App-->>U: "Đang chấm điểm…"
    App->>BE: POST /api/sessions/:id/end {reason}
    BE->>DB: listMessages() + listProgress()

    par Promise.allSettled — hỏng một nhánh vẫn còn nhánh kia
        BE->>GT: transcript + rubric → structured output JSON
        GT-->>BE: {grammar, vocabulary, fluency, objectives, errors[]}
    and
        BE->>GA: các file WAV của user (raw audio)
        GA-->>BE: {pronunciation, errors[] có message_seq}
        Note right of GA: Chấm phát âm từ transcript text là không<br/>đáng tin — ASR đã "sửa hộ" người học rồi
    end

    BE->>DB: endSession(id, reason, summary)
    BE-->>App: {summary}
    App-->>U: Màn tổng kết

    U->>App: Bấm vào một lỗi
    App->>BE: GET /audio/:sessionId/:seq-user.wav
    Note right of App: Mỗi lỗi gắn message_seq → nghe lại đúng câu đó
```

---

## 9. Cưỡng chế hạn mức — 3 lớp độc lập

Hỏng một lớp vẫn còn hai lớp kia. **Lớp 3 phải CẮT chứ không được chỉ "ngừng đếm"**: kênh presence
và cuộc gọi WebRTC là hai kết nối độc lập — nếu mất presence chỉ làm đồng hồ dừng lại thì một app
sửa vài dòng có thể đóng presence mà vẫn giữ WebRTC chạy, thành ra gọi miễn phí vô hạn.
Trên mobile chuyện này còn dễ hơn web (app đã ở trên máy người dùng). Không tin, mà cắt.

```mermaid
sequenceDiagram
    autonumber
    participant App
    participant BE as Backend
    participant OAI as OpenAI

    rect rgb(255, 240, 240)
        Note over App,BE: Lớp 1 — từ chối cấp token
        App->>BE: POST /token
        BE-->>App: 429 quota_exhausted → không bắt tay WebRTC được
    end

    rect rgb(255, 245, 235)
        Note over App,OAI: Lớp 2 — hẹn giờ cắt cứng
        App->>BE: POST /call {callId}
        BE->>BE: setTimeout(remainingMs) → hangup(callId, "quota")
        BE->>OAI: POST /v1/realtime/calls/:callId/hangup
        BE-->>App: SSE event: ended {reason:"quota"}
        App->>App: ended = true, KHÔNG reconnect
    end

    rect rgb(240, 240, 255)
        Note over App,BE: Lớp 3 — mất presence thì cắt
        App--xBE: SSE đứt (kill app / mất mạng / màn hình khoá lâu)
        BE->>BE: onPresenceLost → ân hạn 15s
        alt Nối lại kịp trong 15s
            App->>BE: GET /presence (EventSource tự retry)
            BE->>BE: onPresenceBack → huỷ ân hạn
        else Quá 15s
            BE->>OAI: hangup(callId, "gone")
        end
    end

    Note over BE: Server restart mất hết setTimeout,<br/>nhưng mốc thời gian vẫn nằm trong DB<br/>→ reschedulePendingCalls() dựng lại chuông
```

---

## 10. Vòng đời riêng của mobile app

Ba tình huống web không có. Đây là phần **phải viết thêm** khi port sang mobile.

```mermaid
sequenceDiagram
    autonumber
    actor U
    participant OS as iOS/Android
    participant App
    participant RTC
    participant BE as Backend

    rect rgb(255, 250, 235)
        Note over OS,BE: A. Cuộc gọi đến / Siri / báo thức
        OS-->>App: AVAudioSession interruption .began<br/>(Android: AUDIOFOCUS_LOSS_TRANSIENT)
        App->>RTC: setMicEnabled(false)
        App->>App: state = locked, huỷ lượt PTT đang ghi
        App-->>U: "Tạm dừng vì có cuộc gọi"
        OS-->>App: interruption .ended {shouldResume}
        App->>App: activate lại AVAudioSession
        App-->>U: state = ready
        Note right of App: Nếu OS đã giết PeerConnection<br/>→ rơi vào luồng reconnect (mục 7)
    end

    rect rgb(240, 248, 255)
        Note over OS,BE: B. App vào background
        U->>OS: Vuốt về home / khoá màn hình
        OS-->>App: applicationDidEnterBackground
        alt Muốn học tiếp khi tắt màn hình (khuyến nghị)
            App->>OS: UIBackgroundModes: audio (iOS)<br/>ForegroundService type=microphone (Android)
            Note right of App: Không có mục này thì iOS treo WebRTC<br/>sau vài giây và Android 14+ chặn thẳng mic
            App->>BE: SSE presence vẫn giữ → không bị cắt
        else Không hỗ trợ nền
            App->>App: chủ động finish("backgrounded")
            App->>BE: POST /api/calls/:callId/end
            Note right of App: Cắt sạch còn hơn để user bị<br/>trừ giờ trong lúc không học
        end
    end

    rect rgb(245, 255, 245)
        Note over OS,BE: C. Đổi mạng Wi-Fi ↔ 4G
        OS-->>App: NWPathMonitor / ConnectivityManager: network changed
        RTC-->>App: connectionState = disconnected
        App->>App: bỏ backoff đầu, thử reconnect NGAY
        Note right of App: Đã biết chắc lý do rồi thì không cần<br/>đợi 800ms như trường hợp mất mạng mù
        App->>BE: POST /token {resume:true} → mục 7
    end
```

---

## 11. Lưu trữ audio: client tự đẩy thẳng lên S3

`AUDIO_STORE=disk` (mặc định) giữ nguyên luồng cũ: WAV đi xuyên qua backend rồi nằm ở
`data/audio/`. Phần dưới mô tả `AUDIO_STORE=s3`.

Nguyên tắc: **cấp quyền ghi một lần cho cả buổi, không ký lại từng file.** Presigned PUT ký gắn chết
vào một key cụ thể nên mỗi lượt nói phải hỏi server xin URL mới — thêm một round-trip ngay trên
đường nóng sau mỗi câu, và URL ngắn hạn thì background upload task của mobile gần như không kịp
dùng. Presigned POST ký theo **điều kiện** (`starts-with $key`) nên một chữ ký phủ hết buổi.

```mermaid
sequenceDiagram
    autonumber
    participant App
    participant BE as Backend
    participant S3 as S3 bucket
    participant CDN as CloudFront
    participant GA as Grader audio

    rect rgb(235, 244, 255)
        Note over App,S3: A. Ghi — mỗi lượt nói
        App->>BE: POST /token
        BE-->>App: … + uploadGrant (policy, hạn 2h)
        App->>App: cắt WAV, key = audio/:sid/:seq-role.wav
        App->>S3: POST FormData<br/>(key, các field ký…, file CUỐI CÙNG)
        Note right of App: file phải là field cuối — S3 ngừng đọc<br/>form ngay khi gặp nó
        S3-->>App: 204
        App->>BE: POST /messages/:seq/audio<br/>{key, bytes, durationMs}
        BE->>BE: dựng lại key từ (sid, seq, role) và đối chiếu
        BE-->>App: {audioUrl}
        Note over App: Chỉ báo lên UI SAU khi confirm xong —<br/>báo sớm thì nút nghe lại trỏ vào object<br/>server chưa biết
    end

    rect rgb(255, 245, 235)
        Note over BE,GA: B. Đọc — lúc chấm phát âm
        BE->>S3: GET (presigned, 5 phút)
        Note right of BE: Chịu lỗi TỪNG file: một đoạn hỏng thì bỏ<br/>đoạn đó, không kéo đổ cả khâu chấm phát âm.<br/>Prompt dựng SAU khi tải xong nên danh sách<br/>message_seq luôn khớp số clip thật sự gửi đi
        BE->>GA: các clip tải được
    end

    rect rgb(240, 248, 240)
        Note over App,CDN: C. Nghe lại ở màn tổng kết
        App->>BE: GET /api/sessions/:id
        BE-->>App: Set-Cookie: CloudFront-Policy / -Signature / -Key-Pair-Id<br/>Path=/audio/:sid/ — chỉ mở đúng buổi này
        App->>CDN: GET /audio/:sid/:seq-role.wav
        CDN->>S3: OAC (bucket đóng public hoàn toàn)
    end
```

**Hai lớp chặn khi ghi, cố ý không tin client:**

| Lớp | Ở đâu | Chặn gì |
|---|---|---|
| Policy | S3 kiểm | Ghi ra ngoài `audio/<sessionId>/`, file < 45B hoặc > 5MB, sai `Content-Type` |
| `verifyKey` | `audio-store.ts` | Gán file vào nhầm `seq` / `role` trong chính session của mình |

**Chuyện phải chấp nhận:** server không gọi `HeadObject` để kiểm tra object có thật hay không —
thêm một round-trip cho mỗi message chỉ để biết trước điều mà grader tự xử lý được. Đổi lại, một
message có thể mang `audio_path` trỏ vào object không tồn tại; khâu chấm điểm bỏ qua nó và ghi log.

**Nếu sau này đổi sang R2:** R2 hỗ trợ presigned PUT tốt nhưng POST policy thì hạn chế hơn — lúc đó
phải quay lại kiểu ký từng file.

---

## Khác biệt web ↔ mobile

Backend **không cần đổi gì** ngoài hai chỗ được đánh dấu ⚠️.

| Việc | Web (hiện tại) | Mobile app |
|---|---|---|
| Định danh thiết bị | ⚠️ Cookie `did` (httpOnly) | Cookie không tự nhiên trên native → gửi `Authorization: Bearer <token>` hoặc `X-Device-Id` lấy từ Keychain/Keystore. Backend đọc header trước, fallback cookie |
| Kết nối WebRTC | `RTCPeerConnection` của browser | libwebrtc: `RTCPeerConnection` (iOS ObjC/Swift), `PeerConnection` (Android). API gần như 1-1 |
| Data channel | `dc.send(JSON)` | như nhau — `RTCDataChannel.sendData(RTCDataBuffer)` |
| Phát audio AI | `<audio srcObject>` | libwebrtc tự phát qua AudioDeviceModule; chỉ cần cấu hình AVAudioSession / AudioManager |
| Ghi PCM để cắt WAV | 2× `AudioWorklet` (mic + remote) | iOS: `AVAudioEngine.inputNode` tap + `RTCAudioRenderer` cho remote track. Android: `JavaAudioDeviceModule.setSamplesReadyCallback` + `AudioTrackSink`. Cùng ý tưởng: ring buffer PCM 16kHz, cắt bằng timestamp |
| Echo cancellation | `getUserMedia {echoCancellation:true}` | Bật AEC cấp OS: `.voiceChat` mode (iOS) / `JavaAudioDeviceModule` builtin AEC+NS (Android). Quan trọng hơn web vì loa ngoài |
| Kênh presence | `EventSource` (tự retry) | Không có `EventSource` native → SSE thủ công (`URLSession.bytes` / OkHttp streaming) **và tự viết vòng retry**, hoặc đổi sang WebSocket. ⚠️ Nếu đổi WS thì backend thêm route |
| Upload WAV | `FormData` + `fetch` thẳng lên S3 | `URLSession.uploadTask(fromFile:)` / OkHttp `MultipartBody`, cũng thẳng lên S3. Nên dùng background upload task để đóng app giữa chừng vẫn đẩy nốt — grant sống 2h nên kịp |
| Nghe lại ở tổng kết | `<audio src>` + signed cookie (trình duyệt tự đính kèm) | Native không có cookie jar → backend ký thẳng vào URL khi request mang `X-Device-Id`. Cùng key pair, khác cơ chế |
| Quyền micro | Prompt của browser | Xin trước khi vào màn học, có màn giải thích + đường dẫn tới Settings khi bị từ chối vĩnh viễn |
| Vòng đời | Tab đóng là xong | Interruption, background, đổi mạng — xem mục 10 |

### Hai thay đổi backend cần cho mobile

1. **Định danh không phụ thuộc cookie** — `deviceId()` trong `server/index.ts` hiện chỉ đọc cookie
   `did`. Thêm nhánh đọc `X-Device-Id` / bearer token trước khi fallback về cookie. Hạn mức
   (`quotaFor(userId)`) và toàn bộ phần còn lại giữ nguyên.
2. **Static file `/audio/...`** (đường `disk`) vẫn phục vụ không kiểm tra chủ sở hữu. Web thì URL
   khó đoán, nhưng khi mobile phát audio qua player riêng nên chốt luôn: kiểm tra session thuộc về
   `deviceId` của request. Đường `s3` thì không còn vấn đề này — chữ ký ràng theo đúng một session.

### Có thể dùng lại nguyên xi

Toàn bộ `LessonSession` là logic thuần (state machine PTT, backoff, hint escalation, điểm dừng,
cắt/upload audio) — không đụng DOM. Nếu làm mobile bằng React Native / Flutter thì port gần như
copy; nếu native thì đây là bản đặc tả để viết lại trong Swift/Kotlin.
