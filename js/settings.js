// アプリの設定を、タブレットのブラウザの中（localStorage）に保存・読み出しする部品。
// 設定はこの端末の中だけに残り、外へは送られない。

const KEY = 'tvsub.settings.v1';

// 何も保存されていないときの初期値。
function defaults() {
  return {
    input: {
      mode: 'mic', // 'mic' = 内蔵マイク、'line' = 有線（USB）
      deviceId: { mic: '', line: '' }, // 空は「おまかせ」
      processing: {
        // 内蔵マイク：離れたテレビの音を持ち上げるため、自動音量調整だけオン。
        mic: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
        // 有線：テレビの音をそのまま受け取るので、加工はすべてオフ。
        line: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      },
    },
    replayAudible: true, // 録音を入力として流すとき、スピーカーからも鳴らすか

    // APIキー（各サービスを使うための合言葉）。この端末の中だけに保存し、ファイルやGitHubには書かない。
    keys: { soniox: '', anthropic: '' },

    // 字幕にする音の入力元。'mic' はマイク（上の input の設定を使う）。それ以外は、保存した録音のID。
    source: 'mic',

    stt: { engine: 'soniox' }, // 音声認識エンジン
    translation: {
      engine: 'claude', // 翻訳エンジン
      model: 'claude-sonnet-5-5',
      quality: 'standard', // speed=速さ優先 / standard=標準 / quality=品質優先
      level: 'A1', // 英語のレベル（A1〜C1）
      style: 'standard', // standard=標準 / gist=要点だけ / faithful=原文に忠実
    },
    display: {
      fontSize: 4.6, // 字幕の文字の大きさ（画面の高さに対する％）
      rows: 3, // 同時に表示する字幕の数
      showSource: true, // 日本語の原文を出すか
      // 単語の上に日本語の意味を小さく出すか。
      // off=付けない / same=字幕のレベルと同じ単語だけ / レベル名（例 'A2'）=そのレベル以上の単語
      gloss: 'off',
      draft: 'show', // 速報訳（灰色の字）の出し方。show=表示 / small=小さく表示 / hide=表示しない
    },
  };
}

// 保存されていた値を初期値に重ねる。形や種類が違う値は捨てて初期値を使う。
function merge(base, saved) {
  if (!saved || typeof saved !== 'object') return base;
  for (const key of Object.keys(base)) {
    const b = base[key];
    const s = saved[key];
    if (b && typeof b === 'object') base[key] = merge(b, s);
    else if (typeof s === typeof b) base[key] = s;
  }
  return base;
}

export function loadSettings() {
  try {
    return merge(defaults(), JSON.parse(localStorage.getItem(KEY) || 'null'));
  } catch {
    return defaults();
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // 保存できない場合（シークレットモードなど）も、その場の動作は続ける。
  }
}
