import { APP_CONFIG } from './config.mjs';

/**
 * API通信用モジュール
 *
 * 役割:
 * - 認証(auth_check)でセッショントークンを取得
 * - QR照合(scan)時はセッショントークン必須
 * - まずPOST(JSON)を試し、失敗時はJSONPへフォールバック
 */
const config = APP_CONFIG;

// 認証成功後にのみ保持するインメモリセッショントークン。
// localStorage等には保存しない。
let authSessionToken = '';

/**
 * 共通エンベロープを生成する。
 */
function createBaseEnvelope() {
  return {
    requestId: createRequestId(),
    ts: Date.now(),
    nonce: createNonce(),
    client: {
      ua: navigator.userAgent,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
    },
  };
}

/**
 * 認証API用のリクエストを作る。
 */
function createAuthEnvelope(password) {
  return {
    ...createBaseEnvelope(),
    action: 'auth_check',
    password,
  };
}

/**
 * QR照合API用のリクエストを作る。
 */
function createScanEnvelope(qrUrl) {
  return {
    ...createBaseEnvelope(),
    action: 'scan',
    qrUrl,
    sessionToken: authSessionToken,
  };
}

/**
 * POST(JSON) でGASへ送信。
 */
async function postJson(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS || 10000);//10秒でタイムアウト

  try {
    const res = await fetch(config.GAS_WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {//ダメだった場合
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    return normalizeResponse(data);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * JSONPでGASへ送信するフォールバック。
 */
function requestByJsonp(payload) {
  const callbackName = `__qr_cb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const timeoutMs = config.REQUEST_TIMEOUT_MS || 10000;

  return new Promise((resolve, reject) => {
    const cleanup = (scriptEl, timerId) => {
      if (timerId) {
        clearTimeout(timerId);
      }
      if (scriptEl && scriptEl.parentNode) {
        scriptEl.parentNode.removeChild(scriptEl);
      }
      delete window[callbackName];
    };

    const scriptEl = document.createElement('script');
    const timerId = setTimeout(() => {
      cleanup(scriptEl, timerId);
      reject(new Error('JSONP timeout'));
    }, timeoutMs);

    window[callbackName] = (data) => {
      cleanup(scriptEl, timerId);
      resolve(normalizeResponse(data));
    };

    scriptEl.onerror = () => {
      cleanup(scriptEl, timerId);
      reject(new Error('JSONP network error'));
    };

    const payloadText = JSON.stringify(payload);
    const payloadBase64Url = encodeBase64Url(payloadText);
    const src = `${config.GAS_WEB_APP_URL}?callback=${encodeURIComponent(callbackName)}&payload=${encodeURIComponent(payloadBase64Url)}`;

    scriptEl.src = src;
    scriptEl.async = true;
    document.head.appendChild(scriptEl);
  });
}

/**
 * 送信共通関数: POST失敗時のみJSONPへフォールバック。
 */
async function sendEnvelope(payload) {
  try {
    return await postJson(payload);//API送信
  } catch (postErr) {
    debugLog('POST failed, fallback to JSONP', postErr);
    return await requestByJsonp(payload);
  }
}

/**
 * アクセスパスワードを検証する。
 * 成功時は sessionToken を保持して true相当状態にする。
 */
// GASのURLが正しいか　　後者は/REPLACE_WITH_DEPLOYMENT_ID/が含まれていないか（テンプレのままではないか）
export async function verifyAccess(password) {
  if (!config.GAS_WEB_APP_URL || /REPLACE_WITH_DEPLOYMENT_ID/.test(config.GAS_WEB_APP_URL)) {
    throw new Error('GAS_WEB_APP_URL が未設定です');
  }

  const normalizedPassword = String(password || '');//パスワード文字列化
  if (!normalizedPassword || normalizedPassword.length > 128) {
    throw new Error('パスワード形式が不正です');
  }

  const envelope = createAuthEnvelope(normalizedPassword);
  const response = await sendEnvelope(envelope);

  if (
    response.success &&
    response.detail &&
    typeof response.detail.sessionToken === 'string' &&
    response.detail.sessionToken.length >= 32
  ) {
    authSessionToken = response.detail.sessionToken;
  } else {
    authSessionToken = '';
  }

  return response;
}

/**
 * QR照合要求を送る。
 * 未認証状態なら送信前にエラー化する。
 */
export async function sendScan(qrUrl) {
  if (!config.GAS_WEB_APP_URL || /REPLACE_WITH_DEPLOYMENT_ID/.test(config.GAS_WEB_APP_URL)) {
    throw new Error('GAS_WEB_APP_URL が未設定です');
  }

  if (!authSessionToken) {
    throw new Error('アクセス認証が必要です');
  }

  const envelope = createScanEnvelope(qrUrl);
  const response = await sendEnvelope(envelope);

  // サーバー側で401が返ったら、ローカル認証状態は破棄する。
  if (!response.success && response.code === 401) {
    authSessionToken = '';
  }

  return response;
}

/**
 * 手動で認証状態を破棄する。
 */
export function clearAuth() {
  authSessionToken = '';
}

/**
 * 現在認証済みかを返す。
 */
export function hasAuth() {
  return Boolean(authSessionToken);
}

/**
 * GAS応答をUI側で扱いやすい形へ正規化する。
 */
function normalizeResponse(data) {
  return {
    success: Boolean(data && data.success),
    code: Number((data && data.code) || 500),
    message: String((data && data.message) || '不明なレスポンス'),
    requestId: String((data && data.requestId) || ''),
    checkedAt: String((data && data.checkedAt) || ''),
    event: String((data && data.event) || ''),
    detail: data && typeof data.detail === 'object' ? data.detail : null,
  };
}

function createRequestId() {
  return `rq_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function createNonce() {
  if (window.crypto && window.crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function encodeBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function debugLog(message, payload) {
  if (!config.DEBUG) {
    return;
  }
  console.debug('[TicketApi]', message, payload || '');
}
