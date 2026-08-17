# Biến môi trường — cấu hình vào hệ thống

Tài liệu này trả lời hai câu hỏi tách biệt nhau:

1. **Env đi vào tiến trình bằng đường nào** — local, Docker, ECS. Mục [1](#1-env-vào-tiến-trình-bằng-đường-nào).
2. **Cần đặt gì để bật từng tính năng** — và thiếu thì hỏng ra sao. Mục [3](#3-bốn-khối-tính-năng)
   trở đi.

Bám sát code hiện tại: `server/index.ts`, `server/s3.ts`, `server/polly.ts`, `server/sts.ts`,
`server/cdn.ts`, `server/db.ts`. Bảng tra nhanh nằm ở [README mục Cấu hình](../README.md#cấu-hình);
ở đây là phần *làm thế nào*.

> **Chỉ một biến bắt buộc: `OPENAI_API_KEY`.** Mọi biến còn lại hoặc có mặc định, hoặc tự tắt tính
> năng của nó. Nghĩa là `cp .env.example .env` + điền key là chạy được — chỉ có điều AI sẽ **không
> có tiếng nói** cho tới khi bật xong khối Polly ở [mục 3.2](#32-tiếng-nói-của-ai--polly--sts).

---

## 1. Env vào tiến trình bằng đường nào

Dự án **không dùng `dotenv`** — backend zero dependency, nên việc đọc file giao cho chính Node.

### Local

```bash
cp .env.example .env      # rồi điền
npm start                 # build.js + node --env-file-if-exists=.env server/index.ts
npm run dev               # như trên, thêm watch cho cả client và server
```

`--env-file-if-exists` (khác `--env-file`) nghĩa là **không có `.env` thì vẫn chạy**, không ngã ra.
Đây là điều kiện để container hoạt động: trong image không có `.env`, biến do Docker bơm thẳng vào
môi trường.

Ba hành vi của trình đọc này khác `dotenv`, đều đã kiểm chứng trên Node v24:

| Hành vi | Kết quả |
|---|---|
| Biến đã có sẵn trong shell | **Shell thắng file.** `PORT=4000 npm start` đè `PORT=3001` trong `.env` |
| `BAZ=$FOO/x` | Không có khai triển biến — giá trị đúng là chuỗi `$FOO/x` |
| `KEY="dòng 1\ndòng 2"` (xuống dòng thật, trong ngoặc kép) | Giữ nguyên nhiều dòng — quan trọng cho `CF_PRIVATE_KEY` |

Hành vi thứ nhất là con dao hai lưỡi: nó cho phép ghi đè tạm một biến cho đúng một lần chạy
(`DAILY_QUOTA_MS=3600000 npm start`), nhưng cũng khiến một biến rớt lại trong shell profile âm thầm
thắng file `.env` mà không báo gì.

### Docker Compose

`docker-compose.yml` khai `env_file: .env` — file **không** nằm trong image (`.dockerignore` loại
`.env` ra), Compose đọc nó ở máy host lúc `up` rồi bơm vào container.

```bash
make dev            # build + push :dev lên ECR
docker compose up   # đọc .env cạnh docker-compose.yml
```

**Lưu ý `PORT`.** Compose đặt `environment: PORT: "3000"`, và khối `environment` **thắng**
`env_file`. Nên `PORT=3001` trong `.env` chỉ có tác dụng khi chạy `npm start` ở máy, chạy Docker thì
vẫn là 3000. Đây là cố ý: cổng bên trong container cố định, cổng bên ngoài đổi ở dòng `ports`.

### ECS / EC2 / nơi khác

Đừng mang `.env` lên server. Tách theo mức nhạy cảm:

| Loại biến | Đặt ở đâu trong task definition |
|---|---|
| `OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `CF_PRIVATE_KEY` | `secrets` → Secrets Manager / SSM Parameter Store |
| Còn lại (`PORT`, `POLLY=on`, `S3_BUCKET`, `POLLY_STS_ROLE_ARN`…) | `environment`, đọc thẳng được |

Chạy trên EC2/ECS bằng **IAM role** thay vì access key thì đặt thêm `AWS_SESSION_TOKEN` — cả ba
đường S3, Polly và STS đều tự thêm header `x-amz-security-token` khi thấy biến này
(`s3.ts:43`, `sts.ts:77`).

Lưu ý `data/` là volume: `db.ts` gọi `mkdirSync` lúc import và Dockerfile đã `chown` sẵn cho user
`node`. Mount đè lên bằng volume của host thì phải giữ đúng chủ sở hữu, không thì server chết ngay
lúc import chứ không phải lúc ghi file đầu tiên.

---

## 2. Ai đọc biến nào

Để biết sửa một biến thì đi xem chỗ nào.

| Khối | File đọc env | Thiếu biến thì sao |
|---|---|---|
| Bắt buộc | `index.ts:36` | **`process.exit(1)`** kèm hướng dẫn |
| Model, cổng | `index.ts`, `grader.ts` | rơi về mặc định |
| Hạn mức | `db.ts:316,319` | rơi về 5 phút/ngày, GMT+7 |
| S3 | `s3.ts:35` → `s3ConfigFromEnv` | **throw lúc khởi động** nếu bật mà thiếu |
| CDN | `cdn.ts:38` → `cdnConfigFromEnv` | không domain = tắt; domain trần = public; **throw** nếu chỉ có nửa key pair |
| Polly | `polly.ts:37` → `pollyConfigFromEnv` | **throw** nếu `on` mà không có region |
| Credential Polly | `sts.ts` → `pollyCredsFromEnv` | không có khoá = tắt tiếng; có khoá + role = STS; có khoá không role = đường thẳng; **throw** nếu có role mà thiếu khoá |

Nguyên tắc chung: **bật một tính năng nửa vời thì ngã ra ngay lúc khởi động**, không đợi tới lúc
người học nói xong câu đầu tiên mới phát hiện. Còn **không bật** thì im lặng rơi về mặc định. Một
ngoại lệ có chủ ý: `POLLY=on` mà thiếu `POLLY_STS_ROLE_ARN` chỉ `console.warn` rồi chạy tiếp
(`index.ts:129`) — tiếng nói là tính năng phụ, không phải đường sống.

---

## 3. Bốn khối tính năng

### 3.1. Chạy tối thiểu

```dotenv
OPENAI_API_KEY=sk-...
```

Xong. Audio nằm ở `data/audio/`, AI hiện chữ không có tiếng, hạn mức 2 tiếng/ngày/thiết bị.

2 tiếng là mức để **test**. Trước khi mở cho người ngoài thì kéo xuống — nhất là vì mode giọng
OpenAI đắt gấp ~2 lần mode Polly:

```dotenv
DAILY_QUOTA_MS=300000      # 5 phút
```

`QUOTA_TZ_OFFSET_MS` là mốc cắt ngày, mặc định `25200000` (GMT+7). Đổi khi người dùng ở múi giờ
khác, không thì nửa đêm của họ không phải lúc hạn mức reset.

### 3.2. Tiếng nói của AI — Polly

Client tự ký và gọi thẳng Polly, không qua backend, vì khúc đầu tiên của mỗi lượt là toàn bộ độ trễ
người dùng cảm thấy (chi tiết ở [`lip-sync.md`](lip-sync.md)). Hệ quả không tránh được: **credential
phải xuống tới browser.** Có hai đường, chọn bằng việc có đặt `POLLY_STS_ROLE_ARN` hay không.

| | Đường thẳng (không role) | Đường STS (có role) |
|---|---|---|
| Client cầm gì | chính credential của backend | credential tạm của `AssumeRole` |
| Hạn | không — `expiresAt` chỉ là hạn bịa | thật, ≤ 1 giờ |
| Ràng IP | không | `aws:SourceIp` theo đúng máy đó |
| Quyền | đủ quyền của IAM user đó | chỉ `polly:SynthesizeSpeech` |
| Dùng cho | demo | production |

#### Đường thẳng — dựng nhanh, không cần IAM role

```dotenv
POLLY=on
POLLY_REGION=ap-southeast-1          # bỏ trống thì lấy theo S3_REGION
AWS_ACCESS_KEY_ID=AKIA...            # dùng chung với S3, không khai hai lần
AWS_SECRET_ACCESS_KEY=...
```

Hết — không cần role, không cần trust policy. Backend đóng gói thẳng cặp khoá này vào `pollyGrant`
gửi xuống client (`sts.ts` → `directCreds`), và grant đi xuống **không có** `sessionToken`.

Server in một dòng `[polly] Khong co POLLY_STS_ROLE_ARN — dua thang credential AWS...` mỗi lần khởi
động. Nó cố ý không tắt được: khoá này lộ ra là ai cũng gọi được Polly trên hoá đơn của bạn, và
nếu IAM user đó còn quyền S3 thì mất luôn cả quyền đó. Với một demo thì đây là đánh đổi hợp lý; chỉ
cần nó là đánh đổi *nhìn thấy được*.

Muốn thu hẹp mà vẫn không dựng role: tạo riêng một IAM user chỉ có `polly:SynthesizeSpeech` và dùng
khoá của user đó. Nhưng khi đó `AWS_ACCESS_KEY_ID` cũng là khoá mà S3 dùng chung — nên chỉ làm được
khi `AUDIO_STORE=disk`.

#### Đường STS — cho production

Thêm `POLLY_STS_ROLE_ARN` vào là chuyển đường, không phải sửa gì khác.

**Bước 1 — permission policy của role.** Chỉ đúng một quyền:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "polly:SynthesizeSpeech", "Resource": "*" }
  ]
}
```

Đừng thêm gì vào đây cho "tiện". Session policy mà `sts.ts:120` gắn kèm chỉ **thu hẹp** — nó giao
với policy của role chứ không cộng vào — nên mọi thứ dư ra ở đây là dư ra thật.

**Bước 2 — trust policy.** Cho đúng cái IAM user của `AWS_ACCESS_KEY_ID` được đóng vai:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::123456789012:user/ai-learn-backend" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

Ghi thẳng ARN của user, đừng ghi `:root`: cùng tài khoản thì trust policy trỏ đích danh user là đủ,
còn trỏ `root` nghĩa là mọi principal trong tài khoản đều có cửa và bạn phải đi cấp thêm
`sts:AssumeRole` ở phía user.

**Bước 3 — env:**

```dotenv
POLLY=on
POLLY_REGION=ap-southeast-1          # bỏ trống thì lấy theo S3_REGION
AWS_ACCESS_KEY_ID=AKIA...            # dùng chung với S3, không khai hai lần
AWS_SECRET_ACCESS_KEY=...
POLLY_STS_ROLE_ARN=arn:aws:iam::123456789012:role/ai-learn-polly-client
```

**`POLLY_VOICE` và `POLLY_ENGINE` gần như không còn tác dụng.** Giọng thật lấy từ
`server/characters/*.json` (Leo=Joanna, Marco=Matthew…), và người học đổi được ngay trên màn học —
lựa chọn đó nằm trong `localStorage` của họ. Hai biến này chỉ là phương án cuối cho trường hợp
không biết nhân vật nào.

`POLLY_ENGINE` **không nhận `generative`** — engine đó không trả speech marks, mà không có speech
marks thì không có viseme, tức là mất luôn phần nhép mồm. `polly.ts:41` chặn thẳng lúc khởi động.

Hai biến còn lại là dây an toàn, và **chỉ có tác dụng ở đường STS**:

| Biến | Mặc định | Khi nào phải động vào |
|---|---|---|
| `POLLY_STS_TTL_SEC` | `3600` | AWS chặn cứng trong `900..3600`; giá trị ngoài khoảng bị kẹp lại chứ không lỗi. Một buổi học ngắn hơn nhiều nên ký một lần là đủ cả buổi |
| `POLLY_STS_BIND_IP` | `on` | **Tắt** khi backend nằm sau reverse proxy không đặt `X-Forwarded-For` |

Về `POLLY_STS_BIND_IP`: bật thì credential bị ràng vào IP client bằng `aws:SourceIp`, lấy đi cũng
chỉ dùng được từ đúng máy đó. Nhưng sau một proxy không đặt `X-Forwarded-For` thì mọi người đều
chung một IP nội bộ — ràng vào vừa không chặn được ai, vừa làm credential chết oan khi topology
đổi. Code đã tự bỏ qua dải loopback và private (`sts.ts:103`), nên chạy local không cần tắt.

Ở đường thẳng thì không có session policy nào để ràng, nên `POLLY_STS_BIND_IP` không làm gì; còn
`POLLY_STS_TTL_SEC` chỉ quyết định con số `expiresAt` bịa ra để client giữ nguyên vòng xin lại —
xin lại chỉ nhận về đúng cặp khoá cũ.

**Đổi Wi-Fi ↔ 4G giữa buổi là 403.** Không phải lỗi cấu hình, và chỉ xảy ra ở đường STS: client xin
lại qua `POST /api/sessions/:id/polly`.

### 3.3. Lưu audio lên S3

```dotenv
AUDIO_STORE=s3
S3_REGION=ap-southeast-1
S3_BUCKET=ai-learn-audio
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

Bốn biến dưới là bắt buộc khi `AUDIO_STORE=s3` — thiếu cái nào server cũng liệt kê ra rồi thoát
(`s3.ts:52`). Bật giữa chừng không mất dữ liệu cũ: mỗi message ghi kèm `audio_store` của chính nó
nên hai kiểu lưu sống chung được.

Client `POST` thẳng lên bucket nên **bucket phải có CORS** cho `POST` từ origin của app. Đây là thứ
env không nói hộ được và cũng không lộ ra lúc khởi động — nó lộ ra ở console của browser.

Dev bằng MinIO thì không cần tài khoản AWS:

```bash
npm run test:s3    # dựng MinIO qua compose profile dev, tự đặt S3_ENDPOINT
```

`S3_ENDPOINT` có giá trị thì URL đổi sang path-style (`endpoint/bucket/key`). Trỏ vào S3 thật thì để
trống. Không có nó, các test S3 tự skip — nên `npm test` xanh **không** chứng minh S3 chấp nhận chữ
ký của mình, chỉ chứng minh mình ký ra đúng chuỗi đó.

### 3.4. CDN phát lại qua CloudFront

Bỏ trống cả khối thì vẫn nghe lại được, chỉ là mỗi file một presigned GET riêng thẳng từ S3. Bật CDN
thì có **hai chế độ**, chọn bằng việc có khai key pair hay không:

#### Distribution public — chỉ một biến

```dotenv
CDN_DOMAIN=media.example.com
```

Hết. Behavior của distribution không gắn trusted key group thì không có gì để ký: `playbackUrl` trả
URL trần, `playbackCookies` trả rỗng. Server log một dòng `[audio] CDN_DOMAIN khong kem key pair`
để chế độ này là một lựa chọn nhìn thấy được chứ không phải mặc định âm thầm.

Đánh đổi, nêu một lần: đây là đường phát lại duy nhất **không có hạn sử dụng**. Chế độ ký cho chữ ký
sống 1 tiếng và bó theo đúng một session (`Path=/audio/<sessionId>/`, `cdn.ts:88`); public thì một
link lộ ra là lộ hẳn file đó, vĩnh viễn. Rào chắn còn lại chỉ là `sessionId` = `randomUUID()` —
122 bit, không đoán được, nhưng cũng chỉ có thế.

Bucket **vẫn đóng** ở cả hai chế độ: CloudFront đọc S3 qua OAC. "Public" ở đây là public ở tầng
CloudFront, không phải mở bucket. Đường upload cũng không đổi — client vẫn `POST` thẳng vào S3 bằng
presigned POST, không đi qua CloudFront.

#### Distribution có ký — thêm cả hai biến

```dotenv
CDN_DOMAIN=media.example.com
CF_KEY_PAIR_ID=K2JCJMDEHXQW5F
CF_PRIVATE_KEY_PATH=/run/secrets/cloudfront-private-key.pem
```

**Đặt một nửa thì server ngã ra lúc khởi động** (`cdn.ts:53`), không tụt về URL trần. Gõ nhầm tên
biến hay secret chưa mount kịp đều rơi vào đây; tụt về URL trần nghĩa là một distribution *có* ký
lại im lặng phát URL không ký, và triệu chứng sẽ là 403 ở tận trình duyệt người học.

**CDN phải cùng site với app** — `app.example.com` + `media.example.com` thì được, hai domain khác
nhau hẳn thì trình duyệt không đính kèm signed cookie và mọi request đều 403. Ràng buộc này chỉ áp
cho chế độ ký; public thì không có cookie nào để đính kèm.

Mobile (`signed = true`) ở chế độ public nhận URL trần chứ không phải lỗi — với nó thì đó vẫn là một
URL phát được, và đó mới là thứ nó cần.

#### Khoá nhiều dòng

`CF_PRIVATE_KEY` và `CF_PRIVATE_KEY_PATH` — đặt **một** trong hai, `CF_PRIVATE_KEY` được ưu tiên
(`cdn.ts:29`). Chọn cái nào tuỳ nơi chạy:

| Nơi chạy | Nên dùng | Vì sao |
|---|---|---|
| Local | `CF_PRIVATE_KEY_PATH` | trỏ vào file `.pem` tải về, không phải nhồi khoá vào một dòng |
| Docker Compose | `CF_PRIVATE_KEY_PATH` + mount file vào | giá trị nhiều dòng đi qua `env_file` của Compose không chắc nguyên vẹn |
| ECS | `CF_PRIVATE_KEY` qua `secrets` | Secrets Manager giữ nguyên xuống dòng, không phải mount gì |

Nếu buộc phải nhét vào `.env`, nhớ rằng Node giữ nguyên xuống dòng **thật** trong ngoặc kép, nhưng
**không** dịch `\n` thành xuống dòng:

```dotenv
CF_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEow...
-----END RSA PRIVATE KEY-----"
```

---

## 4. Kiểm tra sau khi đặt

Server nói khá nhiều lúc khởi động — đọc log là biết khối nào đang bật:

```bash
npm start
```

| Thấy dòng này | Nghĩa là |
|---|---|
| `Thieu OPENAI_API_KEY` rồi thoát | chưa có `.env`, hoặc `npm start` chạy ở thư mục khác |
| `[polly] POLLY=on nhung thieu AWS_ACCESS_KEY_ID...` | AI sẽ hiện chữ mà không có tiếng |
| `[polly] Khong co POLLY_STS_ROLE_ARN — dua thang credential...` | đang chạy đường thẳng: khoá dài hạn nằm trong browser |
| `[audio] AUDIO_STORE=s3 nhung khong co CDN_DOMAIN` | bình thường — phát lại bằng presigned GET |
| `[audio] CDN_DOMAIN khong kem key pair` | đang chạy chế độ CDN public, URL trần không hạn |
| `Co CDN_DOMAIN va mot nua key pair` rồi thoát | đặt nốt nửa còn lại, hoặc bỏ trống **cả hai** để chạy public |
| `AUDIO_STORE=s3 nhung thieu: ...` rồi thoát | thiếu đúng những biến nó liệt kê |
| `POLLY_STS_ROLE_ARN da dat nhung thieu...` rồi thoát | có role ARN nhưng chưa có `AWS_ACCESS_KEY_ID`/`SECRET` để đóng vai |
| `[polly] khong cap duoc credential tam: STS tra ve 403` | env đủ rồi, sai ở **IAM** — xem [3.2](#32-tiếng-nói-của-ai--polly--sts) |

Không dòng nào trong số đó bắt được lỗi phía trình duyệt. Ba thứ chỉ lộ ra ở DevTools console:

- **CORS của bucket** cho `POST` (khối S3) và **CORS của Polly** cho preflight `OPTIONS` (khối Polly).
- **`crypto.subtle` là `undefined`.** Nó chỉ tồn tại trong secure context: `http://localhost` được
  tính là secure, `http://192.168.x.x` **không**. Mở app trên điện thoại cùng LAN qua IP thì client
  không ký được gì cả — triệu chứng là `undefined`, không phải lỗi chữ ký. Muốn test trên máy thật
  thì cần HTTPS hoặc một tunnel.

---

## 5. Bẫy đã gặp

| Triệu chứng | Nguyên nhân |
|---|---|
| Đổi `.env` mà không thấy gì đổi | biến đó đang có sẵn trong shell — **shell thắng file**. `env \| grep TÊN_BIẾN` |
| `PORT` trong `.env` bị lờ đi khi chạy Docker | `docker-compose.yml` đặt `environment: PORT: "3000"`, khối đó thắng `env_file` |
| AI vẫn không có tiếng dù `POLLY=on` | thiếu `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. Chỉ warn chứ không chặn khởi động |
| `POLLY_ENGINE=generative` → chết lúc khởi động | engine đó không trả speech marks nên không có viseme. Dùng `neural` |
| Credential Polly chết giữa buổi | `POLLY_STS_BIND_IP=on` + người học đổi mạng. Client tự xin lại; nếu lặp lại liên tục thì backend đang sau proxy không đặt `X-Forwarded-For` → tắt biến này |
| `$BIẾN_KHÁC` trong `.env` không nở ra | Node không khai triển biến. Viết giá trị đầy đủ |
| Hạn mức hết giữa buổi test | mặc định `DAILY_QUOTA_MS` là 2 tiếng/ngày/thiết bị — nới thêm bằng chính biến đó |
