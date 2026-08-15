/**
 * Lop transport thuan tuy: dung ket noi WebRTC toi OpenAI Realtime va
 * bom/nhan event JSON qua data channel. Khong biet gi ve bai hoc.
 */
const CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

export class RealtimeConnection {
  #pc = null;
  #dc = null;
  #micStream = null;
  #closing = false;

  constructor({ onEvent, onRemoteStream, onDisconnect }) {
    this.onEvent = onEvent;
    this.onRemoteStream = onRemoteStream;
    this.onDisconnect = onDisconnect;
  }

  get micStream() {
    return this.#micStream;
  }

  async connect({ clientSecret, micStream }) {
    this.#closing = false;
    this.#micStream = micStream;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    this.#pc = pc;

    pc.ontrack = (e) => this.onRemoteStream?.(e.streams[0]);

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
    dc.addEventListener('message', (e) => {
      let event;
      try {
        event = JSON.parse(e.data);
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
      body: pc.localDescription.sdp,
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

    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    await waitForDataChannel(dc);
  }

  send(event) {
    if (this.#dc?.readyState !== 'open') return false;
    this.#dc.send(JSON.stringify(event));
    return true;
  }

  setMicEnabled(enabled) {
    this.#micStream?.getAudioTracks().forEach((t) => {
      t.enabled = enabled;
    });
  }

  /** Dong chu dong — khong kich hoat luong reconnect. */
  close() {
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

function waitForIceGathering(pc, timeoutMs = 2000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
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

function waitForDataChannel(dc, timeoutMs = 10000) {
  if (dc.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
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
