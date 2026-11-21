// 音声処理専用の小さなプログラム（AudioWorklet）。画面とは別の場所で動き、音を途切れさせない。
// 入ってきた音を「16kHz・モノラル・16bit」の数値の列（PCM）に変換し、
// 0.05秒ぶんたまるごとに、音の大きさの情報を添えて画面側へ送る。

const TARGET_RATE = 16000; // 音声認識エンジンへ送る標準の細かさ（1秒あたり16000個の数値）
const CHUNK_SAMPLES = 800; // 0.05秒ぶん
const CLIP_LEVEL = 0.985; // これ以上は「上限に張り付いた＝音割れ」とみなす

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // sampleRate は入力側の細かさ。16kHzより細かいときは、step 個ぶんを平均して1個にまとめる。
    this.step = sampleRate / TARGET_RATE;
    this.remain = this.step;
    this.acc = 0;
    this.stopped = false;
    this.newChunk();
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this.stopped = true;
    };
  }

  newChunk() {
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.outLen = 0;
    this.peak = 0; // この0.05秒で一番大きかった値
    this.sumSq = 0; // 平均の大きさ（RMS）の計算用
    this.count = 0;
    this.clipped = 0; // 上限に張り付いた回数
  }

  emit(value) {
    const v = value > 1 ? 1 : value < -1 ? -1 : value;
    this.out[this.outLen++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    if (this.outLen === CHUNK_SAMPLES) {
      this.port.postMessage(
        {
          pcm: this.out,
          peak: this.peak,
          rms: Math.sqrt(this.sumSq / Math.max(1, this.count)),
          clipped: this.clipped,
        },
        [this.out.buffer],
      );
      this.newChunk();
    }
  }

  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length;
    const frames = input[0].length;

    for (let i = 0; i < frames; i++) {
      // 左右2チャンネルなら平均して1つ（モノラル）にする。音割れは左右それぞれで見る。
      let sum = 0;
      let maxAbs = 0;
      for (let c = 0; c < channels; c++) {
        const x = input[c][i];
        sum += x;
        const a = x < 0 ? -x : x;
        if (a > maxAbs) maxAbs = a;
      }
      const s = sum / channels;
      if (maxAbs > this.peak) this.peak = maxAbs;
      if (maxAbs >= CLIP_LEVEL) this.clipped++;
      this.sumSq += s * s;
      this.count++;

      // 16kHzへの変換。入力1個ぶんの幅を、出力の区切りにまたがる場合は按分して足し込む。
      let width = 1;
      while (width > 0) {
        if (this.remain > width) {
          this.acc += s * width;
          this.remain -= width;
          width = 0;
        } else {
          this.acc += s * this.remain;
          width -= this.remain;
          this.emit(this.acc / this.step);
          this.acc = 0;
          this.remain = this.step;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
