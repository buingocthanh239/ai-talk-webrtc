/**
 * Ghi PCM lien tuc tu mot track.
 *
 * Ly do khong dung MediaRecorder.start()/stop() theo tung luot: recorder khoi dong
 * cham hon tieng noi ~100-200ms nen luon cut mat dau cau. O day audio chay lien tuc
 * vao buffer, viec cat thanh tung message duoc lam sau bang timestamp.
 */
const BLOCK = 2048;

class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(BLOCK);
    this._offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._offset++] = channel[i];
      if (this._offset === BLOCK) {
        this.port.postMessage(this._buffer);
        this._buffer = new Float32Array(BLOCK);
        this._offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorderProcessor);
