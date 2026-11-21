// 「音の入り口の確認」ページ（フェーズ0）の画面の動き。
// 音の取り込みや保存そのものは js/audio/ の部品が行い、ここはボタンと表示をつなぐ役。

import { MicSource, listAudioInputs, TARGET_RATE } from './audio/capture.js';
import { RecordingSource } from './audio/replay.js';
import { concatPcm, levelOf, pcmToWavBlob } from './audio/pcm.js';
import * as store from './audio/recordings.js';
import { LevelMeter, toDb } from './meter.js';
import { loadSettings, saveSettings } from './settings.js';

const $ = (id) => document.getElementById(id);

const SHORT_SECONDS = 10; // お試し録音の長さ
const LONG_MAX_SECONDS = 180; // 比較用の録音の上限（3分）
const LONG_MIN_SECONDS = 5; // これより短い録音は保存しない
const MEASURE_SECONDS = 5; // 有線の確認で測る長さ
const CHUNKS_PER_SECOND = TARGET_RATE / 800; // 音は0.05秒ごとに届く

const MODE_LABEL = { mic: '内蔵マイク', line: '有線（USB）' };
const MODE_HINT = {
  mic: 'テレビのスピーカーの音を、タブレットのマイクで拾います。',
  line: 'テレビのイヤホン端子から、USBオーディオインターフェース経由で取り込みます。音の加工はすべてオフが基本です。',
};
const PROCESSING = [
  ['echoCancellation', 'エコーキャンセル', 'chkEc'],
  ['noiseSuppression', 'ノイズ抑制', 'chkNs'],
  ['autoGainControl', '自動音量調整', 'chkAgc'],
];

const settings = loadSettings();

// ---- いまの状態 ----
let source = null; // 動いている入力（マイク、または録音の再生）
let sourceKind = null; // 'mic' | 'replay'
let replayId = null; // 入力として流している録音
let recorder = null; // 録音中ならその入れ物
let recKind = null; // 'short' | 'long'
let measure = null; // 有線の確認で測定中ならその入れ物
let starting = false; // 入力の準備中
let wakeLock = null; // 画面を消灯させないための予約
let shortUrl = null;
let listUrls = [];
const measured = { a: null };

const meter = new LevelMeter({
  root: $('meter'),
  cover: $('meterCover'),
  peak: $('meterPeak'),
  read: $('meterRead'),
  clip: $('clipBadge'),
  onState: () => updateAdvice(),
});

// ---- 小さな道具 ----

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function showAlert(text) {
  $('alert').textContent = text;
  $('alert').hidden = !text;
}

function formatClock(seconds) {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  return s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`;
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function explainError(e) {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'マイクの使用が許可されていません。アドレスバーの左端のマーク →「権限」→「マイク」を許可してから、もう一度押してください。';
    case 'NotFoundError':
      return '音声の入力機器が見つかりません。';
    case 'NotReadableError':
    case 'AbortError':
      return '入力機器を開けませんでした。ほかのアプリがマイクを使っていないか確認してください。';
    case 'OverconstrainedError':
      return '選んだ入力機器が使えません。入力機器を「おまかせ」に戻して試してください。';
    case 'InsecureContextError':
      return 'このページは https:// で始まるアドレスで開く必要があります。';
    default:
      return `入力を開始できませんでした（${e?.name || 'エラー'}：${e?.message || '原因不明'}）`;
  }
}

// ---- 画面の消灯防止 ----

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

// ---- 音を受け取る（マイクでも録音の再生でも同じ） ----

function handleChunk(pcm, level) {
  meter.push(level);
  recorder?.add(pcm);
  measure?.add(level);
}

function updateAdvice() {
  const line = sourceKind === 'mic' && settings.input.mode === 'line';
  const text = {
    off: '「入力を開始」を押すと、音の大きさがここに出ます。',
    silent: '音がほとんど入っていません。',
    low: line
      ? '小さめです。テレビの音量を少し上げてください。'
      : '小さめです。テレビの音量を上げるか、タブレットを近づけてください。',
    good: 'ちょうどよい大きさです。',
    hot: '大きめです。もう少し下げると安心です。',
    clip: line
      ? '大きすぎて音が割れています。テレビの音量を下げてください。'
      : '大きすぎて音が割れています。テレビの音量を下げるか、タブレットを離してください。',
  };
  const advice = $('advice');
  advice.textContent = text[meter.state] || '';
  advice.dataset.state = meter.state;
}

// ---- 入力の開始と停止 ----

async function startMic(isRetry = false) {
  if (starting) return false;
  stopSource();
  starting = true;
  showAlert('');
  render();

  const mode = settings.input.mode;
  const requestedId = $('device').value;
  const mic = new MicSource({ deviceId: requestedId, ...settings.input.processing[mode] });
  mic.onChunk = handleChunk;
  mic.onEnd = () => {
    if (source !== mic) return;
    stopSource();
    showAlert('入力が切れました。機器が抜かれたか、マイクの許可が取り消されました。');
  };
  mic.onMute = (muted) => {
    if (source === mic) showAlert(muted ? '入力から音が届いていません（端末側で一時的に止められています）。' : '');
  };

  try {
    await mic.start();
  } catch (e) {
    starting = false;
    showAlert(explainError(e));
    render();
    return false;
  }

  starting = false;
  source = mic;
  sourceKind = 'mic';
  showActual(mic.info, requestedId);
  render();
  holdWakeLock();

  // マイクが許可されると機器の名前が取れるので、一覧を作り直す。
  await refreshDevices();
  // 前回選んだ機器が一覧に現れた場合は、その機器でつなぎ直す（1回だけ）。
  if (!isRetry && source === mic && !recorder && !measure && $('device').value !== requestedId) {
    return startMic(true);
  }
  return true;
}

async function ensureMic() {
  if (sourceKind === 'mic') return true;
  return startMic();
}

async function startReplay(meta) {
  if (starting || recorder || measure) return;
  stopSource();
  starting = true;
  showAlert('');
  render();
  try {
    const pcm = await store.loadPcm(meta.id);
    const player = new RecordingSource(pcm, { audible: settings.replayAudible });
    player.onChunk = handleChunk;
    player.onEnd = () => {
      if (source === player) stopSource();
    };
    await player.start();
    source = player;
    sourceKind = 'replay';
    replayId = meta.id;
    holdWakeLock();
  } catch (e) {
    showAlert(`録音を流せませんでした（${e?.message || e}）`);
  }
  starting = false;
  render();
}

function stopSource() {
  recorder?.finish(); // 録音中なら、そこまでの分で締める
  measure?.cancel();
  if (source) {
    source.onChunk = null;
    source.onEnd = null;
    source.stop();
  }
  source = null;
  sourceKind = null;
  replayId = null;
  releaseWakeLock();
  $('actual').hidden = true;
  render();
}

// ---- 画面の表示をいまの状態に合わせる ----

function setPill(state, text) {
  $('status').dataset.state = state;
  $('status').textContent = text;
}

function render() {
  const running = !!source;
  const locked = starting || !!recorder || !!measure;

  if (starting) setPill('starting', '準備中…');
  else if (sourceKind === 'mic') setPill('live', `入力中：${MODE_LABEL[settings.input.mode]}`);
  else if (sourceKind === 'replay') setPill('replay', '録音を入力として再生中');
  else setPill('idle', '停止中');

  const toggle = $('btnToggle');
  toggle.textContent = running ? '停止' : '入力を開始';
  toggle.classList.toggle('btn-stop', running);
  toggle.classList.toggle('btn-primary', !running);
  toggle.disabled = starting;

  $('inputSet').disabled = locked;
  $('btnShort').disabled = locked;

  const long = $('btnLong');
  long.textContent = recKind === 'long' ? '終了して保存' : '録音を開始';
  long.classList.toggle('btn-stop', recKind === 'long');
  long.classList.toggle('btn-primary', recKind !== 'long');
  long.disabled = starting || !!measure || recKind === 'short';

  $('btnMeasureA').disabled = locked;
  $('btnMeasureB').disabled = locked || measured.a == null;

  for (const button of document.querySelectorAll('[data-replay]')) {
    button.textContent = replayId === button.dataset.replay ? '流すのを止める' : '入力として流す';
    button.disabled = locked;
  }

  meter.setActive(running);
  updateAdvice();
}

// ---- 1. 入力の設定 ----

function renderInput() {
  const mode = settings.input.mode;
  $('modeMic').checked = mode === 'mic';
  $('modeLine').checked = mode === 'line';
  $('modeHint').textContent = MODE_HINT[mode];
  for (const [key, , id] of PROCESSING) $(id).checked = settings.input.processing[mode][key];
}

async function refreshDevices() {
  let list = [];
  try {
    list = await listAudioInputs();
  } catch {
    // 一覧が取れなくても「おまかせ」で使える
  }
  const wanted = settings.input.deviceId[settings.input.mode];
  const select = $('device');
  select.textContent = '';
  select.append(new Option('おまかせ（タブレットの既定の入力）', ''));

  let count = 0;
  let unnamed = 0;
  for (const d of list) {
    // 'default' などは「おまかせ」と同じ意味なので一覧から省く。
    if (!d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') continue;
    count++;
    if (!d.label) unnamed++;
    select.append(new Option(d.label || `入力 ${count}`, d.deviceId));
  }

  const found = !!wanted && [...select.options].some((o) => o.value === wanted);
  select.value = found ? wanted : '';

  if (count === 0 || unnamed > 0) {
    $('deviceNote').textContent = '「入力を開始」を押してマイクを許可すると、入力機器の名前が表示されます。';
  } else if (wanted && !found) {
    $('deviceNote').textContent = '前に選んだ入力機器が見つかりません。つなぎ直してから「一覧を更新」を押してください。';
  } else {
    $('deviceNote').textContent = '';
  }
}

// 実際に使われている入力を表示する。選んだものと違えば注意を出す。
function showActual(info, requestedId) {
  const wanted = settings.input.processing[settings.input.mode];
  const onOff = (v) => (v === true ? 'オン' : v === false ? 'オフ' : '不明');
  const processing = PROCESSING.map(([key, label]) => {
    const differs = typeof info[key] === 'boolean' && info[key] !== wanted[key];
    return `${label}：${onOff(info[key])}${differs ? '（指定と違います）' : ''}`;
  }).join(' ／ ');

  const format = [];
  if (info.sampleRate) format.push(`${info.sampleRate}Hz`);
  if (info.channelCount) format.push(info.channelCount === 1 ? 'モノラル' : `${info.channelCount}チャンネル`);
  format.push(`→ ${TARGET_RATE}Hz・モノラルに変換`);

  const box = $('actual');
  box.textContent = '';
  box.append(
    el(
      'dl',
      {},
      el('dt', { text: '実際の入力' }),
      el('dd', {}, el('b', { text: info.label || '（名前なし）' })),
      el('dt', { text: '音の形式' }),
      el('dd', { text: format.join(' ') }),
      el('dt', { text: '音の加工' }),
      el('dd', { text: processing }),
    ),
  );
  if (requestedId && info.deviceId && info.deviceId !== requestedId) {
    box.append(
      el('p', {
        class: 'warn',
        text: '選んだ入力機器と、実際に使われている入力が違います。「4 有線（USB）入力の確認」の手順で確かめてください。',
      }),
    );
  }
  box.hidden = false;
}

function inputChanged() {
  saveSettings(settings);
  renderInput();
  measured.a = null;
  if (sourceKind === 'mic') startMic();
  else render();
}

for (const radio of [$('modeMic'), $('modeLine')]) {
  radio.addEventListener('change', async () => {
    if (!radio.checked) return;
    settings.input.mode = radio.value;
    saveSettings(settings);
    await refreshDevices(); // 入力方法ごとに、前回選んだ機器を覚えている
    inputChanged();
  });
}

$('device').addEventListener('change', () => {
  settings.input.deviceId[settings.input.mode] = $('device').value;
  inputChanged();
});

for (const [key, , id] of PROCESSING) {
  $(id).addEventListener('change', () => {
    settings.input.processing[settings.input.mode][key] = $(id).checked;
    inputChanged();
  });
}

$('btnRefresh').addEventListener('click', refreshDevices);

$('btnToggle').addEventListener('click', () => {
  if (starting) return;
  if (source) stopSource();
  else startMic();
});

// ---- 録音の共通部分 ----

function startRecorder({ maxSeconds, onProgress, onDone }) {
  const chunks = [];
  let samples = 0;
  const limit = maxSeconds * TARGET_RATE;
  const rec = {
    add(pcm) {
      chunks.push(pcm);
      samples += pcm.length;
      onProgress(Math.min(samples, limit) / TARGET_RATE);
      if (samples >= limit) rec.finish();
    },
    finish() {
      if (recorder !== rec) return;
      recorder = null;
      const total = Math.min(samples, limit);
      onDone(concatPcm(chunks, samples).subarray(0, total));
    },
  };
  recorder = rec;
}

// ---- 2. 10秒録音して再生 ----

$('btnShort').addEventListener('click', async () => {
  if (recorder || measure || starting) return;
  if (!(await ensureMic())) return;

  recKind = 'short';
  $('shortAudio').hidden = true;
  $('shortBar').value = 0;
  $('shortBar').hidden = false;
  $('shortMsg').textContent = `録音中… あと${SHORT_SECONDS}秒`;
  startRecorder({
    maxSeconds: SHORT_SECONDS,
    onProgress: (sec) => {
      $('shortBar').value = sec;
      $('shortMsg').textContent = `録音中… あと${Math.max(0, Math.ceil(SHORT_SECONDS - sec))}秒`;
    },
    onDone: (pcm) => {
      recKind = null;
      $('shortBar').hidden = true;
      if (pcm.length < TARGET_RATE) {
        $('shortMsg').textContent = '録音が短すぎました。もう一度お試しください。';
      } else {
        if (shortUrl) URL.revokeObjectURL(shortUrl);
        shortUrl = URL.createObjectURL(pcmToWavBlob(pcm, TARGET_RATE));
        $('shortAudio').src = shortUrl;
        $('shortAudio').hidden = false;
        const peakDb = Math.round(toDb(levelOf(pcm).peak));
        $('shortMsg').textContent = `録音できました（最大 ${peakDb} dB）。下の再生ボタンで聞いてください。`;
      }
      render();
    },
  });
  render();
});

// ---- 3. 比較用の録音 ----

$('btnLong').addEventListener('click', async () => {
  if (recKind === 'long') {
    recorder?.finish();
    return;
  }
  if (recorder || measure || starting) return;
  if (!(await ensureMic())) return;

  const mode = settings.input.mode;
  const info = { ...source.info };
  recKind = 'long';
  $('longMsg').textContent = '録音中…';
  $('longBar').value = 0;
  $('longBar').hidden = false;
  $('longTime').textContent = `0:00 / ${formatClock(LONG_MAX_SECONDS)}`;
  $('longTime').hidden = false;
  startRecorder({
    maxSeconds: LONG_MAX_SECONDS,
    onProgress: (sec) => {
      $('longBar').value = sec;
      $('longTime').textContent = `${formatClock(sec)} / ${formatClock(LONG_MAX_SECONDS)}`;
    },
    onDone: (pcm) => {
      recKind = null;
      $('longBar').hidden = true;
      $('longTime').hidden = true;
      render();
      saveLong(pcm, info, mode);
    },
  });
  render();
});

async function saveLong(pcm, info, mode) {
  const seconds = pcm.length / TARGET_RATE;
  if (seconds < LONG_MIN_SECONDS) {
    $('longMsg').textContent = `${LONG_MIN_SECONDS}秒より短いため、保存しませんでした。`;
    return;
  }
  const requested = settings.input.processing[mode];
  const processing = {};
  for (const [key] of PROCESSING) processing[key] = typeof info[key] === 'boolean' ? info[key] : requested[key];

  const genre = $('genre').value;
  const memo = $('memo').value.trim();
  const meta = {
    id: newId(),
    name: [genre, MODE_LABEL[mode], memo].filter(Boolean).join('・'),
    genre,
    memo,
    mode,
    createdAt: Date.now(),
    durationSec: seconds,
    sampleRate: TARGET_RATE,
    bytes: pcm.byteLength,
    inputLabel: info.label || '',
    processing,
  };
  try {
    await store.saveRecording(meta, pcm);
    $('longMsg').textContent = `保存しました（${formatDuration(seconds)}）。`;
  } catch (e) {
    $('longMsg').textContent = `保存できませんでした。タブレットの空き容量を確認してください。（${e?.message || e}）`;
  }
  await renderList();
}

async function listen(meta, audio) {
  try {
    if (!audio.src) {
      const pcm = await store.loadPcm(meta.id);
      const url = URL.createObjectURL(pcmToWavBlob(pcm, meta.sampleRate || TARGET_RATE));
      listUrls.push(url);
      audio.src = url;
    }
    audio.hidden = false;
    await audio.play();
  } catch (e) {
    // 自動再生が止められた場合は、表示された再生ボタンを押してもらう
    if (e?.name !== 'NotAllowedError') showAlert(`録音を再生できませんでした（${e?.message || e}）`);
  }
}

function recordingItem(meta) {
  const audio = el('audio', { controls: true, hidden: true, preload: 'none' });

  const date = new Date(meta.createdAt).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const size = `${(meta.bytes / 1048576).toFixed(1)}MB`;
  const on = PROCESSING.filter(([key]) => meta.processing?.[key]).map(([, label]) => label);
  const detail = `入力：${meta.inputLabel || '不明'} ／ 音の加工：${on.length ? on.join('、') : 'なし'}`;

  const remove = el('button', { class: 'btn btn-small btn-quiet', type: 'button', text: '削除' });
  let disarm = null;
  remove.addEventListener('click', async () => {
    if (remove.dataset.armed !== '1') {
      // 1回目は確認だけ。4秒以内にもう一度押すと削除する。
      remove.dataset.armed = '1';
      remove.textContent = '本当に削除する';
      remove.classList.add('btn-danger');
      disarm = setTimeout(() => {
        remove.dataset.armed = '';
        remove.textContent = '削除';
        remove.classList.remove('btn-danger');
      }, 4000);
      return;
    }
    clearTimeout(disarm);
    if (replayId === meta.id) stopSource();
    try {
      await store.deleteRecording(meta.id);
    } catch (e) {
      showAlert(`削除できませんでした（${e?.message || e}）`);
    }
    await renderList();
  });

  return el(
    'li',
    { class: 'rec' },
    el('div', { class: 'rec-name', text: meta.name }),
    el('div', { class: 'rec-meta', text: `${date} ・ ${formatDuration(meta.durationSec)} ・ ${size}` }),
    el('div', { class: 'rec-meta', text: detail }),
    el(
      'div',
      { class: 'rec-actions' },
      el('button', { class: 'btn btn-small', type: 'button', text: '聞く', onclick: () => listen(meta, audio) }),
      el('button', {
        class: 'btn btn-small',
        type: 'button',
        'data-replay': meta.id,
        text: '入力として流す',
        onclick: () => (replayId === meta.id ? stopSource() : startReplay(meta)),
      }),
      remove,
    ),
    audio,
  );
}

async function renderList() {
  let list = [];
  try {
    list = await store.listRecordings();
  } catch (e) {
    showAlert(`保存した録音を読み出せませんでした（${e?.message || e}）`);
  }
  for (const url of listUrls) URL.revokeObjectURL(url);
  listUrls = [];

  const ul = $('recList');
  ul.textContent = '';
  for (const meta of list) ul.append(recordingItem(meta));
  $('recEmpty').hidden = list.length > 0;

  const bytes = list.reduce((sum, m) => sum + (m.bytes || 0), 0);
  $('recTotal').textContent = list.length ? `${list.length}件・${(bytes / 1048576).toFixed(1)}MB` : '';
  render();
}

$('chkAudible').addEventListener('change', () => {
  settings.replayAudible = $('chkAudible').checked;
  saveSettings(settings);
});

// ---- 4. 有線（USB）入力の確認 ----

// 一定時間の平均的な音の大きさ（dB）を測る。途中で入力が止まったら null を返す。
function measureLevel(seconds, onTick) {
  return new Promise((resolve) => {
    const need = Math.round(seconds * CHUNKS_PER_SECOND);
    let sumSq = 0;
    let n = 0;
    const m = {
      add(level) {
        sumSq += level.rms * level.rms;
        n++;
        onTick(Math.max(0, Math.ceil((need - n) / CHUNKS_PER_SECOND)));
        if (n >= need) {
          measure = null;
          resolve(toDb(Math.sqrt(sumSq / n), -90));
        }
      },
      cancel() {
        if (measure === m) measure = null;
        resolve(null);
      },
    };
    measure = m;
  });
}

function showVerdict(kind, text) {
  const v = $('verdict');
  v.dataset.kind = kind;
  v.textContent = text;
  v.hidden = !text;
}

$('btnMeasureA').addEventListener('click', async () => {
  if (recorder || measure || starting) return;
  if (!(await ensureMic())) return;

  measured.a = null;
  showVerdict('', '');
  $('measureB').textContent = '';
  const pending = measureLevel(MEASURE_SECONDS, (left) => {
    $('measureA').textContent = `測っています… あと${left}秒`;
  });
  render();
  const db = await pending;
  if (db == null) {
    $('measureA').textContent = '中断しました。';
  } else if (db < -45) {
    $('measureA').textContent = `平均 ${Math.round(db)} dB`;
    showVerdict('warn', 'つないだ状態でも音がほとんど入っていません。テレビの音量とケーブルの差し込みを確認して、①をやり直してください。');
  } else {
    measured.a = db;
    $('measureA').textContent = `平均 ${Math.round(db)} dB。次はケーブルを抜いて②を押してください。`;
  }
  render();
});

$('btnMeasureB').addEventListener('click', async () => {
  if (recorder || measure || starting || measured.a == null) return;
  if (!(await ensureMic())) return;

  const pending = measureLevel(MEASURE_SECONDS, (left) => {
    $('measureB').textContent = `測っています… あと${left}秒`;
  });
  render();
  const db = await pending;
  if (db == null) {
    $('measureB').textContent = '中断しました。';
  } else {
    $('measureB').textContent = `平均 ${Math.round(db)} dB`;
    const change = `${Math.round(measured.a)} dB → ${Math.round(db)} dB`;
    if (measured.a - db >= 15) {
      showVerdict('ok', `合格：ケーブルを抜くと音が止まりました（${change}）。USBの入力が使われています。`);
    } else {
      showVerdict(
        'bad',
        `ケーブルを抜いても音が入り続けています（${change}）。内蔵マイクに戻っている可能性が高いです。下の「ケーブルを抜いても音が入り続けるとき」を試してください。`,
      );
    }
  }
  render();
});

// ---- 最初に行うこと ----

navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);

document.addEventListener('visibilitychange', () => {
  // 画面に戻ってきたとき、入力中なら消灯防止を取り直す。
  if (document.visibilityState === 'visible' && source) holdWakeLock();
});

if (!window.isSecureContext) {
  showAlert('このページは https:// で始まるアドレスで開いてください。http:// ではマイクが使えません。');
}

$('chkAudible').checked = settings.replayAudible;
renderInput();
render();
refreshDevices();
renderList();
