// マイク（内蔵マイクまたはUSB入力）から音を取り込み、16kHz・モノラル・16bitのPCMにして渡す部品。
//
// 使い方（録音の再生 replay.js も同じ形なので、受け取る側は入力の種類を気にしなくてよい）:
//   const mic = new MicSource({ deviceId, echoCancellation, noiseSuppression, autoGainControl });
//   mic.onChunk = (pcm, level) => { ... };  // 0.05秒ごと。pcm は Int16Array、level は音の大きさ
//   mic.onEnd = (reason) => { ... };        // 機器が抜かれたときなど
//   await mic.start();
//   mic.stop();

export const TARGET_RATE = 16000;

const WORKLET_URL = new URL('./pcm-worklet.js', import.meta.url);

function namedError(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}

function createContext(sampleRate) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw namedError('UnsupportedError', 'このブラウザは音声処理に対応していません');
  if (sampleRate) {
    try {
      // 16kHzを指定すると、ブラウザが高品質に変換してくれる（Chromeは対応）。
      return new AC({ sampleRate, latencyHint: 'interactive' });
    } catch {
      // 指定できないブラウザでは既定のまま作り、変換は pcm-worklet.js 側で行う。
    }
  }
  return new AC({ latencyHint: 'interactive' });
}

/** 音声入力機器の一覧。マイクを許可する前は名前（label）が空で返る。 */
export async function listAudioInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === 'audioinput')
    .map((d) => ({ deviceId: d.deviceId, label: d.label, groupId: d.groupId }));
}

export class MicSource {
  constructor(options = {}) {
    this.options = {
      deviceId: '', // 空なら端末の既定の入力
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...options,
    };
    this.onChunk = null;
    this.onEnd = null;
    this.onMute = null;
    this.info = null; // 実際に使われている入力の情報（start の後に入る）
    this.running = false;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw namedError('InsecureContextError', 'マイクを使うには https のページで開く必要があります');
    }
    if (typeof AudioWorkletNode === 'undefined') {
      throw namedError('UnsupportedError', 'このブラウザは音声処理（AudioWorklet）に対応していません');
    }

    const o = this.options;
    // ボタンを押した直後に作る。あとから作ると、音声処理の開始を止めるブラウザがあるため。
    let ctx = createContext(TARGET_RATE);
    let stream = null;

    try {
      const audio = {
        echoCancellation: o.echoCancellation,
        noiseSuppression: o.noiseSuppression,
        autoGainControl: o.autoGainControl,
      };
      if (o.deviceId) audio.deviceId = { exact: o.deviceId };
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });

      let input;
      try {
        input = ctx.createMediaStreamSource(stream);
      } catch {
        // 16kHzの処理にマイクをつなげないブラウザ向け：既定の細かさで作り直す。
        await ctx.close().catch(() => {});
        ctx = createContext(0);
        input = ctx.createMediaStreamSource(stream);
      }

      await ctx.audioWorklet.addModule(WORKLET_URL);

      let head = input;
      if (ctx.sampleRate > TARGET_RATE * 1.01) {
        // 自前で16kHzへ間引く場合は、先に高い音を落とす（間引きで生じる雑音を防ぐ）。
        for (let i = 0; i < 2; i++) {
          const lowpass = ctx.createBiquadFilter();
          lowpass.type = 'lowpass';
          lowpass.frequency.value = 7200;
          lowpass.Q.value = 0.707;
          head.connect(lowpass);
          head = lowpass;
        }
      }

      const node = new AudioWorkletNode(ctx, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (e) => {
        if (!this.running) return;
        const m = e.data;
        this.onChunk?.(m.pcm, { peak: m.peak, rms: m.rms, clipped: m.clipped });
      };
      head.connect(node);

      // 音量ゼロで出力へつなぐ。つながないと処理を省くブラウザがあるため（スピーカーからは鳴らない）。
      const silent = ctx.createGain();
      silent.gain.value = 0;
      node.connect(silent);
      silent.connect(ctx.destination);

      if (ctx.state !== 'running') await ctx.resume();

      const track = stream.getAudioTracks()[0];
      const s = track.getSettings ? track.getSettings() : {};
      this.info = {
        label: track.label || '',
        deviceId: s.deviceId || '',
        sampleRate: s.sampleRate || null,
        channelCount: s.channelCount || null,
        echoCancellation: s.echoCancellation,
        noiseSuppression: s.noiseSuppression,
        autoGainControl: s.autoGainControl,
        contextRate: ctx.sampleRate,
      };

      track.addEventListener('ended', () => {
        if (!this.running) return;
        this.stop();
        this.onEnd?.('device-lost');
      });
      track.addEventListener('mute', () => this.running && this.onMute?.(true));
      track.addEventListener('unmute', () => this.running && this.onMute?.(false));
      ctx.addEventListener('statechange', () => {
        // 電話の着信などで一時停止されたら、再開を試みる。
        if (this.running && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
      });

      this.ctx = ctx;
      this.stream = stream;
      this.node = node;
      this.running = true;
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      await ctx.close().catch(() => {});
      throw e;
    }
  }

  stop() {
    this.running = false;
    try {
      this.node?.port.postMessage('stop');
      this.node?.disconnect();
    } catch {
      // すでに閉じている場合は何もしない
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.node = null;
    this.stream = null;
    this.ctx = null;
  }
}
