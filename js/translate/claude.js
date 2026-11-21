// 翻訳エンジン「Claude」の部品。Anthropic の公式ライブラリ（SDK）を使って、タブレットから直接 Claude API を呼ぶ。
//
// 共通の形（ほかの翻訳エンジンを足すときも同じ形にする）:
//   const t = new ClaudeTranslator({ apiKey, model, quality });
//   const r = await t.translate({ system, user, onText, signal });
//       system = 指示文、user = 今回の依頼文、onText = 途中まで届いた訳を受け取る関数、signal = 中断の合図
//       r = { text, refused, usage, model }
//   const memo = await t.complete({ system, user });   // 話題メモなど、短い文章を1回で受け取る

// 公式ライブラリは、版を固定して配信元（jsDelivr）から読み込む。ビルド作業をなくすための方法。
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.12.0/+esm';

// 安全上の理由でモデルが応答を断ったとき、API側で代わりのモデルに引き継ぐ機能の指定。
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const MEMO_MODEL = 'claude-haiku-5-5'; // 話題メモは、速くて安いモデルで作る

export const CLAUDE_MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5（標準）' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（高品質・遅め）' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5（速い・安い）' },
];

export const QUALITY_MODES = [
  { id: 'speed', label: '速さ優先' },
  { id: 'standard', label: '標準' },
  { id: 'quality', label: '品質優先（遅れが増える）' },
];

let sdkPromise = null;
function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import(SDK_URL)
      .then((m) => m.default)
      .catch((e) => {
        sdkPromise = null;
        throw e;
      });
  }
  return sdkPromise;
}

// 品質モードを、モデルごとの「考える量」の設定に直す。
// thinking = 答える前に考えるかどうか、effort = 手間のかけ方。考えるほど訳し始めが遅くなる。
function tuning(model, quality) {
  if (model === 'claude-opus-5-5') {
    // Opus 5.5 は「考えない」設定ができない。effort で調整する。
    return { thinking: null, effort: quality === 'quality' ? 'medium' : 'low', maxTokens: 4096 };
  }
  if (model === 'claude-haiku-5-5') {
    // Haiku 5.5 は「考えない」設定にすると、考えた内容を答えの文章に書いてしまうことがある。
    // 公式の案内どおり、設定は変えずに effort を下げて考える量を減らす。
    return { thinking: null, effort: quality === 'quality' ? 'medium' : 'low', maxTokens: 2048 };
  }
  if (quality === 'quality') {
    return { thinking: { type: 'adaptive' }, effort: 'medium', maxTokens: 4096 };
  }
  // Sonnet 5.5 用の、考えずにすぐ訳し始める設定。
  return { thinking: { type: 'between_tools' }, effort: quality === 'speed' ? 'low' : 'medium', maxTokens: 1024 };
}

// エラーを、利用者に見せる日本語の説明に直す。fatal=true は「設定を直すまで何度やっても失敗する」もの。
function explain(e) {
  const status = e?.status;
  const raw = e?.message || String(e);
  const err = new Error(raw);
  err.status = status;
  err.aborted = e?.name === 'APIUserAbortError' || e?.name === 'AbortError';
  err.fatal = false;
  if (err.aborted) {
    err.message = '中断しました';
  } else if (status === 401) {
    err.message = 'ClaudeのAPIキーが正しくないか、有効期限が切れています。設定で入力し直してください。';
    err.fatal = true;
  } else if (status === 403) {
    err.message = 'このClaudeのAPIキーでは利用が許可されていません。';
    err.fatal = true;
  } else if (status === 400 && /credit balance/i.test(raw)) {
    err.message = 'Claude APIの利用残高（クレジット）が足りません。';
    err.fatal = true;
  } else if (status === 404) {
    err.message = `選んだモデルが見つかりません（${raw}）`;
    err.fatal = true;
  } else if (status === 429) {
    err.message = 'Claude APIの利用上限に達しました。少し待つと回復します。';
  } else if (status >= 500) {
    err.message = 'Claude API側で一時的な問題が起きています。';
  } else if (!status) {
    err.message = `Claude APIと通信できませんでした（${raw}）`;
  } else {
    err.message = `Claude APIがエラーを返しました（${status}：${raw}）`;
  }
  return err;
}

export class ClaudeTranslator {
  constructor({ apiKey, model = 'claude-sonnet-5-5', quality = 'standard' }) {
    this.apiKey = apiKey;
    this.model = model;
    this.quality = quality;
    // Haiku 5.5 には、API側の引き継ぎ機能がない。
    this.useFallbacks = model !== 'claude-haiku-5-5';
    this.clientPromise = null;
  }

  client() {
    if (!this.clientPromise) {
      this.clientPromise = loadSdk().then(
        (Anthropic) =>
          new Anthropic({
            apiKey: this.apiKey,
            dangerouslyAllowBrowser: true, // ブラウザから直接呼ぶための指定。キーは利用者の端末の中だけにある。
            maxRetries: 0, // 生の字幕では、やり直すより先へ進むほうがよい
            timeout: 15000,
          }),
      );
      this.clientPromise.catch(() => {
        this.clientPromise = null;
      });
    }
    return this.clientPromise;
  }

  /**
   * 字幕1つぶんを訳す。訳は少しずつ届き、届くたびに onText(そこまでの全文) が呼ばれる。
   * followUp = { previous, note } を渡すと、「前の訳（previous）を、note のとおりに書き直して」という依頼になる。
   */
  async translate({ system, user, onText, signal, followUp }) {
    let client;
    try {
      client = await this.client();
    } catch (e) {
      throw explain({ message: `Claudeの公式ライブラリを読み込めませんでした（${e?.message || e}）` });
    }
    const t = tuning(this.model, this.quality);
    const messages = [{ role: 'user', content: user }];
    if (followUp) {
      messages.push({ role: 'assistant', content: followUp.previous }, { role: 'user', content: followUp.note });
    }
    const body = {
      model: this.model,
      max_tokens: t.maxTokens,
      // 指示文は毎回同じなので、キャッシュ（使い回し）を指定して費用と遅れを抑える。
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
      output_config: { effort: t.effort },
    };
    if (t.thinking) body.thinking = t.thinking;

    try {
      return await this.run(client, body, { onText, signal });
    } catch (e) {
      // 引き継ぎ機能の指定が受け付けられなかった場合は、外して1回だけやり直す。
      if (this.useFallbacks && e?.status === 400 && /fallback|beta/i.test(e?.message || '')) {
        this.useFallbacks = false;
        try {
          return await this.run(client, body, { onText, signal });
        } catch (e2) {
          throw explain(e2);
        }
      }
      throw explain(e);
    }
  }

  async run(client, body, { onText, signal }) {
    const stream = this.useFallbacks
      ? client.beta.messages.stream({ ...body, betas: [FALLBACK_BETA], fallbacks: 'default' }, { signal })
      : client.messages.stream(body, { signal });

    let text = '';
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'fallback') {
        text = ''; // 代わりのモデルが最初から書き直すので、それまでの分は捨てる
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text;
        onText?.(text);
      }
    }
    const message = await stream.finalMessage();
    return {
      text: message.stop_reason === 'refusal' ? '' : text,
      refused: message.stop_reason === 'refusal',
      usage: message.usage,
      model: message.model,
    };
  }

  /** 短い文章を1回で受け取る（話題メモ用）。 */
  async complete({ system, user, maxTokens = 1024 }) {
    try {
      const client = await this.client();
      const message = await client.messages.create({
        model: MEMO_MODEL,
        max_tokens: maxTokens, // 考える分の余裕を含む
        output_config: { effort: 'low' }, // 「考えない」設定は使わず、effort で考える量を減らす（字幕の訳と同じ理由）
        system,
        messages: [{ role: 'user', content: user }],
      });
      if (message.stop_reason === 'refusal') return '';
      return message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();
    } catch (e) {
      throw explain(e);
    }
  }
}
