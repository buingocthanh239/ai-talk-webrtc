/**
 * Khai bao cac global cua AudioWorkletGlobalScope.
 *
 * Lib "DOM" cua TypeScript khong co chung, vi worklet khong chay trong window
 * — no la mot global scope rieng, khong co DOM, khong co fetch, chay tren
 * luong audio real-time. Day la ly do pcm-worklet phai la bundle rieng.
 */
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor
): void;

/** Tan so lay mau cua AudioContext dang chay worklet nay. */
declare const sampleRate: number;
