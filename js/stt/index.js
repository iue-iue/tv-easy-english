// 音声認識エンジンの一覧。エンジンを足すときは、部品のファイルを作ってここに1行足す。
// 部品の共通の形は soniox.js の先頭に書いてある。

import { SonioxStt } from './soniox.js';

export const STT_ENGINES = {
  soniox: {
    label: 'Soniox',
    keyName: 'soniox', // 設定のどのキーを使うか
    hasTranslation: true, // 速報訳（内蔵の翻訳）があるか
    create: (options) => new SonioxStt(options),
  },
};
