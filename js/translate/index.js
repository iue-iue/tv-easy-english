// 翻訳エンジンの一覧。エンジンを足すときは、部品のファイルを作ってここに1行足す。
//
// どのエンジンも同じ形にする:
//   translate({ system, user, onText, signal }) → { text, refused, usage, model }
//   complete({ system, user }) → 文章
// エラーは Error で投げ、fatal（設定を直すまで直らない）と aborted（中断）の印を付ける。

import { ClaudeTranslator, CLAUDE_MODELS, QUALITY_MODES } from './claude.js';

export const TRANSLATORS = {
  claude: {
    label: 'Claude',
    keyName: 'anthropic', // 設定のどのキーを使うか
    models: CLAUDE_MODELS,
    create: (options) => new ClaudeTranslator(options),
  },
};

export { QUALITY_MODES };
