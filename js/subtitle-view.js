// 字幕を画面に描く部品。字幕の列を受け取り、増えた分・変わった分だけ画面を書き換える。
// 字幕の位置が変わるときは、一気に飛ばさず、なめらかに動かす。

import { parseGloss } from './translate/prompt.js';

const MOVE = 'transform 0.32s cubic-bezier(0.2, 0.7, 0.3, 1), opacity 0.32s ease';
const MAX_ROWS = 10; // 画面に置いておく字幕の上限。画面に収まらない古い字幕は、上端で自然に見えなくなる。

export class SubtitleView {
  constructor(container) {
    this.container = container;
    this.nodes = new Map(); // 字幕のID → 画面上の要素
    // 端末の設定で「動きを減らす」が選ばれているときは、動かさずに切り替える。
    this.motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  }

  /**
   * @param {Array} rows 字幕の列（古い順）[{ id, source, english, kind }]  kind: 'final'=確定 / 'draft'=速報
   * @param {{ gloss: boolean, showSource: boolean, draft: string }} options
   *   gloss      = 単語の上に日本語の意味を出すか
   *   showSource = 日本語の原文を出すか
   *   draft      = 速報訳の出し方（'show' | 'small' | 'hide'）
   */
  render(rows, { gloss, showSource, draft }) {
    const animate = !this.motion.matches;
    const visible = rows.slice(-MAX_ROWS);
    const keep = new Set(visible.map((r) => r.id));

    // 書き換える前に、いま見えている位置を覚えておく（動いている途中なら、その途中の位置）。
    // まだ何も表示していない字幕は覚えない。あとで「新しく入ってくる字幕」として扱う。
    const before = new Map();
    if (animate) {
      for (const [id, node] of this.nodes) {
        if (!keep.has(id) || node.hidden) continue;
        const rect = node.getBoundingClientRect();
        if (rect.height > 0) before.set(id, rect.top);
      }
    }

    for (const [id, node] of this.nodes) {
      if (!keep.has(id)) {
        node.remove();
        this.nodes.delete(id);
      }
    }

    let previous = null;
    for (const row of visible) {
      let node = this.nodes.get(row.id);
      if (!node) {
        node = document.createElement('div');
        node.className = 'sub';
        const en = document.createElement('p');
        en.className = 'sub-en';
        en.lang = 'en';
        const ja = document.createElement('p');
        ja.className = 'sub-ja';
        node.append(en, ja);
        this.nodes.set(row.id, node);
      }
      const [en, ja] = node.children;
      const key = `${gloss ? 'g' : 'p'}:${row.english}`;
      if (node.dataset.key !== key) {
        node.dataset.key = key;
        this.fillEnglish(en, row.english, gloss);
      }
      if (ja.textContent !== row.source) ja.textContent = row.source;
      if (node.dataset.kind !== row.kind) node.dataset.kind = row.kind;

      // 表示するものが何もない字幕（原文は非表示、英語はまだ無いか非表示）は、場所を取らないように隠す。
      const englishShown = !!row.english && !(row.kind === 'draft' && draft === 'hide');
      const shown = englishShown || (showSource && !!row.source);
      if (node.hidden === shown) node.hidden = !shown;

      // 並び順をそろえる（新しい字幕が下に入る）。
      const expected = previous ? previous.nextSibling : this.container.firstChild;
      if (node !== expected) this.container.insertBefore(node, expected);
      previous = node;
    }

    // 新しさ（0 がいちばん新しい）。古い字幕ほど薄く表示するために使う。隠している字幕は数えない。
    let age = 0;
    for (const row of [...visible].reverse()) {
      const node = this.nodes.get(row.id);
      if (node.hidden) continue;
      if (node.dataset.age !== String(age)) node.dataset.age = String(age);
      age++;
    }

    if (animate) this.glide(before);
  }

  // 書き換えで位置が変わった字幕を、元の位置から新しい位置へなめらかに動かす。
  // 手順：新しい位置を測る → いったん元の位置にずらして置く → ずれをゼロに戻す動きを付ける。
  glide(before) {
    const nodes = [...this.nodes].filter(([, node]) => !node.hidden);
    for (const [, node] of nodes) {
      node.style.transition = 'none';
      node.style.transform = 'none';
    }
    const moves = [];
    for (const [id, node] of nodes) {
      if (before.has(id)) {
        const dy = before.get(id) - node.getBoundingClientRect().top;
        if (Math.abs(dy) > 0.5) moves.push([node, dy, false]);
      } else {
        // 新しく表示する字幕は、自分の高さぶん下から入ってくる。
        moves.push([node, node.offsetHeight, true]);
      }
    }
    for (const [node, dy, isNew] of moves) {
      node.style.transform = `translateY(${dy}px)`;
      if (isNew) node.style.opacity = '0';
    }
    if (moves.length) void this.container.offsetHeight; // ここで「ずらした位置」を確定させる
    for (const [, node] of nodes) {
      node.style.transition = MOVE;
      node.style.transform = '';
      node.style.opacity = '';
    }
  }

  // 英語の字幕を書き込む。意味つきの単語は、単語の真上に日本語を小さく載せる（ふりがなと同じ仕組み）。
  fillEnglish(en, english, gloss) {
    en.textContent = '';
    for (const part of parseGloss(english)) {
      if (gloss && part.gloss) {
        const ruby = document.createElement('ruby');
        ruby.append(part.text);
        const rt = document.createElement('rt');
        rt.lang = 'ja';
        rt.textContent = part.gloss;
        ruby.append(rt);
        en.append(ruby);
      } else {
        en.append(part.text);
      }
    }
  }

  clear() {
    this.container.textContent = '';
    this.nodes.clear();
  }
}
