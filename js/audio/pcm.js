// PCM（音を数値の列にしたもの）を扱う小さな道具。

/** 細切れのPCMを1本につなぐ。 */
export function concatPcm(chunks, totalSamples) {
  const out = new Int16Array(totalSamples);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** PCMの音の大きさを調べる。peak=最大値、rms=平均的な大きさ（どちらも0〜1）、clipped=音割れの回数。 */
export function levelOf(pcm) {
  let peak = 0;
  let sumSq = 0;
  let clipped = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 32768;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    if (a >= 0.985) clipped++;
    sumSq += v * v;
  }
  return { peak, rms: Math.sqrt(sumSq / Math.max(1, pcm.length)), clipped };
}

/** PCMをWAV形式（ブラウザがそのまま再生できる音声ファイルの形）に包む。 */
export function pcmToWavBlob(pcm, sampleRate) {
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset, str) => {
    for (let i = 0; i < str.length; i++) header.setUint8(offset + i, str.charCodeAt(i));
  };
  const dataBytes = pcm.length * 2;
  text(0, 'RIFF');
  header.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  header.setUint32(16, 16, true); // fmt部分の長さ
  header.setUint16(20, 1, true); // 1 = 無圧縮PCM
  header.setUint16(22, 1, true); // モノラル
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true); // 1秒あたりのバイト数
  header.setUint16(32, 2, true); // 1サンプルのバイト数
  header.setUint16(34, 16, true); // 16bit
  text(36, 'data');
  header.setUint32(40, dataBytes, true);
  return new Blob([header, pcm], { type: 'audio/wav' });
}
