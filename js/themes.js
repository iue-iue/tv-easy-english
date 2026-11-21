// 字幕画面の配色の一覧と適用。
// 決めるのは「背景の色」と「文字の色」の2つだけ。速報訳の灰色、日本語の原文、単語の上の日本語の色は、
// この2色を混ぜて自動で作る（css/app.css の先頭を参照）。配色を足すときは、この一覧に1行足す。

export const THEMES = [
  { id: 'soft', label: 'やわらかい白（黒い背景・少しグレーの文字）', bg: '#000000', text: '#e2e2e2' },
  { id: 'white', label: 'くっきり白（黒い背景・白い文字）', bg: '#000000', text: '#ffffff' },
  { id: 'yellow', label: '字幕イエロー（黒い背景・淡い黄色の文字）', bg: '#000000', text: '#f2d974' },
  { id: 'warm', label: '夜用（黒い背景・あたたかい色の文字）', bg: '#000000', text: '#d9c9a6' },
  { id: 'navy', label: '紺の背景（紺の背景・明るいグレーの文字）', bg: '#0b1626', text: '#e6ebf2' },
  { id: 'light', label: '明るい部屋用（クリーム色の背景・黒い文字）', bg: '#f4f1ea', text: '#1c1c1c' },
  { id: 'custom', label: '自分で色を選ぶ' },
];

/** いまの設定で使う2色を返す。「自分で色を選ぶ」のときは、設定に保存した色を使う。 */
export function themeColors(display) {
  const theme = THEMES.find((t) => t.id === display.theme) || THEMES[0];
  if (theme.id === 'custom') return { bg: display.bgColor, text: display.textColor };
  return { bg: theme.bg, text: theme.text };
}

/** 配色を画面に適用する。 */
export function applyTheme(display) {
  const { bg, text } = themeColors(display);
  document.body.style.setProperty('--stage-bg', bg);
  document.body.style.setProperty('--sub-color', text);
  // ブラウザの上端の帯の色も背景に合わせる。
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}
