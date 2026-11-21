// レベルメーター（音の大きさを棒で見せる表示）。
// 大きさは dB（デシベル）で表す。0 が上限で、-60 はほぼ無音。

export const FLOOR_DB = -60;

/** 0〜1 の大きさを dB に直す。上限の 0 を超えた分は 0 として扱う。 */
export function toDb(value, floor = FLOOR_DB) {
  return value > 0 ? Math.min(0, Math.max(floor, 20 * Math.log10(value))) : floor;
}

const percent = (db) => ((Math.min(0, Math.max(FLOOR_DB, db)) - FLOOR_DB) / -FLOOR_DB) * 100;

export class LevelMeter {
  /**
   * @param {object} parts root=メーター全体、cover=光っていない部分を隠す板、peak=最大値の線、
   *   read=数値の表示、clip=音割れの印、onState=状態（off/silent/low/good/hot/clip）が変わったときに呼ぶ関数
   */
  constructor({ root, cover, peak, read, clip, onState }) {
    this.root = root;
    this.cover = cover;
    this.peak = peak;
    this.read = read;
    this.clip = clip;
    this.onState = onState;
    this.active = false;
    this.state = 'off';
    this.reset();
    this.prev = performance.now();
    this.textAt = 0;
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  reset() {
    this.targetDb = FLOOR_DB; // 最新の平均的な大きさ
    this.shownDb = FLOOR_DB; // 画面に出している大きさ（なめらかに下がる）
    this.holdDb = FLOOR_DB; // 最大値の線（しばらく残る）
    this.holdAt = 0;
    this.clipAt = -1e9;
    this.lastAt = -1e9;
    this.recent = []; // 直近3秒の最大値
  }

  setActive(active) {
    if (this.active === active) return;
    this.active = active;
    if (!active) this.reset();
    this.textAt = 0; // すぐに文字を更新する
  }

  /** 0.05秒ごとの音の大きさを受け取る。 */
  push(level) {
    const now = performance.now();
    this.targetDb = toDb(level.rms);
    this.lastAt = now;
    const p = toDb(level.peak);
    if (p >= this.holdDb) {
      this.holdDb = p;
      this.holdAt = now;
    }
    if (level.clipped > 0) this.clipAt = now;
    this.recent.push({ t: now, p });
  }

  frame(now) {
    const dt = Math.min(0.1, Math.max(0, (now - this.prev) / 1000));
    this.prev = now;

    // 音が来なくなったら（0.3秒以上）棒を下げる。上がるのは即座、下がるのはゆっくり。
    const live = this.active && now - this.lastAt < 300;
    const target = live ? this.targetDb : FLOOR_DB;
    this.shownDb = target > this.shownDb ? target : Math.max(target, this.shownDb - 60 * dt);
    if (now - this.holdAt > 1500) this.holdDb = Math.max(FLOOR_DB, this.holdDb - 40 * dt);

    this.cover.style.left = `${percent(this.shownDb)}%`;
    this.peak.style.left = `${percent(this.holdDb)}%`;
    this.peak.style.opacity = this.holdDb > FLOOR_DB ? '1' : '0';

    // 文字は1秒に4回だけ書き換える（ちらつき防止）。
    if (now - this.textAt >= 250) {
      this.textAt = now;
      while (this.recent.length && now - this.recent[0].t > 3000) this.recent.shift();
      let maxDb = FLOOR_DB;
      for (const r of this.recent) if (r.p > maxDb) maxDb = r.p;
      const clipped = now - this.clipAt < 3000;

      let state;
      if (!this.active) state = 'off';
      else if (clipped) state = 'clip';
      else if (maxDb < -50) state = 'silent';
      else if (maxDb < -30) state = 'low';
      else if (maxDb >= -3) state = 'hot';
      else state = 'good';

      this.read.textContent = this.active
        ? `いま ${Math.round(this.shownDb)} dB ／ 最大 ${Math.round(maxDb)} dB`
        : '－';
      this.clip.hidden = !(this.active && clipped);
      this.root.setAttribute('aria-valuenow', String(Math.round(this.shownDb)));
      if (state !== this.state) {
        this.state = state;
        this.onState?.(state);
      }
    }
    requestAnimationFrame(this.frame);
  }
}
