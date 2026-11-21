// 字幕画面の動き。音の入力 → 音声認識 → 字幕づくり（pipeline.js）→ 画面表示 をつなぎ、
// 開始・停止のボタンと、設定の引き出しを動かす。

import { MicSource } from './audio/capture.js';
import { RecordingSource } from './audio/replay.js';
import * as store from './audio/recordings.js';
import { toDb, FLOOR_DB } from './meter.js';
import { loadSettings, saveSettings } from './settings.js';
import { STT_ENGINES } from './stt/index.js';
import { TRANSLATORS, QUALITY_MODES } from './translate/index.js';
import { LEVELS, STYLES, loadPrompt } from './translate/prompt.js';
import { SubtitlePipeline } from './pipeline.js';
import { SubtitleView } from './subtitle-view.js';

const $ = (id) => document.getElementById(id);

const FONT_MIN = 2.4;
const FONT_MAX = 10;
const BAR_HIDE_MS = 5000; // 動かしている間、下のバーを隠すまでの時間

const settings = loadSettings();
const view = new SubtitleView($('subs'));

// ---- いまの状態 ----
let running = false;
let starting = false;
let source = null; // 音の入力（マイク、または保存した録音）
let stt = null; // 音声認識
let pipeline = null; // 字幕づくり
let lastRows = [];
let wakeLock = null;
let barTimer = null;
let noticeTimer = null;
let statusTimer = null;
let finishTimer = null;

// ---- 表示まわり ----

function showNotice(text, { sticky = false } = {}) {
  clearTimeout(noticeTimer);
  $('notice').textContent = text;
  $('notice').hidden = !text;
  if (text && !sticky) noticeTimer = setTimeout(() => showNotice(''), 9000);
}

function setState(state) {
  const text = {
    idle: '停止中',
    connecting: '接続中…',
    open: '字幕中',
    reconnecting: '再接続中…',
    closed: '停止中',
  };
  $('stState').dataset.state = state === 'closed' ? 'idle' : state;
  $('stStateText').textContent = text[state] || state;
}

function applyDisplay() {
  const d = settings.display;
  $('stage').style.setProperty('--sub-size', `${d.fontSize}vh`);
  $('subs').dataset.source = d.showSource ? 'on' : 'off';
  $('subs').dataset.gloss = d.gloss ? 'on' : 'off';
  $('fontSize').value = d.fontSize;
  $('fontSizeOut').textContent = `（画面の高さの ${d.fontSize.toFixed(1)}％）`;
  $('stLevel').textContent = settings.translation.level;
  renderSubs();
}

function renderSubs() {
  view.render(lastRows, { maxRows: settings.display.rows, gloss: settings.display.gloss });
}

function updateWelcome() {
  const hasSoniox = !!settings.keys.soniox;
  const hasClaude = !!settings.keys.anthropic;
  let text;
  if (!hasSoniox) {
    text = '最初に、設定でSonioxのAPIキーを入力してください。';
  } else if (!hasClaude) {
    text = 'ClaudeのAPIキーが未入力です。開始すると、速報訳（Sonioxの翻訳）だけで字幕を出します。';
  } else {
    text = 'テレビをつけて「開始」を押してください。';
  }
  $('welcomeText').textContent = text;
  $('btnStartBig').textContent = hasSoniox ? '開始' : '設定を開く';
  $('welcome').hidden = running || starting || lastRows.length > 0;
}

function renderControls() {
  const toggle = $('btnToggle');
  toggle.textContent = running ? '停止' : starting ? '準備中…' : '開始';
  toggle.classList.toggle('btn-stop', running);
  toggle.classList.toggle('btn-primary', !running);
  toggle.disabled = starting;
  $('btnStartBig').disabled = starting;
  updateWelcome();
}

// 下のバー：止まっている間は出したまま。動かしている間は、しばらく操作がないと隠す。
function showBar() {
  document.body.classList.remove('bar-hidden');
  clearTimeout(barTimer);
  if (running && !document.body.classList.contains('panel-open')) {
    barTimer = setTimeout(() => document.body.classList.add('bar-hidden'), BAR_HIDE_MS);
  }
}

function setPanel(open) {
  document.body.classList.toggle('panel-open', open);
  $('panel').inert = !open;
  $('btnPanel').setAttribute('aria-expanded', String(open));
  if (open) refreshSources();
  showBar();
}

function updateMeter(level) {
  const db = toDb(level.rms);
  $('miniFill').style.width = `${((db - FLOOR_DB) / -FLOOR_DB) * 100}%`;
  $('miniFill').dataset.clip = level.clipped > 0 ? 'on' : 'off';
}

function updateStatus() {
  if (!pipeline) return;
  const { stt: sttLag, llm } = pipeline.delays();
  const total = sttLag + llm;
  $('stDelay').hidden = !(total > 0);
  $('stDelay').textContent = `遅れ 約${total.toFixed(1)}秒`;
  $('stDelay').title = `認識 ${sttLag.toFixed(1)}秒 ＋ 翻訳 ${llm.toFixed(1)}秒`;
}

// ---- 画面を消灯させない ----

async function holdWakeLock() {
  try {
    if (!wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch {
    // 対応していない端末や、省電力モードでは何もしない
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// ---- 部品を作る ----

function pipelineOptions() {
  const t = settings.translation;
  return { level: t.level, style: t.style, glossary: [], gloss: settings.display.gloss };
}

// 翻訳エンジンを作る。キーが未入力なら null（速報訳だけで動く）。
function makeTranslator() {
  const t = settings.translation;
  const engine = TRANSLATORS[t.engine] || TRANSLATORS.claude;
  const apiKey = settings.keys[engine.keyName];
  if (!apiKey) return null;
  return engine.create({ apiKey, model: t.model, quality: t.quality });
}

function explainMicError(e) {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'マイクの使用が許可されていません。アドレスバーの左端のマークから、マイクを許可してください。';
    case 'NotFoundError':
      return '音声の入力機器が見つかりません。';
    case 'NotReadableError':
    case 'AbortError':
      return '入力機器を開けませんでした。ほかのアプリがマイクを使っていないか確認してください。';
    default:
      return `音の入力を開始できませんでした（${e?.name || 'エラー'}：${e?.message || '原因不明'}）`;
  }
}

// 音の入力を作って動かす。マイクは、確認ページで選んだ設定を使う。
async function startSource(onChunk) {
  if (settings.source !== 'mic') {
    let pcm;
    try {
      pcm = await store.loadPcm(settings.source);
    } catch {
      throw new Error('選んだ録音が見つかりません。設定の「字幕にする音」を選び直してください。');
    }
    const player = new RecordingSource(pcm, { audible: true });
    player.onChunk = onChunk;
    player.onEnd = () => finishAfterRecording();
    await player.start();
    return player;
  }

  const mode = settings.input.mode;
  const open = async (deviceId) => {
    const mic = new MicSource({ deviceId, ...settings.input.processing[mode] });
    mic.onChunk = onChunk;
    mic.onEnd = () => {
      stop();
      showNotice('音の入力が切れました。機器が抜かれたか、マイクの許可が取り消されました。', { sticky: true });
    };
    await mic.start();
    return mic;
  };
  try {
    return await open(settings.input.deviceId[mode]);
  } catch (e) {
    // 前に選んだ機器が見つからないときは、タブレットの既定の入力で開き直す。
    if (settings.input.deviceId[mode] && (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError')) {
      try {
        return await open('');
      } catch (e2) {
        throw new Error(explainMicError(e2));
      }
    }
    throw new Error(explainMicError(e));
  }
}

// ---- 開始と停止 ----

async function start() {
  if (running || starting) return;
  const sttEngine = STT_ENGINES[settings.stt.engine] || STT_ENGINES.soniox;
  const sttKey = settings.keys[sttEngine.keyName];
  if (!sttKey) {
    setPanel(true);
    showNotice('SonioxのAPIキーを入力してから、もう一度「開始」を押してください。');
    $('keySoniox').focus();
    return;
  }

  starting = true;
  clearTimeout(finishTimer);
  showNotice('');
  lastRows = [];
  view.clear();
  renderControls();
  setState('connecting');

  // 全画面と横向き固定は、できる端末でだけ行う（失敗しても続ける）。
  document.documentElement
    .requestFullscreen?.()
    .then(() => screen.orientation?.lock?.('landscape'))
    .catch(() => {});

  // 音の入力は、ボタンを押した直後に開き始める（あとからだと音声処理を止めるブラウザがあるため）。
  const sourcePromise = startSource((pcm, level) => {
    stt?.sendAudio(pcm);
    updateMeter(level);
  });
  try {
    const [opened, sections] = await Promise.all([sourcePromise, loadPrompt()]);
    source = opened;

    const translator = makeTranslator();
    pipeline = new SubtitlePipeline({
      translator,
      sections,
      options: pipelineOptions(),
      onUpdate: (rows) => {
        lastRows = rows;
        renderSubs();
      },
      onNotice: (notice) => showNotice(notice.message, { sticky: notice.kind === 'translator' }),
    });

    stt = sttEngine.create({ apiKey: sttKey, glossary: [] });
    const current = pipeline;
    stt.onResult = (result) => current.handleResult(result);
    stt.onState = (state) => {
      if (running || starting) setState(state);
    };
    stt.onError = ({ message, fatal }) => {
      showNotice(message, { sticky: fatal });
      if (fatal) stop();
    };
    stt.start();

    running = true;
    starting = false;
    holdWakeLock();
    statusTimer = setInterval(updateStatus, 1000);
    if (!translator) showNotice('ClaudeのAPIキーが未入力のため、速報訳だけで字幕を出しています。');
  } catch (e) {
    starting = false;
    stop();
    // 途中で失敗した場合、開いてしまった音の入力があれば閉じる。
    sourcePromise.then(
      (opened) => opened.stop(),
      () => {},
    );
    showNotice(e?.message || String(e), { sticky: true });
  }
  renderControls();
  showBar();
}

/** すべて止める。画面の字幕は、次に開始するまで残す。 */
function stop() {
  clearTimeout(finishTimer);
  clearInterval(statusTimer);
  if (source) {
    source.onChunk = null;
    source.onEnd = null;
    source.stop();
  }
  source = null;
  stt?.stop();
  stt = null;
  pipeline?.stop();
  running = false;
  starting = false;
  releaseWakeLock();
  setState('idle');
  $('miniFill').style.width = '0%';
  renderControls();
  showBar();
}

// 録音を最後まで流し終えたとき：残りの認識結果と確定訳を受け取ってから止める。
function finishAfterRecording() {
  if (!running) return;
  source = null;
  stt?.finish();
  finishTimer = setTimeout(() => {
    stop();
    showNotice('録音を最後まで流しました。');
  }, 9000);
}

// ---- 設定の引き出し ----

function fillSelect(select, items, value) {
  select.textContent = '';
  for (const item of items) select.append(new Option(item.label, item.id));
  select.value = value;
}

async function refreshSources() {
  const select = $('source');
  let list = [];
  try {
    list = await store.listRecordings();
  } catch {
    // 録音の一覧が読めなくても、マイクは使える
  }
  select.textContent = '';
  select.append(new Option('テレビの音（マイク）', 'mic'));
  for (const rec of list) {
    const seconds = Math.round(rec.durationSec);
    select.append(new Option(`録音：${rec.name}（${Math.floor(seconds / 60)}分${seconds % 60}秒）`, rec.id));
  }
  if (![...select.options].some((o) => o.value === settings.source)) settings.source = 'mic';
  select.value = settings.source;
}

function changed() {
  saveSettings(settings);
  applyDisplay();
  updateWelcome();
}

// 翻訳の設定を変えたら、動いている字幕づくりに次の文から反映する。
function translationChanged() {
  $('quickLevel').value = settings.translation.level;
  $('level').value = settings.translation.level;
  changed();
  pipeline?.update({ translator: makeTranslator(), options: pipelineOptions() });
}

function setFontSize(value) {
  settings.display.fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(value * 10) / 10));
  changed();
}

function initControls() {
  const t = settings.translation;
  const engine = TRANSLATORS[t.engine] || TRANSLATORS.claude;
  fillSelect($('level'), LEVELS, t.level);
  fillSelect($('quickLevel'), LEVELS.map((l) => ({ id: l.id, label: l.id })), t.level);
  fillSelect($('style'), STYLES, t.style);
  fillSelect($('model'), engine.models, t.model);
  fillSelect($('quality'), QUALITY_MODES, t.quality);
  $('rows').value = String(settings.display.rows);
  $('chkSource').checked = settings.display.showSource;
  $('chkGloss').checked = settings.display.gloss;
  $('keySoniox').value = settings.keys.soniox;
  $('keyAnthropic').value = settings.keys.anthropic;

  for (const [id, key] of [
    ['level', 'level'],
    ['quickLevel', 'level'],
    ['style', 'style'],
    ['model', 'model'],
    ['quality', 'quality'],
  ]) {
    $(id).addEventListener('change', () => {
      settings.translation[key] = $(id).value;
      translationChanged();
    });
  }

  $('fontSize').addEventListener('input', () => setFontSize(Number($('fontSize').value)));
  $('btnSmaller').addEventListener('click', () => setFontSize(settings.display.fontSize - 0.4));
  $('btnLarger').addEventListener('click', () => setFontSize(settings.display.fontSize + 0.4));
  $('rows').addEventListener('change', () => {
    settings.display.rows = Number($('rows').value);
    changed();
  });
  $('chkSource').addEventListener('change', () => {
    settings.display.showSource = $('chkSource').checked;
    changed();
  });
  $('chkGloss').addEventListener('change', () => {
    settings.display.gloss = $('chkGloss').checked;
    translationChanged();
  });

  for (const [id, key] of [
    ['keySoniox', 'soniox'],
    ['keyAnthropic', 'anthropic'],
  ]) {
    $(id).addEventListener('change', () => {
      settings.keys[key] = $(id).value.trim();
      $(id).value = settings.keys[key];
      changed();
    });
  }
  $('chkShowKeys').addEventListener('change', () => {
    const type = $('chkShowKeys').checked ? 'text' : 'password';
    $('keySoniox').type = type;
    $('keyAnthropic').type = type;
  });

  $('source').addEventListener('change', () => {
    settings.source = $('source').value;
    changed();
  });

  $('btnToggle').addEventListener('click', () => (running ? stop() : start()));
  $('btnStartBig').addEventListener('click', () => (settings.keys.soniox ? start() : setPanel(true)));
  $('btnPanel').addEventListener('click', () => setPanel(!document.body.classList.contains('panel-open')));
  $('btnPanelClose').addEventListener('click', () => setPanel(false));

  // 画面のどこかを押したら、下のバーを出す。
  $('stage').addEventListener('pointerdown', showBar);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setPanel(false);
    showBar();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && running) holdWakeLock();
  });
}

// ---- 最初に行うこと ----

if (!window.isSecureContext) {
  showNotice('このページは https:// で始まるアドレスで開いてください。http:// ではマイクが使えません。', { sticky: true });
}
initControls();
applyDisplay();
setState('idle');
renderControls();
refreshSources();
