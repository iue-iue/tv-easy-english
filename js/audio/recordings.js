// 比較用の録音を、タブレットのブラウザの中（IndexedDB という保存場所）にしまう部品。
// 録音はこの端末の外へは送られない。
// 一覧用の情報（名前・長さなど）と音そのものを別々にしまい、一覧を出すときに重い音データを読まないようにしている。

const DB_NAME = 'tv-easy-english';
const DB_VERSION = 1;
const META = 'recordingMeta';
const PCM = 'recordingPcm';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PCM)) db.createObjectStore(PCM);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function finished(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('保存が中断されました'));
  });
}

function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 録音を保存する。meta は { id, name, createdAt, durationSec, ... }、pcm は Int16Array。 */
export async function saveRecording(meta, pcm) {
  const db = await openDb();
  try {
    const tx = db.transaction([META, PCM], 'readwrite');
    tx.objectStore(META).put(meta);
    tx.objectStore(PCM).put(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength), meta.id);
    await finished(tx);
  } finally {
    db.close();
  }
  try {
    // 空き容量が減ったときにブラウザが勝手に消さないよう頼む（断られても動作に影響はない）。
    await navigator.storage?.persist?.();
  } catch {
    // 対応していないブラウザでは何もしない
  }
}

/** 保存した録音の一覧（新しい順）。音データは含まない。 */
export async function listRecordings() {
  const db = await openDb();
  try {
    const list = await result(db.transaction(META, 'readonly').objectStore(META).getAll());
    return list.sort((a, b) => b.createdAt - a.createdAt);
  } finally {
    db.close();
  }
}

/** 録音の音データを読み出す。 */
export async function loadPcm(id) {
  const db = await openDb();
  try {
    const buffer = await result(db.transaction(PCM, 'readonly').objectStore(PCM).get(id));
    if (!buffer) throw new Error('録音が見つかりません');
    return new Int16Array(buffer);
  } finally {
    db.close();
  }
}

/** 録音を削除する（元に戻せない）。 */
export async function deleteRecording(id) {
  const db = await openDb();
  try {
    const tx = db.transaction([META, PCM], 'readwrite');
    tx.objectStore(META).delete(id);
    tx.objectStore(PCM).delete(id);
    await finished(tx);
  } finally {
    db.close();
  }
}
