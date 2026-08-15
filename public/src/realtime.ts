/**
 * Lop transport thuan tuy: dung ket noi WebRTC toi OpenAI Realtime va
 * bom/nhan event JSON qua data channel. Khong biet gi ve bai hoc.
 */
const CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

/**
 * Event tu Realtime API. Chi khai bao cac truong ma code nay that su doc —
 * ta khong so huu hinh dang nay, no do OpenAI dinh nghia va con doi theo
 * phien ban, nen mo ta het la vua thua vua nhanh sai.
 */
export interface RealtimeEvent {
  type: string;
  delta?: string;
  transcript?: string;
  item_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  error?: unknown;
  response?: {
    id?: string;
    metadata?: { purpose?: string };
    output?: { content?: { type?: string; text?: string; transcript?: string }[] }[];
  };
}

export interface RealtimeHandlers {
  onEvent?: (event: RealtimeEvent) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onDisconnect?: (state: RTCPeerConnectionState) => void;
}

export class RealtimeConnection {
  #pc: RTCPeerConnection | null = null;
  #dc: RTCDataChannel | null = null;
  #micStream: MediaStream | null = null;
  #closing = false;
  #callId: string | null = null;

  onEvent?: RealtimeHandlers['onEvent'];
  onRemoteStream?: RealtimeHandlers['onRemoteStream'];
  onDisconnect?: RealtimeHandlers['onDisconnect'];

  constructor({ onEvent, onRemoteStream, onDisconnect }: RealtimeHandlers) {
    this.onEvent = onEvent;
    this.onRemoteStream = onRemoteStream;
    this.onDisconnect = onDisconnect;
  }

  get micStream(): MediaStream | null {
    return this.#micStream;
  }

  /** Id cuoc goi ben OpenAI. Server can no de hen gio cat. */
  get callId(): string | null {
    return this.#callId;
  }

  async connect({
    clientSecret,
    micStream,
  }: {
    clientSecret: string;
    micStream: MediaStream;
  }): Promise<void> {
    this.#closing = false;
    this.#micStream = micStream;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    this.#pc = pc;

    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (stream) this.onRemoteStream?.(stream);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (this.#closing) return;
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        this.onDisconnect?.(state);
      }
    };

    // addTrack tao san transceiver huong sendrecv, nen khong can addTransceiver
    // rieng — them nua se sinh m-line thu hai va lam hong SDP.
    for (const track of micStream.getAudioTracks()) {
      pc.addTrack(track, micStream);
    }

    const dc = pc.createDataChannel('oai-events');
    this.#dc = dc;
    dc.addEventListener('message', (e: MessageEvent<string>) => {
      let event: RealtimeEvent;
      try {
        event = JSON.parse(e.data) as RealtimeEvent;
      } catch {
        return;
      }
      this.onEvent?.(event);
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    const res = await fetch(CALLS_URL, {
      method: 'POST',
      body: pc.localDescription?.sdp ?? offer.sdp,
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        'Content-Type': 'application/sdp',
      },
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      pc.close();
      throw new Error(`SDP exchange that bai (${res.status}): ${detail}`);
    }

    // Location: /v1/realtime/calls/rtc_xxx — day la duong duy nhat lay duoc
    // call_id. Server can no de goi hangup, nen dung vut response headers di.
    this.#callId = res.headers.get('Location')?.split('/').pop() ?? null;

    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    await waitForDataChannel(dc);
  }

  send(event: Record<string, unknown>): boolean {
    if (this.#dc?.readyState !== 'open') return false;
    this.#dc.send(JSON.stringify(event));
    return true;
  }

  setMicEnabled(enabled: boolean): void {
    this.#micStream?.getAudioTracks().forEach((t) => {
      t.enabled = enabled;
    });
  }

  /** Dong chu dong — khong kich hoat luong reconnect. */
  close(): void {
    this.#closing = true;
    try {
      this.#dc?.close();
    } catch {
      /* da dong */
    }
    try {
      this.#pc?.close();
    } catch {
      /* da dong */
    }
    this.#dc = null;
    this.#pc = null;
  }
}

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 2000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    // Khong doi qua lau: trickle ICE van chay tiep sau khi gui offer.
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function waitForDataChannel(dc: RTCDataChannel, timeoutMs = 10000): Promise<void> {
  if (dc.readyState === 'open') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Data channel khong mo duoc')), timeoutMs);
    dc.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
