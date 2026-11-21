// 翻訳の指示文（prompts/translate.md）を読み込み、翻訳エンジンへ渡す文章を組み立てる部品。
// 指示文そのものは prompts/translate.md にあり、利用者が文章を読んで直せる。

const PROMPT_URL = new URL('../../prompts/translate.md', import.meta.url);

/** 英語のレベル（CEFR：語学力の国際的な目安）。id は指示文の見出し「レベル A1」などに対応する。 */
export const LEVELS = [
  { id: 'Pre-A1', label: 'Pre-A1（英検4級程度）' },
  { id: 'A1', label: 'A1（英検3級程度）' },
  { id: 'A2', label: 'A2（英検準2級程度）' },
  { id: 'B1', label: 'B1（英検2級程度）' },
  { id: 'B2', label: 'B2（英検準1級程度）' },
  { id: 'C1', label: 'C1（英検1級程度）' },
];

/**
 * 単語に日本語の意味を付ける設定の選択肢。
 * off = 付けない / same = 字幕のレベルと同じ単語だけ / レベルのid = そのレベル以上の単語
 */
export const GLOSS_OPTIONS = [
  { id: 'off', label: '付けない' },
  { id: 'same', label: '字幕のレベルと同じ単語だけ' },
  ...LEVELS.map((l) => ({ id: l.id, label: `${l.label}以上の単語` })),
];

const GLOSS_PLACEHOLDER = '{{注釈する単語}}';
const MAX_SUBTITLE_CHARS = 220; // これより長い返事は字幕として異常とみなす（指示の上限は84字）

/** 訳し方。section は指示文の見出しの名前。 */
export const STYLES = [
  { id: 'standard', label: '標準', section: '訳し方 標準' },
  { id: 'gist', label: '要点だけ', section: '訳し方 要点だけ' },
  { id: 'faithful', label: '原文に忠実', section: '訳し方 原文に忠実' },
];

let sectionsPromise = null;

// 「## 見出し」ごとに本文を取り出す。最初の見出しより前（ファイルの説明）は使わない。
function parseSections(text) {
  const sections = new Map();
  let title = null;
  let lines = [];
  const flush = () => {
    if (title) sections.set(title, lines.join('\n').trim());
  };
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      title = heading[1];
      lines = [];
    } else if (title) {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

/** 指示文を読み込む（1回読んだら使い回す）。 */
export function loadPrompt() {
  if (!sectionsPromise) {
    sectionsPromise = fetch(PROMPT_URL, { cache: 'no-cache' })
      .then((res) => {
        if (!res.ok) throw new Error(`翻訳の指示文を読み込めませんでした（${res.status}）`);
        return res.text();
      })
      .then(parseSections)
      .catch((e) => {
        sectionsPromise = null; // 次回また読みに行けるようにする
        throw e;
      });
  }
  return sectionsPromise;
}

function need(sections, title) {
  const body = sections.get(title);
  if (!body) throw new Error(`翻訳の指示文（prompts/translate.md）に見出し「## ${title}」がありません`);
  return body;
}

/**
 * 翻訳エンジンへの指示（毎回同じ部分）を作る。
 * glossary は用語集：[{ ja: '日本語の表記', reading: '読み', en: '英語での表記' }]
 */
export function buildSystem(sections, { level, style, glossary = [], gloss = 'off' }) {
  const styleInfo = STYLES.find((s) => s.id === style) || STYLES[0];
  const parts = [need(sections, '共通ルール'), need(sections, `レベル ${level}`), need(sections, styleInfo.section)];
  // 単語に日本語の意味を付けさせる場合は、どのレベルの単語に付けるかを指示文に書き込む。
  if (gloss && gloss !== 'off') {
    const label = (id) => LEVELS.find((l) => l.id === id)?.label || id;
    const target =
      gloss === 'same' ? `字幕のレベル（CEFR ${label(level)}）にちょうど当たる単語` : `CEFR ${label(gloss)} 以上の難しさの単語`;
    const body = need(sections, '単語の注釈');
    parts.push(body.includes(GLOSS_PLACEHOLDER) ? body.replace(GLOSS_PLACEHOLDER, target) : `${body}\n\n意味を付ける対象：${target}`);
  }
  if (glossary.length) {
    const rows = glossary.map((g) => `- ${g.ja}${g.reading ? `（${g.reading}）` : ''} → ${g.en}`);
    parts.push(`用語集（次の言葉は、必ずこの英語表記を使う）\n${rows.join('\n')}`);
  }
  return parts.join('\n\n');
}

/** 話題メモを作らせるときの指示。 */
export function buildMemoSystem(sections) {
  return need(sections, '話題メモ');
}

/**
 * 1回ぶんの依頼文（毎回変わる部分）を作る。
 * previous は直前の発言と字幕：[{ ja, en }]、topic は話題メモ。
 */
export function buildUser({ source, previous = [], topic = '' }) {
  const parts = [];
  if (topic) parts.push(`<topic>\n${topic}\n</topic>`);
  if (previous.length) {
    const lines = previous.map((p) => `発言：${p.ja}\n字幕：${p.en || '（字幕なし）'}`);
    parts.push(`<previous>\n${lines.join('\n')}\n</previous>`);
  }
  parts.push(`<source>\n${source}\n</source>`);
  return parts.join('\n\n');
}

/**
 * 返ってきた文章を字幕用に整える。
 *   skip=true    「字幕にする内容がない」という返事
 *   invalid=true 字幕として異常な返事（長すぎる、考えた内容が混じっている など）。画面には出さない。
 */
export function cleanOutput(raw) {
  let text = (raw || '').trim();
  // 考えた内容をタグつきで書いてきた場合は、その部分を捨てる
  text = text.replace(/<thinking>[\s\S]*?(<\/thinking>|$)/gi, '').trim();
  // 引用符で囲んで返してきた場合は外す
  text = text.replace(/^["“”']+|["“”']+$/g, '').trim();
  if (!text || /^\[?\s*skip\s*\]?\.?$/i.test(text)) return { text: '', skip: true, invalid: false };
  text = text.replace(/\s*\n+\s*/g, ' ');
  // 長さは、単語の意味の印 {英語|日本語} を除いた英文で数える
  const plain = text.replace(/\{([^{}|]*)\|[^{}]*\}/g, '$1');
  if (plain.length > MAX_SUBTITLE_CHARS) return { text: '', skip: false, invalid: true };
  return { text, skip: false, invalid: false };
}

/**
 * 字幕の文章を、ふつうの部分と「日本語の意味つきの単語」に分ける。
 * 翻訳エンジンは、意味を付ける単語を {英語|日本語} と書いて返す。
 * 例：'give cash to {households|世帯}.' → [{ text: 'give cash to ' }, { text: 'households', gloss: '世帯' }, { text: '.' }]
 * 途中まで届いた書きかけ（閉じていない { ）は、英語の部分だけを出す。
 */
export function parseGloss(text) {
  const parts = [];
  const pattern = /\{([^{}|]+)\|([^{}|]*)\}/g;
  let last = 0;
  let m;
  const plain = (s) => {
    // 書きかけの {英語|日本… は、英語の部分だけ残す。残った記号は消す。
    const cleaned = s.replace(/\{([^{}|]*)(\|[^{}]*)?$/, '$1').replace(/[{}|]/g, '');
    if (cleaned) parts.push({ text: cleaned });
  };
  while ((m = pattern.exec(text))) {
    plain(text.slice(last, m.index));
    const gloss = m[2].trim();
    parts.push(gloss ? { text: m[1], gloss } : { text: m[1] });
    last = m.index + m[0].length;
  }
  plain(text.slice(last));
  return parts;
}

/** 途中まで届いた文章が「[skip]」の書きかけかどうか（書きかけの間は画面に出さない）。 */
export function isSkipPrefix(partial) {
  const t = (partial || '').trim().toLowerCase();
  return t.length > 0 && '[skip]'.startsWith(t);
}
