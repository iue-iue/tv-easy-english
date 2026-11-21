// 音声認識エンジン「Soniox」の部品。タブレットから Soniox へ直接つなぎ、
// 日本語の認識結果と、英語の速報訳（Soniox内蔵の翻訳）を同じ接続で受け取る。
//
// 共通の形（ほかの音声認識エンジンを足すときも同じ形にする）:
//   const stt = new SonioxStt({ apiKey, glossary });
//   stt.onResult = (result) => { ... };   // 認識結果（下の「結果の形」を参照）
//   stt.onState = (state) => { ... };     // 'connecting' | 'open' | 'reconnecting' | 'closed'
//   stt.onError = (error) => { ... };     // { message, fatal }  fatal=true は設定を直すまで直らないもの
//   stt.start();
//   stt.sendAudio(pcm);                   // 16kHz・モノラル・16bit の Int16Array
//   stt.stop();
//
// 結果の形:
//   finals              今回新しく確定した分。届いた順に並ぶ [{ type: 'source' | 'translation', text }]
//                       source = 日本語、translation = 速報訳（英語）
//   interimText         まだ確定していない日本語（届くたびに丸ごと置き換える）
//   interimTranslation  まだ確定していない速報訳
//   endpoint            話の区切り（話し終わり）を検出したら true
//   lagMs               送った音声に対して、認識がどれだけ遅れているか（ミリ秒）

const ENDPOINT = 'wss://stt-rt.soniox.com/transcribe-websocket';
const MODEL = 'stt-rt-v6';
const SAMPLE_RATE = 16000;
const PING_EVERY_MS = 5000;
const PONG_TIMEOUT_MS = 12000;

export class SonioxStt {
  constructor({ apiKey, glossary = [], translate = true }) {
    this.apiKey = apiKey;
    this.glossary = glossary; // [{ ja, reading, en }]
    this.translate = translate;
    this.onResult = null;
    this.onState = null;
    this.onError = null;
    this.running = false;
    this.ws = null;
    this.retryMs = 1000;
  }

  // 接続の最初に送る設定。
  config() {
    const config = {
      model: MODEL,
      audio_format: 'pcm_s16le',
      sample_rate: SAMPLE_RATE,
      num_channels: 1,
      language_hints: ['ja'],
      enable_endpoint_detection: true, // 話し終わりを検出して、早めに確定させる
      context: { general: [{ key: 'domain', value: 'Japanese television broadcast' }] },
    };
    if (this.translate) config.translation = { type: 'one_way', target_language: 'en' };
    if (this.glossary.length) {
      // 用語集は、聞き取り（terms）と速報訳（translation_terms）の両方に渡す。
      config.context.terms = this.glossary.map((g) => g.ja);
      config.context.translation_terms = this.glossary.map((g) => ({ source: g.ja, target: g.en }));
    }
    return config;
  }

  start() {
    this.running = true;
    this.retryMs = 1000;
    this.connect('connecting');
  }

  connect(state) {
    if (!this.running) return;
    this.onState?.(state);
    this.sentMs = 0;
    this.pingId = 0;
    this.lastPongAt = performance.now();

    let ws;
    try {
      // ブラウザでは、キーを「protocols」という欄に入れて渡す決まり。
      ws = new WebSocket(ENDPOINT, ['soniox-api-key', this.apiKey]);
    } catch (e) {
      this.fail(`Sonioxへ接続できませんでした（${e?.message || e}）`, true);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      ws.send(JSON.stringify(this.config()));
      this.ready = true;
      this.onState?.('open');
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(ws), PING_EVERY_MS);
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws || typeof event.data !== 'string') return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        this.lastPongAt = performance.now();
        return;
      }
      if (msg.error_code) {
        this.handleServerError(msg);
        return;
      }
      if (msg.tokens) {
        this.retryMs = 1000; // 正常に動いているので、つなぎ直しの間隔を元に戻す
        this.handleTokens(msg);
      }
      if (msg.finished) {
        if (this.finishing) this.stop(); // finish() で頼んだ締めくくりが終わった
        else this.reconnectSoon(); // 1本の接続の上限（300分）に達した場合など
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.reconnectSoon();
    };
    ws.onerror = () => {
      // 詳細は取れない。続いて onclose が呼ばれるので、そこでつなぎ直す。
    };
  }

  // 接続が生きているかを5秒ごとに確かめる。返事が来なければ切れたとみなす。
  ping(ws) {
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    if (performance.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
      this.reconnectSoon();
      return;
    }
    ws.send(JSON.stringify({ type: 'ping', id: ++this.pingId }));
  }

  handleTokens(msg) {
    const finals = [];
    let interimText = '';
    let interimTranslation = '';
    let endpoint = false;

    for (const token of msg.tokens) {
      if (token.text === '<end>') {
        endpoint = true;
        continue;
      }
      if (token.text === '<fin>') continue;
      const type = token.translation_status === 'translation' ? 'translation' : 'source';
      if (token.is_final) {
        const last = finals[finals.length - 1];
        if (last && last.type === type) last.text += token.text;
        else finals.push({ type, text: token.text });
      } else if (type === 'translation') {
        interimTranslation += token.text;
      } else {
        interimText += token.text;
      }
    }

    const lagMs = Math.max(0, this.sentMs - (msg.total_audio_proc_ms || 0));
    this.onResult?.({ finals, interimText, interimTranslation, endpoint, lagMs });
  }

  handleServerError(msg) {
    const code = msg.error_code;
    const detail = msg.error_message || msg.error_type || '';
    if (code === 401) {
      this.fail('SonioxのAPIキーが正しくありません。設定で入力し直してください。', true);
    } else if (code === 403) {
      this.fail('このSonioxのAPIキーには、リアルタイム音声認識の権限がありません。', true);
    } else if (code === 402) {
      this.fail(`Sonioxの残高が足りないか、月の上限額に達しました。（${detail}）`, true);
    } else if (code === 400) {
      this.fail(`Sonioxが設定を受け付けませんでした。（${detail}）`, true);
    } else {
      // 一時的な問題（混雑、時間切れなど）は、知らせたうえでつなぎ直す。
      this.onError?.({ message: `Sonioxとの接続が切れました。つなぎ直します。（${code}：${detail}）`, fatal: false });
      this.reconnectSoon();
    }
  }

  fail(message, fatal) {
    this.onError?.({ message, fatal });
    if (fatal) this.stop();
  }

  // いまの接続を片付けて、少し待ってからつなぎ直す。失敗が続くほど間隔を延ばす（最長15秒）。
  reconnectSoon() {
    this.closeSocket();
    if (!this.running) return;
    this.onState?.('reconnecting');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect('reconnecting'), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 15000);
  }

  closeSocket() {
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // すでに閉じている
      }
    }
  }

  /** 音声を送る。つなぎ直しの間に届いた音声は捨てる（生放送なので、ためて送ると遅れが増える）。 */
  sendAudio(pcm) {
    const ws = this.ws;
    if (!ws || !this.ready || ws.readyState !== WebSocket.OPEN) return;
    ws.send(pcm);
    this.sentMs += (pcm.length / SAMPLE_RATE) * 1000;
  }

  /**
   * 音声をここで終わりにして、残りの認識結果を受け取ってから閉じる（録音を最後まで流したとき用）。
   * すぐに止めたいときは stop() を使う。
   */
  finish() {
    const ws = this.ws;
    if (!this.running || !ws || ws.readyState !== WebSocket.OPEN) {
      this.stop();
      return;
    }
    this.finishing = true;
    this.ready = false; // これ以降の音声は送らない
    ws.send(''); // 空の文字を送ると「ここで終わり」の合図になる
    this.finishTimer = setTimeout(() => this.stop(), 5000); // 返事がなくても5秒で閉じる
  }

  stop() {
    const wasRunning = this.running;
    this.running = false;
    this.finishing = false;
    clearTimeout(this.finishTimer);
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(''); // 空の文字を送ると「ここで終わり」の合図になる
      } catch {
        // 送れなくても、このあと閉じる
      }
    }
    this.closeSocket();
    if (wasRunning) this.onState?.('closed');
  }
}
