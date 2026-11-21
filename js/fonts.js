// 字幕（英語）の字体の一覧と、選んだ字体の読み込み。
// 字体のデータは Google Fonts（無料の公開書体の配信元）にあり、選んだ字体だけをタブレットが読み込む。
// 字体を足すときは、Google Fonts にある名前を family に書いて、この一覧に1行足す。

export const FONTS = [
  { id: 'system', label: '標準（タブレットの字体）', family: null },
  { id: 'atkinson', label: 'Atkinson Hyperlegible（見分けやすさ重視）', family: 'Atkinson Hyperlegible Next' },
  { id: 'lexend', label: 'Lexend（読みやすさ重視・幅広）', family: 'Lexend' },
  { id: 'inter', label: 'Inter（画面向け）', family: 'Inter' },
  { id: 'noto-sans', label: 'Noto Sans（くせのない字）', family: 'Noto Sans' },
  { id: 'roboto', label: 'Roboto（Androidでおなじみの字）', family: 'Roboto' },
  { id: 'open-sans', label: 'Open Sans（ゆったりした字）', family: 'Open Sans' },
  { id: 'source-sans', label: 'Source Sans 3（細身の字）', family: 'Source Sans 3' },
  { id: 'nunito', label: 'Nunito（丸みのある字）', family: 'Nunito' },
  { id: 'merriweather', label: 'Merriweather（新聞のような飾りのある字）', family: 'Merriweather', serif: true },
  { id: 'roboto-slab', label: 'Roboto Slab（角ばった飾りのある字）', family: 'Roboto Slab', serif: true },
];

/** 選んだ字体を読み込み、target（字幕を出す面）に適用する。読み込めない間は標準の字体で表示される。 */
export function applyFont(id, target) {
  const font = FONTS.find((f) => f.id === id) || FONTS[0];
  if (!font.family) {
    target.style.removeProperty('--sub-font');
    return;
  }
  const linkId = `font-${font.id}`;
  if (!document.getElementById(linkId)) {
    const link = document.createElement('link');
    link.id = linkId;
    link.rel = 'stylesheet';
    // 太さは、ふつう（400）と太め（600）の2つだけ読み込む。
    link.href = `https://fonts.googleapis.com/css2?family=${font.family.replace(/ /g, '+')}:wght@400;600&display=swap`;
    document.head.append(link);
  }
  target.style.setProperty('--sub-font', `"${font.family}", ${font.serif ? 'serif' : 'system-ui, sans-serif'}`);
}
