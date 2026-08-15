// public/src/pcm-worklet.ts
var BLOCK = 2048;
var PcmRecorderProcessor = class extends AudioWorkletProcessor {
  #buffer = new Float32Array(BLOCK);
  #offset = 0;
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.#buffer[this.#offset++] = channel[i];
      if (this.#offset === BLOCK) {
        this.port.postMessage(this.#buffer);
        this.#buffer = new Float32Array(BLOCK);
        this.#offset = 0;
      }
    }
    return true;
  }
};
registerProcessor("pcm-recorder", PcmRecorderProcessor);
//# sourceMappingURL=pcm-worklet.js.map
