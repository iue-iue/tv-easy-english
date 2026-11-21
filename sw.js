// サービスワーカー：ブラウザとサーバーの間に入る小さなプログラム。
//
// 役目は1つだけ。このアプリのファイルを読み込むたびに、サーバーに「新しい版が出ていないか」を確認させる。
// これがないと、ブラウザが古いファイルを最長10分使い続ける。アプリを更新した直後に
// 「新しい画面」と「古いプログラム」が混ざり、ボタンを押しても動かなくなることがあった。
//
// ファイルをためこむことはしない。音声認識と翻訳に通信が必要なので、もともと通信なしでは使えない。

self.addEventListener('install', () => self.skipWaiting()); // 待たずに、すぐ新しい版に切り替える
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim())); // 開いているページにもすぐ適用する

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  // このアプリ自身のファイルだけを扱う。Soniox、Claude、字体の配信元などへの通信には手を出さない。
  if (new URL(request.url).origin !== self.location.origin) return;
  // 'no-cache' は「必ずサーバーに確認してから使う」という指定。変わっていなければ、手元の写しをそのまま使うので速い。
  event.respondWith(fetch(request, { cache: 'no-cache' }));
});
