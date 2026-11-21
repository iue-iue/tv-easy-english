// 字幕づくりの中心。音声認識の結果を文に区切り、翻訳エンジンに訳させ、画面に出す字幕の列を管理する。
//
// 流れ:
//   1. 音声認識の結果を受け取り、日本語を文の切れ目で区切る。
//   2. 区切った文には、まず速報訳（音声認識エンジン内蔵の翻訳）を灰色で出す。
//   3. 翻訳エンジンの確定訳が届いたら、それに置き換える。
//   4. 確定訳が遅い・失敗したときは、速報訳をそのまま確定として先へ進む。

import { buildSystem, buildMemoSystem, buildUser, cleanOutput, isSkipPrefix } from './translate/prompt.js';

const FIRST_TEXT_TIMEOUT_MS = 3000; // 確定訳がこの時間までに届き始めなければ、速報訳で先へ進む
const TOTAL_TIMEOUT_MS = 7000; // 届き始めても、ここまでに終わらなければ打ち切る
const CONTEXT_ROWS = 5; // 翻訳エンジンに渡す「直前の発言」の数
const MAX_BATCH = 4; // 訳し待ちがたまったとき、まとめて訳す文の上限
const MEMO_FIRST_AFTER = 4; // 最初の話題メモを作るまでの文の数
const MEMO_EVERY_MS = 120000; // 話題メモを作り直す間隔（2分）
const KEEP_ROWS = 12; // 画面から消えたあとも覚えておく字幕の数

let nextId = 1;

function newRow() {
  return {
    id: nextId++,
    source: '', // 確定した日本語
    interimSource: '', // まだ確定していない日本語
    draft: '', // 速報訳（確定分）
    interimDraft: '', // 速報訳（未確定分）
    text: '', // 翻訳エンジンの確定訳
    state: 'live', // live=話している途中 / waiting=訳し待ち / translating=訳している / done=確定 / draft=速報訳で確定
    cutAt: 0,
  };
}

/**
 * 日本語のどこで区切るかを決める。区切る位置（その直前までが1つの文）を返す。なければ -1。
 * 文末（。！？）で区切るのが基本。長い文は、読点（、）の切れ目で一度区切る。
 */
export function findCut(text) {
  const end = /[。！？!?]+[」』）)]*/.exec(text);
  if (end) return end.index + end[0].length;
  if (text.length >= 60) {
    const comma = Math.max(text.lastIndexOf('、', 90), text.lastIndexOf('，', 90));
    if (comma >= 40) return comma + 1;
  }
  if (text.length >= 110) return 110;
  return -1;
}

export class SubtitlePipeline {
  /**
   * @param {object} args
   *   translator  翻訳エンジンの部品（なければ速報訳だけで動く）
   *   sections    読み込んだ指示文
   *   options     { level, style, glossary }
   *   onUpdate    字幕の列が変わるたびに呼ばれる関数
   *   onNotice    利用者に知らせたいこと（エラーなど）があるときに呼ばれる関数
   */
  constructor({ translator, sections, options, onUpdate, onNotice }) {
    this.translator = translator;
    this.sections = sections;
    this.options = options;
    this.onUpdate = onUpdate;
    this.onNotice = onNotice;

    this.rows = []; // 区切り終わった字幕（古い順）
    this.live = newRow(); // いま話している途中の字幕
    this.attr = this.live; // 次に届く速報訳を割り当てる先
    this.queue = []; // 訳し待ち
    this.busy = false;
    this.stopped = false;
    this.history = []; // 直前の発言と字幕（翻訳エンジンに渡す文脈）
    this.recentSources = []; // 話題メモを作るための、最近の発言
    this.topic = '';
    this.doneCount = 0;
    this.memoAt = 0;
    this.memoBusy = false;
    this.sttLagMs = 0;
    this.llmMs = 0; // 文の区切りから確定訳が届き始めるまでの時間（ならした値）
    this.system = null;
  }

  /** 設定（レベル、訳し方、翻訳エンジン）を変える。次の文から反映される。 */
  update({ translator, options }) {
    if (translator !== undefined) this.translator = translator;
    if (options) this.options = options;
    this.system = null;
  }

  systemPrompt() {
    if (!this.system) this.system = buildSystem(this.sections, this.options);
    return this.system;
  }

  // ---- 音声認識の結果を受け取る ----

  handleResult({ finals, interimText, interimTranslation, endpoint, lagMs }) {
    if (this.stopped) return;
    if (typeof lagMs === 'number') this.sttLagMs = this.sttLagMs * 0.7 + lagMs * 0.3;

    // 確定した分を、届いた順に処理する。速報訳は「直前に届いた日本語」の訳なので、その字幕に足す。
    for (const part of finals) {
      if (part.type === 'translation') {
        this.attr.draft += part.text;
      } else {
        this.live.source += part.text;
        this.attr = this.live;
        this.cutSentences();
      }
    }

    // 話し終わりを検出したら、残っている分をそこで区切る。
    if (endpoint && this.live.source.trim()) this.closeLive(this.live.source.length);

    // まだ確定していない分。速報訳は、話している途中の字幕があればそこに、なければ直前の字幕に出す。
    this.live.interimSource = interimText;
    const target = this.live.source || interimText ? this.live : this.attr;
    for (const row of this.rows) row.interimDraft = '';
    this.live.interimDraft = '';
    target.interimDraft = interimTranslation;

    this.emit();
  }

  cutSentences() {
    for (;;) {
      const at = findCut(this.live.source);
      if (at < 0) return;
      this.closeLive(at);
    }
  }

  // 話している途中の字幕を、位置 at で区切って「訳し待ち」に回す。残りは新しい字幕に引き継ぐ。
  closeLive(at) {
    const row = this.live;
    const rest = row.source.slice(at).trimStart();
    row.source = row.source.slice(0, at).trim();
    row.interimSource = '';

    this.live = newRow();
    this.live.source = rest;
    // 文の終わりで区切った直後は、その文の速報訳の続きがまだ届くので、割り当て先は区切った字幕のままにする。
    this.attr = rest ? this.live : row;

    // 句読点だけ、1文字だけのものは字幕にしない。
    if (row.source.replace(/[\s。、！？!?,.，]/g, '').length < 2) return;

    row.state = 'waiting';
    row.cutAt = performance.now();
    this.rows.push(row);
    this.queue.push(row);
    this.recentSources.push(row.source);
    if (this.recentSources.length > 20) this.recentSources.shift();
    this.trim();
    this.pump();
  }

  // ---- 確定訳 ----

  async pump() {
    if (this.busy || this.stopped || !this.queue.length) return;
    this.busy = true;
    // 訳し待ちが2文以上たまっていたら、まとめて1回で訳して追いつく。
    const batch = this.queue.length >= 2 ? this.queue.splice(0, MAX_BATCH) : [this.queue.shift()];
    try {
      await this.translateBatch(batch);
    } finally {
      this.busy = false;
      if (!this.stopped) this.pump();
    }
  }

  // 複数の字幕を1つにまとめる（先頭の字幕に寄せ、残りは消す）。
  merge(batch) {
    const head = batch[0];
    for (const row of batch.slice(1)) {
      head.source += row.source;
      head.draft = `${head.draft} ${row.draft}`.trim();
      head.interimDraft = row.interimDraft || head.interimDraft;
      if (this.attr === row) this.attr = head;
      const i = this.rows.indexOf(row);
      if (i >= 0) this.rows.splice(i, 1);
    }
    return head;
  }

  async translateBatch(batch) {
    const row = this.merge(batch);

    if (!this.translator) {
      this.finishWithDraft(row);
      return;
    }

    row.state = 'translating';
    this.emit();

    const controller = new AbortController();
    let gotText = false;
    let settled = false; // 打ち切ったあとに遅れて届いた分を無視するための印

    // 時間切れ：通信の中断を頼んだうえで、その完了を待たずに先へ進む。
    let giveUp;
    const timedOut = new Promise((_, reject) => {
      giveUp = () => {
        controller.abort();
        const e = new Error('確定訳が時間内に届きませんでした');
        e.aborted = true;
        reject(e);
      };
    });
    const firstTimer = setTimeout(() => {
      if (!gotText) giveUp();
    }, FIRST_TEXT_TIMEOUT_MS);
    const totalTimer = setTimeout(() => giveUp(), TOTAL_TIMEOUT_MS);

    try {
      const request = this.translator.translate({
        system: this.systemPrompt(),
        user: buildUser({ source: row.source, previous: this.history, topic: this.topic }),
        signal: controller.signal,
        onText: (partial) => {
          if (settled || isSkipPrefix(partial)) return;
          if (!gotText) {
            gotText = true;
            const ms = performance.now() - row.cutAt;
            this.llmMs = this.llmMs ? this.llmMs * 0.7 + ms * 0.3 : ms;
          }
          row.text = cleanOutput(partial).text; // 異常に長い返事などは空になり、画面には出ない
          this.emit();
        },
      });
      request.catch(() => {}); // 打ち切ったあとの失敗は、ここで受け流す
      const result = await Promise.race([request, timedOut]);

      const cleaned = cleanOutput(result.text);
      if (result.refused || cleaned.invalid) {
        // モデルが応答を断った場合や、字幕として異常な返事（長すぎるなど）の場合は、速報訳で先へ進む
        row.text = '';
        this.finishWithDraft(row);
      } else if (cleaned.skip) {
        this.remove(row); // 字幕にする内容がない（あいづち、BGMの誤認識など）
      } else {
        row.text = cleaned.text;
        this.finish(row, 'done');
      }
    } catch (e) {
      if (row.text) {
        this.finish(row, 'done'); // 途中まで届いていれば、そこまでを確定とする
      } else {
        this.finishWithDraft(row);
      }
      if (e?.fatal) {
        // キーの誤りなど、何度やっても失敗するもの。以後は速報訳だけで続ける。
        this.translator = null;
        this.onNotice?.({ kind: 'translator', message: `${e.message} 速報訳だけで続けます。` });
      } else if (!e?.aborted) {
        this.onNotice?.({ kind: 'translator-temporary', message: e?.message || String(e) });
      }
    } finally {
      settled = true;
      clearTimeout(firstTimer);
      clearTimeout(totalTimer);
    }
  }

  finishWithDraft(row) {
    this.finish(row, 'draft');
  }

  finish(row, state) {
    row.state = state;
    const en = state === 'done' ? row.text : (row.draft + row.interimDraft).trim();
    this.history.push({ ja: row.source, en });
    if (this.history.length > CONTEXT_ROWS) this.history.shift();
    this.doneCount++;
    this.emit();
    this.maybeUpdateMemo();
  }

  remove(row) {
    const i = this.rows.indexOf(row);
    if (i >= 0) this.rows.splice(i, 1);
    if (this.attr === row) this.attr = this.live;
    this.emit();
  }

  // 古い字幕を忘れる（訳し待ちのものは残す）。
  trim() {
    while (this.rows.length > KEEP_ROWS) {
      const oldest = this.rows[0];
      if (oldest.state === 'waiting' || oldest.state === 'translating') break;
      this.rows.shift();
    }
  }

  // ---- 話題メモ（番組の種類と話題を、数分ごとに短くまとめて翻訳の参考にする） ----

  async maybeUpdateMemo() {
    if (!this.translator || this.memoBusy || this.stopped) return;
    const now = performance.now();
    const due = this.memoAt === 0 ? this.doneCount >= MEMO_FIRST_AFTER : now - this.memoAt >= MEMO_EVERY_MS;
    if (!due) return;
    this.memoBusy = true;
    this.memoAt = now;
    try {
      const memo = await this.translator.complete({
        system: buildMemoSystem(this.sections),
        user: `<transcript>\n${this.recentSources.join('\n')}\n</transcript>`,
      });
      // 2行のメモのはずなので、長すぎる返事は異常とみなして使わない。
      if (memo && memo !== '不明' && memo.length <= 200) this.topic = memo;
    } catch {
      // 話題メモは補助なので、失敗しても字幕は続ける
    } finally {
      this.memoBusy = false;
    }
  }

  // ---- 画面へ渡す ----

  /** 画面に出す字幕の列（古い順）。english が空のものは、日本語だけの行になる。 */
  view() {
    const out = [];
    for (const row of [...this.rows, this.live]) {
      const source = (row.source + row.interimSource).trim();
      const confirmed = row.state === 'done' || (row.state === 'translating' && row.text);
      const english = confirmed ? row.text : (row.draft + row.interimDraft).trim();
      if (!source && !english) continue;
      // 灰色（速報）で出すのは、話している途中と、確定訳を待っている間。
      const kind = confirmed || row.state === 'draft' ? 'final' : 'draft';
      out.push({ id: row.id, source, english, kind });
    }
    return out;
  }

  /** 遅れの目安（秒）。認識の遅れと、翻訳の遅れ。 */
  delays() {
    return { stt: this.sttLagMs / 1000, llm: this.llmMs / 1000 };
  }

  emit() {
    this.onUpdate?.(this.view());
  }

  stop() {
    this.stopped = true;
    this.queue = [];
  }
}
