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
