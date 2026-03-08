// GitHub公開ページ側の設定値。
// 本番デプロイ時は GAS_WEB_APP_URL を必ず実URLへ差し替えてください。
// パスワードはここに書かず、GAS Script Properties に ACCESS_PASSWORD を設定します。
export const APP_CONFIG = Object.freeze({
  GAS_WEB_APP_URL: "https://script.google.com/macros/s/REPLACE_WITH_DEPLOYMENT_ID/exec",

  // 1回のAPI待ち時間(ミリ秒)
  REQUEST_TIMEOUT_MS: 10000,

  // QRデコードの間隔(ミリ秒)
  SCAN_INTERVAL_MS: 300,

  // 同一コードを再送信するまでの待機時間(ミリ秒)
  RESCAN_COOLDOWN_MS: 2000,

  // trueでブラウザコンソールにも詳細ログを出力
  DEBUG: true,
});
