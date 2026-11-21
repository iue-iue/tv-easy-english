// 保存した録音を「マイクの代わりの入力」として、実際の速さで流す部品。
// capture.js の MicSource と同じ形（onChunk / onEnd / start / stop）なので、
// 受け取る側（レベルメーター、今後の音声認識）は入力が本物か録音かを気にしなくてよい。

import { levelOf } from './pcm.js';

const RATE = 16000;
const CHUNK_SAMPLES = 800; // 0.05秒ぶん

export class RecordingSource {
  /**
   * @param {Int16Array} pcm 16kHz・モノラルの録音
   * @param {{audible?: boolean}} options audible=true ならスピーカーからも鳴らす
   */
  constructor(pcm, { audible = true } = {}) {
    this.pcm = pcm;
    this.audible = audible;
    this.onChunk = null;
    this.onEnd = null;
    this.info = { label: '保存した録音' };
    this.running = false;
  }

  async start() {
    if (this.audible && this.pcm.length > 0) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      const buffer = this.ctx.createBuffer(1, this.pcm.length, RATE);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < this.pcm.length; i++) data[i] = this.pcm[i] / 32768;
      this.player = this.ctx.createBufferSource();
      this.player.buffer = buffer;
      this.player.connect(this.ctx.destination);
      if (this.ctx.state !== 'running') await this.ctx.resume();
      this.player.start();
    }
    this.running = true;
    this.position = 0;
    this.startedAt = performance.now();
    this.timer = setInterval(() => this.pump(), 20);
  }

  // 経過時間ぶんだけ、0.05秒単位で送り出す。タイマーが多少遅れても全体の速さは実時間に合う。
  pump() {
    if (!this.running) return;
    const due = Math.floor(((performance.now() - this.startedAt) / 1000) * RATE);
    while (this.running && this.position < this.pcm.length) {
      const end = Math.min(this.position + CHUNK_SAMPLES, this.pcm.length);
      if (end > due) break;
      const chunk = this.pcm.slice(this.position, end);
      this.position = end;
      this.onChunk?.(chunk, levelOf(chunk));
    }
    if (this.running && this.position >= this.pcm.length) {
      this.stop();
      this.onEnd?.('finished');
    }
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    try {
      this.player?.stop();
    } catch {
      // すでに止まっている場合は何もしない
    }
    this.ctx?.close().catch(() => {});
    this.player = null;
    this.ctx = null;
  }
}
