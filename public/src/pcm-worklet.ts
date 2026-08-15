/**
 * Ghi PCM lien tuc tu mot track.
 *
 * Ly do khong dung MediaRecorder.start()/stop() theo tung luot: recorder khoi dong
 * cham hon tieng noi ~100-200ms nen luon cut mat dau cau. O day audio chay lien tuc
 * vao buffer, viec cat thanh tung message duoc lam sau bang timestamp.
 */
const BLOCK = 2048;

class PcmRecorderProcessor extends AudioWorkletProcessor {
  #buffer = new Float32Array(BLOCK);
  #offset = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.#buffer[this.#offset++] = channel[i]!;
      if (this.#offset === BLOCK) {
        this.port.postMessage(this.#buffer);
        this.#buffer = new Float32Array(BLOCK);
        this.#offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorderProcessor);
