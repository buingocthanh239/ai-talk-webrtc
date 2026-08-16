/**
 * Goi Amazon Polly THANG tu browser, tu ky SigV4.
 *
 * Cung thuat toan voi `server/polly.ts`, chi khac node:crypto -> WebCrypto nen
 * moi buoc deu async. Backend chi cap credential (xem `server/sts.ts`: tam qua
 * STS, hoac dai han neu dang chay che do demo) roi dung ngoai duong audio hoan
 * toan.
 *
 * MOT CHO SE LAM MAT NUA BUOI NEU KHONG BIET TRUOC:
 *
 *   `crypto.subtle` chi ton tai trong secure context. `http://localhost` co,
 *   nhung `http://192.168.x.x` thi KHONG — mo tren dien thoai cung mang LAN se
 *   thay `crypto.subtle` la undefined chu khong phai loi chu ky. Phai co https
 *   hoac tunnel.
 */

import { parseSpeechMarks, type VisemeFrame } from "../../shared/viseme.ts";
import type { PollyGrant, PollyEngine } from "../../shared/types.ts";

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "polly";
const SPEECH_PATH = "/v1/speech";

/** Mot khuc doc lau hon nguong nay thi bo — khong duoc de hang doi treo. */
const TIMEOUT_MS = 10_000;
/** Polly throttle theo TPS cua ca account, nen 429 la chuyen co that. */
const RETRY_MS = [200, 600];

const enc = new TextEncoder();

export class PollyError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// ------------------------------------------------------------------ ky

async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(data)));
}

/** kSigning = HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request") */
async function signingKey(
  secret: string,
  date: string,
  region: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(enc.encode(`AWS4${secret}`), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

/** `20130524T000000Z` va `20130524` */
function stamps(at: number): { amzDate: string; date: string } {
  const amzDate = new Date(at).toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, date: amzDate.slice(0, 8) };
}

const host = (region: string): string => `polly.${region}.amazonaws.com`;

async function signedHeaders(
  grant: PollyGrant,
  body: string,
  at: number,
): Promise<Record<string, string>> {
  const { amzDate, date } = stamps(at);
  const scope = `${date}/${grant.region}/${SERVICE}/aws4_request`;

  // Credential tam cua STS luon co session token, va khi co thi
  // `x-amz-security-token` BAT BUOC nam trong SignedHeaders — thieu no la 403
  // khong noi ly do. Con credential dai han thi khong co token nao: gui header
  // rong cung la 403, nen no phai vang mat han chu khong phai bang chuoi rong.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: host(grant.region),
    "x-amz-date": amzDate,
    ...(grant.sessionToken
      ? { "x-amz-security-token": grant.sessionToken }
      : {}),
  };
  const names = Object.keys(headers).sort();
  const signedNames = names.join(";");

  const canonicalRequest = [
    "POST",
    SPEECH_PATH,
    "",
    names.map((n) => `${n}:${headers[n]}`).join("\n") + "\n",
    signedNames,
    await sha256Hex(body),
  ].join("\n");

  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = toHex(
    await hmac(
      await signingKey(grant.secretAccessKey, date, grant.region),
      stringToSign,
    ),
  );

  return {
    "Content-Type": "application/json",
    "X-Amz-Date": amzDate,
    ...(grant.sessionToken
      ? { "X-Amz-Security-Token": grant.sessionToken }
      : {}),
    Authorization:
      `${ALGORITHM} Credential=${grant.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedNames}, Signature=${signature}`,
  };
}

// ------------------------------------------------------------------ goi

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * MOI luc chi mot request Polly duoc di. Day khong phai cho lich su.
 *
 * Endpoint HTTP/2 cua Polly bao `SETTINGS_MAX_CONCURRENT_STREAMS = 1` — mot
 * stream mot luc, khong hon. Ma trinh duyet thi gom ca origin vao MOT ket noi
 * h2 dung chung. Ban hai request cung luc la AWS giet CA KET NOI, keo theo moi
 * request dang di tren do:
 *
 *     net::ERR_SOCKET_NOT_CONNECTED
 *     net::ERR_CONNECTION_CLOSED
 *
 * Do trong Chrome tren dung endpoint nay: 6 request song song hong 41/48, cung
 * 6 request do ma noi tiep nhau thi hong 0/48.
 *
 * Cai bay o day la no KHONG giong loi so luong. Retry lam moi thu te hon: ca
 * chum cung hong, roi cung thu lai mot luc, thanh mot chum moi y het chum vua
 * giet ket noi. Ba luot deu chet, va nhin ra ngoai thi giong het "mang chap
 * chon" chu khong giong mot rang buoc cua giao thuc.
 */
let gate: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
  // `then(task, task)` chu khong phai `then(task)`: mot khuc hong khong duoc
  // khoa vinh vien cai cua cho nhung khuc sau.
  const run = gate.then(task, task);
  // Khong de loi cua khuc nay bam vao day chuyen thanh unhandled rejection cho
  // khuc sau — day chuyen chi de xep hang, khong mang ket qua.
  gate = run.then(
    () => {},
    () => {},
  );
  return run;
}

interface PollyReply {
  ok: boolean;
  status: number;
  bytes: ArrayBuffer;
}

async function callPolly(
  grant: PollyGrant,
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const body = JSON.stringify(payload);

  for (let attempt = 0; ; attempt++) {
    let reply: PollyReply;
    try {
      // Ky NAM TRONG cua chu khong ngoai. Ky la vai phep HMAC, khong dang de
      // danh doi: lam ngoai thi thu tu vao cua tuy thuoc ben nao ky xong truoc,
      // ma ta muon audio di truoc marks — audio la thu nguoi hoc nghe.
      //
      // Va cua chi duoc nha khi da doc XONG than response. `fetch` tra ve ngay
      // khi header ve, nhung stream h2 van con mo trong luc than dang chay — nha
      // cua o day thi request ke tiep mo stream thu hai, dung dieu ta dang tranh.
      reply = await serial(async () => {
        const headers = await signedHeaders(grant, body, Date.now());
        const res = await fetch(`https://${host(grant.region)}${SPEECH_PATH}`, {
          method: "POST",
          headers,
          body,
          signal,
        });
        return {
          ok: res.ok,
          status: res.status,
          bytes: await res.arrayBuffer(),
        };
      });
    } catch (err) {
      // LOI TANG MANG — khong co status nao ca, `fetch` nem thang.
      //
      // Xep hang o tren da chan phan lon nguyen nhan, nhung mang thi van la
      // mang: doi Wi-Fi, ngu day sau khi may sleep, socket dut giua chung. Voi
      // GET trinh duyet tu am tham thu lai; voi POST thi KHONG — no khong biet
      // request co an toan de gui lai khong. Ma ta thi biet: SynthesizeSpeech
      // cung mot dau vao cho ra cung mot audio.
      console.error(err);
      if (signal.aborted || attempt >= RETRY_MS.length) throw err;
      await sleep(RETRY_MS[attempt] ?? 0);
      continue;
    }

    if (reply.ok) return reply.bytes;

    const detail = new TextDecoder().decode(reply.bytes).slice(0, 300);
    // 429 la throttle theo TPS cua ca account — cho mot nhip roi thu lai.
    // Cac loi khac (403 het han, 400 sai tham so) thi thu lai chi ton them
    // thoi gian.
    if (reply.status === 429 && attempt < RETRY_MS.length) {
      await sleep(RETRY_MS[attempt] ?? 0);
      continue;
    }
    throw new PollyError(
      `Polly tra ve ${reply.status}: ${detail}`,
      reply.status,
    );
  }
}

export interface SynthesisResult {
  /** Blob URL cua mp3. Ben goi phai `URL.revokeObjectURL` khi xong. */
  url: string;
  blob: Blob;
  frames: VisemeFrame[];
}

export interface SynthesizeOptions {
  voiceId: string;
  engine: PollyEngine;
  signal?: AbortSignal;
}

/**
 * Doc mot khuc va lay ve ca audio lan timeline khau hinh.
 *
 * HAI request vi speech marks tra ve THAY CHO audio chu khong kem theo — day
 * la thiet ke cua Polly, khong gop duoc.
 *
 * Hai request do di NOI TIEP chu khong song song, va khong phai vi ta muon the:
 * Polly chi cho mot stream h2 mot luc (xem `serial` o tren). Nen mot khuc ton
 * hai vong mang chu khong phai mot. Doi lai, khuc N+1 van duoc tong hop trong
 * luc khuc N dang PHAT, ma phat mot cau thi lau hon nhieu so voi mot vong
 * mang — nen chi khuc dau tien cua moi luot that su cham them.
 *
 * HAI REQUEST DO KHONG NGANG HANG NHAU, va cho nay tung lam nhu the.
 *
 * Truoc day chung di bang `Promise.all`, nen mot ben hong la mat ca hai. Ma
 * moi khuc ban hai request trong khi Polly tinh TPS theo CA ACCOUNT, nen 429 la
 * chuyen thuong ngay — va cu roi vao ben marks thi khuc do mat tieng hoan toan,
 * du file mp3 da ve toi noi. Nghe ra dung la "AI bo mat vai doan".
 *
 * Thu tu uu tien that: audio la thu nguoi hoc NGHE, speech marks chi de avatar
 * nhep mom. Mat khau hinh thi avatar dung im mot khuc; mat audio thi mat han
 * mot doan bai hoc. Nen marks duoc phep hong.
 *
 * Cung nguyen tac ma khau cham diem dung `Promise.allSettled` cho summary va
 * cham phat am — hong mot phan khong duoc keo do phan kia.
 */
export async function synthesize(
  grant: PollyGrant,
  text: string,
  opts: SynthesizeOptions,
): Promise<SynthesisResult> {
  if (!globalThis.crypto?.subtle) {
    throw new PollyError(
      "Trinh duyet khong cho ky AWS: crypto.subtle chi co trong secure context. " +
        "Mo bang https hoac http://localhost.",
      0,
    );
  }

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeout])
    : timeout;

  const common = { Text: text, VoiceId: opts.voiceId, Engine: opts.engine };

  // Goi audio TRUOC: `serial` xep hang theo dung thu tu goi, va audio la thu
  // nguoi hoc nghe — no khong duoc xep sau khau hinh.
  const audioReq = callPolly(grant, { ...common, OutputFormat: "mp3" }, signal);

  // Bat loi NGAY luc tao: neu de den sau `await audioReq` thi mot khuc marks
  // hong trong luc audio con dang tai se thanh unhandled rejection.
  const marksText = callPolly(
    grant,
    { ...common, OutputFormat: "json", SpeechMarkTypes: ["viseme"] },
    signal,
  ).then(
    (bytes) => new TextDecoder().decode(bytes),
    () => null,
  );

  const blob = new Blob([await audioReq], { type: "audio/mpeg" });
  const marks = await marksText;

  return {
    url: URL.createObjectURL(blob),
    blob,
    frames: marks === null ? [] : parseSpeechMarks(marks),
  };
}

/** Con han it hon nguong nay thi coi nhu sap chet, xin cai moi truoc. */
const EXPIRY_MARGIN_MS = 60_000;

export const grantUsable = (grant: PollyGrant | null): grant is PollyGrant =>
  Boolean(grant && grant.expiresAt - Date.now() > EXPIRY_MARGIN_MS);
