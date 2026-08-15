/**
 * TrackRecorder — ghi mot MediaStreamTrack thanh PCM 16kHz mono lien tuc,
 * roi cat ra tung doan WAV theo moc thoi gian.
 *
 * Dong ho cua recorder chinh la so mau da ghi (nowMs), khong phai wall clock.
 * Nho vay moc thoi gian danh dau tu event realtime luon khop voi vi tri that
 * trong buffer, khong bi lech do jitter mang hay do GC.
 */

const TARGET_RATE = 16000;

export class TrackRecorder {
  #ctx: AudioContext;
  #source: MediaStreamAudioSourceNode;
  #node: AudioWorkletNode | null = null;
  #samples: Int16Array;
  #length = 0;
  #pending: Float32Array = new Float32Array(0);
  #cursor = 0;
  #ratio: number;

  constructor(audioContext: AudioContext, mediaStream: MediaStream) {
    this.#ctx = audioContext;
    this.#source = audioContext.createMediaStreamSource(mediaStream);
    this.#ratio = audioContext.sampleRate / TARGET_RATE;
    this.#samples = new Int16Array(TARGET_RATE * 60);
  }

  static async create(audioContext: AudioContext, mediaStream: MediaStream): Promise<TrackRecorder> {
    const rec = new TrackRecorder(audioContext, mediaStream);
    await rec.#start();
    return rec;
  }

  async #start(): Promise<void> {
    this.#node = new AudioWorkletNode(this.#ctx, 'pcm-recorder');
    this.#node.port.onmessage = (e) => this.#ingest(e.data);
    this.#source.connect(this.#node);
    // Worklet khong phat ra tieng, nhung Chrome chi chay process() khi node
    // nam trong graph co dich den. Noi qua mot gain 0 de graph song.
    const sink = this.#ctx.createGain();
    sink.gain.value = 0;
    this.#node.connect(sink);
    sink.connect(this.#ctx.destination);
  }

  /** Resample chinh xac, giu phan du giua cac chunk nen khong bi troi thoi gian. */
  #ingest(float32: Float32Array): void {
    const merged = new Float32Array(this.#pending.length + float32.length);
    merged.set(this.#pending, 0);
    merged.set(float32, this.#pending.length);

    let pos = this.#cursor;
    const out: number[] = [];
    while (Math.floor(pos) + 1 < merged.length) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s = merged[i0]! * (1 - frac) + merged[i0 + 1]! * frac;
      out.push(Math.max(-1, Math.min(1, s)));
      pos += this.#ratio;
    }

    const consumed = Math.floor(pos);
    this.#pending = merged.subarray(consumed);
    this.#cursor = pos - consumed;

    this.#ensure(this.#length + out.length);
    for (let i = 0; i < out.length; i++) {
      this.#samples[this.#length + i] = out[i]! * 0x7fff;
    }
    this.#length += out.length;
  }

  #ensure(needed: number): void {
    if (needed <= this.#samples.length) return;
    let size = this.#samples.length;
    while (size < needed) size *= 2;
    const grown = new Int16Array(size);
    grown.set(this.#samples.subarray(0, this.#length));
    this.#samples = grown;
  }

  /** Vi tri hien tai tinh bang ms, do bang chinh so mau da ghi. */
  nowMs(): number {
    return (this.#length / TARGET_RATE) * 1000;
  }

  #msToIndex(ms: number): number {
    return Math.max(0, Math.min(this.#length, Math.round((ms / 1000) * TARGET_RATE)));
  }

  /** RMS cua mot cua so 20ms, dung de do im lang. */
  #rmsAt(index: number): number {
    const win = Math.round(TARGET_RATE * 0.02);
    const end = Math.min(this.#length, index + win);
    let sum = 0;
    for (let i = index; i < end; i++) {
      const v = this.#samples[i]! / 0x7fff;
      sum += v * v;
    }
    return Math.sqrt(sum / Math.max(1, end - index));
  }

  /**
   * Moc ms cuoi cung con tieng noi trong khoang [fromMs, toMs].
   * Dung de cat duoi cau AI: `response.done` bao model sinh xong,
   * nhung audio van dang phat not qua WebRTC nen cat ngay se bi hut cuoi cau.
   */
  lastVoiceMs(fromMs: number, toMs: number, threshold = 0.015): number | null {
    const start = this.#msToIndex(fromMs);
    const end = this.#msToIndex(toMs);
    const step = Math.round(TARGET_RATE * 0.02);
    for (let i = end - step; i >= start; i -= step) {
      if (this.#rmsAt(i) > threshold) return ((i + step) / TARGET_RATE) * 1000;
    }
    return null;
  }

  /** Moc ms dau tien co tieng noi — dung de bo khoang lang dau doan. */
  firstVoiceMs(fromMs: number, toMs: number, threshold = 0.015): number | null {
    const start = this.#msToIndex(fromMs);
    const end = this.#msToIndex(toMs);
    const step = Math.round(TARGET_RATE * 0.02);
    for (let i = start; i < end; i += step) {
      if (this.#rmsAt(i) > threshold) return (i / TARGET_RATE) * 1000;
    }
    return null;
  }

  hasVoice(fromMs: number, toMs: number, threshold = 0.015): boolean {
    return this.firstVoiceMs(fromMs, toMs, threshold) !== null;
  }

  /** Cat mot doan thanh WAV blob. Tra null neu doan rong. */
  sliceToWav(startMs: number, endMs: number): Blob | null {
    const from = this.#msToIndex(startMs);
    const to = this.#msToIndex(endMs);
    if (to - from < TARGET_RATE * 0.15) return null; // ngan hon 150ms thi bo
    return encodeWav(this.#samples.subarray(from, to), TARGET_RATE);
  }

  stop(): void {
    try {
      this.#node?.port.close();
      this.#node?.disconnect();
      this.#source.disconnect();
    } catch {
      /* track co the da chet truoc do */
    }
  }
}

export function encodeWav(samples: Int16Array, sampleRate: number): Blob {
  const bytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + bytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, str: string): void => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, bytes, true);

  new Int16Array(buffer, 44).set(samples);
  return new Blob([buffer], { type: 'audio/wav' });
}
