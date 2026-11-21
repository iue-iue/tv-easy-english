// 字幕を画面に描く部品。字幕の列を受け取り、増えた分・変わった分だけ画面を書き換える。

import { parseGloss } from './translate/prompt.js';

export class SubtitleView {
  constructor(container) {
    this.container = container;
    this.nodes = new Map(); // 字幕のID → 画面上の要素
  }

  /**
   * @param {Array} rows 字幕の列（古い順）[{ id, source, english, kind }]  kind: 'final'=確定 / 'draft'=速報
   * @param {{ maxRows: number, gloss: boolean }} options
   *   maxRows = 同時に表示する数（新しいものから数える）
   *   gloss   = 単語の上に日本語の意味を出すか
   */
  render(rows, { maxRows, gloss }) {
    const visible = rows.slice(-maxRows);
    const keep = new Set(visible.map((r) => r.id));

    for (const [id, node] of this.nodes) {
      if (!keep.has(id)) {
        node.remove();
        this.nodes.delete(id);
      }
    }

    let previous = null;
    for (const [index, row] of visible.entries()) {
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
      // 新しさ（0 がいちばん新しい）。古い字幕ほど薄く表示するために使う。
      const age = String(visible.length - 1 - index);
      if (node.dataset.age !== age) node.dataset.age = age;

      // 並び順をそろえる（新しい字幕が下に入る）。
      const expected = previous ? previous.nextSibling : this.container.firstChild;
      if (node !== expected) this.container.insertBefore(node, expected);
      previous = node;
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
