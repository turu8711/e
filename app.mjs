import { APP_CONFIG } from './config.mjs';
import { clearAuth, sendScan, verifyAccess } from './api.mjs';

/**
 * QRスキャンUI本体
 *
 * フロー:
 * 1) パスワード認証
 * 2) 認証成功後にカメラ起動可能化
 * 3) 映像をcanvasへ描画
 * 4) jsQRでコード抽出
 * 5) 送信前バリデーション
 * 6) GAS APIへ送信
 * 7) レスポンスに応じて画面表示・通知音・ログ更新
 */
const config = APP_CONFIG;
const SAME_QR_RESET_MS = 2000;

// DOM参照
const authPanel = document.getElementById('auth-panel');
const authForm = document.getElementById('auth-form');
const accessPasswordInput = document.getElementById('access-password');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const authMsg = document.getElementById('auth-msg');

const video = document.getElementById('video');
const cameraCanvas = document.getElementById('camera-canvas');
const rectCanvas = document.getElementById('rect-canvas');
const statusMsg = document.getElementById('status-msg');
const logList = document.getElementById('log-list');
const scannerPanel = document.getElementById('scanner-panel');
const startBtn = document.getElementById('start-btn');

// キャンバスコンテキスト
const cameraCtx = cameraCanvas.getContext('2d', { willReadFrequently: true });
const rectCtx = rectCanvas.getContext('2d');

// 実行時状態
let contentWidth = 0;
let contentHeight = 0;
let scanTimer = null;
let inFlight = false;
let isAuthorized = false;
let activeQrValue = '';
let activeQrResetTimer = null;
let audioCtx = null;
let jsqrUnavailableNotified = false;

// 初期状態は未認証。カメラ起動ボタンは押せないようにする。
setAuthorizedState(false);

/**
 * アクセス認証フォーム送信。
 */
authForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const password = String(accessPasswordInput.value || '');
  if (!password.trim()) {
    setAuthMessage('パスワードを入力してください。', 'error');
    return;
  }

  authSubmitBtn.disabled = true;//ボタン無効化
  setAuthMessage('認証中です...', 'info');

  try {
    const response = await verifyAccess(password);

    // 入力値はメモリ上に残し続けない。
    accessPasswordInput.value = '';

    // 失敗
    if (!response.success) {
      setAuthorizedState(false);
      setAuthMessage(`[${response.code}] ${response.message}`, 'error');
      appendLog('warn', `認証失敗 [${response.code}] ${response.message}`);
      playErrorTone();
      return;
    }

    // 成功
    setAuthorizedState(true);
    setAuthMessage('認証成功: カメラを起動できます。', 'success');
    setStatus('認証済み: 「カメラを起動」を押してください。', 'info');
    appendLog('success', 'アクセス認証成功');
    playSuccessTone();
  } catch (err) {
    setAuthorizedState(false);
    setAuthMessage(`認証通信失敗: ${err.message}`, 'error');
    appendLog('error', `認証通信失敗: ${err.message}`);
    playErrorTone();
  } finally {
    authSubmitBtn.disabled = false;
  }
});

/**
 * 起動ボタン押下時の初期化。
 * 未認証時はここで遮断する。
 */
startBtn.addEventListener('click', async () => {
  if (!isAuthorized) {
    setStatus('先にアクセス認証を完了してください。', 'error');
    setAuthMessage('未認証です。パスワードを入力してください。', 'error');
    return;
  }

  startBtn.disabled = true;
  setStatus('カメラを起動しています...', 'info');

  // カメラ認証後の処理
  try {
    await startCamera();
    scannerPanel.classList.remove('is-disabled');
    setStatus('QRコードをカメラにかざしてください。', 'info');
    appendLog('info', 'カメラ起動成功');

    // 画面描画ループとスキャンループは分離して動かす。
    requestAnimationFrame(updateCanvasFrame);
    if (!scanTimer) {
      scanTimer = setInterval(scanCurrentFrame, config.SCAN_INTERVAL_MS || 200);
    }
  } catch (err) {
    startBtn.disabled = false;
    setStatus(`カメラ起動失敗: ${err.message}`, 'error');
    appendLog('error', `カメラ起動失敗: ${err.message}`);
  }
});

/**
 * カメラ起動。
 * - 1回目: 背面カメラ優先 (スマホ想定)
 * - 失敗時: ブラウザ既定デバイスで再試行
 */
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('このブラウザはカメラAPIに未対応です。');
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: 1280, height: 720 },
      audio: false,
    });
    bindVideoStream(stream);
    return;
  } catch (primaryErr) {
    const fallbackStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });
    bindVideoStream(fallbackStream);
    if (config.DEBUG) {
      console.debug('[App] fallback camera selected', primaryErr);
    }
  }
}

/**
 * video要素へストリームを束縛し、
 * メタ情報取得後にキャンバスサイズを同期する。
 */
function bindVideoStream(stream) {
  video.srcObject = stream;
  video.onloadedmetadata = () => {
    video.play();
    contentWidth = video.videoWidth;
    contentHeight = video.videoHeight;

    cameraCanvas.width = contentWidth;
    cameraCanvas.height = contentHeight;
    rectCanvas.width = contentWidth;
    rectCanvas.height = contentHeight;
  };
}

/**
 * 映像フレームを camera-canvas に描画し続ける。
 */
function updateCanvasFrame() {
  if (video.videoWidth && video.videoHeight) {
    contentWidth = video.videoWidth;
    contentHeight = video.videoHeight;
    cameraCtx.drawImage(video, 0, 0, contentWidth, contentHeight);
  }
  requestAnimationFrame(updateCanvasFrame);
}

/**
 * 定期スキャン処理。
 */
async function scanCurrentFrame() {
  // 未認証、通信中、カメラ未初期化時は処理しない。
  if (!isAuthorized || inFlight || !contentWidth || !contentHeight) {
    return;
  }

  const decoder = window.jsQR;
  if (typeof decoder !== 'function') {
    if (!jsqrUnavailableNotified) {
      setStatus('jsQRの読み込みに失敗しました。', 'error');
      appendLog('error', 'jsQRライブラリが未読み込みです');
      jsqrUnavailableNotified = true;
    }
    return;
  }

  // カメラ画像認識 & QRコード解析
  const imageData = cameraCtx.getImageData(0, 0, contentWidth, contentHeight);
  const code = decoder(imageData.data, contentWidth, contentHeight);

  // QRコードの内容がない場合枠線を非表示にする
  if (!code || !code.data) {
    rectCtx.clearRect(0, 0, contentWidth, contentHeight);
    return;
  }

  // 枠線は常に描画して「認識中」を見える化する。
  drawRect(code.location);

  // 同じ内容ならタイマーだけ更新し、それ以外の処理はスキップする。
  const isNewQr = touchDetectedQr(code.data);
  if (!isNewQr) {
    return;
  }

  // 新しい内容のときだけ、送信前チェックへ進む。
  const extracted = extractTicketData(code.data);
  if (!extracted.ok) {
    setStatus(extracted.message, 'error');
    appendLog('warn', extracted.message);
    playErrorTone();
    return;
  }

  inFlight = true;

  setStatus('照合中...', 'info');

  try {
    const response = await sendScan(extracted.qrUrl);
    handleApiResponse(response, extracted);
  } catch (err) {
    setStatus(`通信失敗: ${err.message}`, 'error');
    appendLog('error', `通信失敗: ${err.message}`);
    playErrorTone();
  } finally {
    inFlight = false;
  }
}

/**
 * QR文字列から必要情報を抽出して検証する。
 */
function extractTicketData(rawQrText) {
  if (typeof rawQrText !== 'string') {
    return { ok: false, message: 'QRデータ型が不正です。' };
  }

  const trimmed = rawQrText.trim();
  if (!trimmed || trimmed.length > 2048) {
    return { ok: false, message: 'QRデータ長が不正です。' };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
  } catch (_err) {
    return { ok: false, message: 'QRがURL形式ではありません。' };
  }

  const eParam = parsedUrl.searchParams.get('e');
  if (!eParam) {
    return { ok: false, message: 'QRパラメータeが不足しています。' };
  }

  const parts = eParam.split('~');
  if (parts.length !== 2) {
    return { ok: false, message: 'QRパラメータ構造が不正です。' };
  }

  const encodedEventId = parts[0];
  const token = parts[1];

  if (!/^[0-9a-z]+$/i.test(encodedEventId)) {
    return { ok: false, message: 'イベントID形式が不正です。' };
  }

  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    return { ok: false, message: 'トークン形式が不正です。' };
  }

  const signature = `${encodedEventId}~${token}`;

  return {
    ok: true,
    qrUrl: parsedUrl.toString(),
    signature,
    token,
    encodedEventId,
  };
}

/**
 * GAS応答を受け取り、UI/音/ログへ反映する。
 */
function handleApiResponse(response, extracted) {
  const prefix = `[${response.code}]`;
  const req = response.requestId ? ` requestId=${response.requestId}` : '';// リクエストIDがある場合

  if (response.success) {
    setStatus(`${prefix} ${response.message}`, 'success');
    appendLog('success', `${prefix} ${response.message}${req}`);
    playSuccessTone();
    return;
  }

  // セッション期限切れ/無効なら認証状態へ戻す。
  if (response.code === 401) {
    clearAuth();
    setAuthorizedState(false);
    setAuthMessage('認証期限切れです。再度パスワードを入力してください。', 'error');
  }

  setStatus(`${prefix} ${response.message}`, 'error');
  appendLog('warn', `${prefix} ${response.message} token=${maskToken(extracted.token)}${req}`);
  playErrorTone();
}

function setAuthorizedState(authorized) {
  isAuthorized = Boolean(authorized);
  startBtn.disabled = !isAuthorized;

  if (isAuthorized) {
    authPanel.classList.add('is-unlocked');
  } else {
    authPanel.classList.remove('is-unlocked');
    scannerPanel.classList.add('is-disabled');
    clearDetectedQrHold();
  }
}

/**
 * 読み取ったQRを保持し、2秒タイマーをリセットする。
 * - 新しい内容: true を返す（以降の判定処理を継続）
 * - 同じ内容: false を返す（通知・送信はスキップ）
 */
function touchDetectedQr(rawQrText) {
  const nextValue = String(rawQrText || '');
  const isNew = nextValue !== activeQrValue;// 前の値と今の値が違うか確認。返り値はbool値。
  activeQrValue = nextValue;

  // 古いタイマーがあれば停止
  if (activeQrResetTimer) {
    clearTimeout(activeQrResetTimer);
  }

  // 新たなタイマー開始
  activeQrResetTimer = setTimeout(() => {
    activeQrValue = '';
    activeQrResetTimer = null;
  }, SAME_QR_RESET_MS);

  return isNew;
}

function clearDetectedQrHold() {
  activeQrValue = '';
  if (activeQrResetTimer) {
    clearTimeout(activeQrResetTimer);
    activeQrResetTimer = null;
  }
}

function setAuthMessage(text, level) {
  authMsg.textContent = text;
  authMsg.dataset.level = level;
}

function drawRect(location) {
  if (!location) {
    return;
  }

  rectCtx.clearRect(0, 0, contentWidth, contentHeight);
  drawLine(location.topLeftCorner, location.topRightCorner);
  drawLine(location.topRightCorner, location.bottomRightCorner);
  drawLine(location.bottomRightCorner, location.bottomLeftCorner);
  drawLine(location.bottomLeftCorner, location.topLeftCorner);
}

function drawLine(begin, end) {
  rectCtx.lineWidth = 4;
  rectCtx.strokeStyle = '#ff3737';
  rectCtx.beginPath();
  rectCtx.moveTo(begin.x, begin.y);
  rectCtx.lineTo(end.x, end.y);
  rectCtx.stroke();
}

function setStatus(text, level) {
  statusMsg.textContent = text;
  statusMsg.dataset.level = level;
}

function appendLog(level, text) {
  const item = document.createElement('li');
  const timestamp = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  item.className = `log-item log-${level}`;
  item.textContent = `${timestamp} ${text}`;

  logList.prepend(item);

  while (logList.children.length > 50) {
    logList.removeChild(logList.lastChild);
  }

  if (config.DEBUG) {
    console.log('[QR]', level, text);
  }
}

function playSuccessTone() {
  const ctx = ensureAudioContext();
  beep(ctx, 1320, 0.08, 0);
  beep(ctx, 1760, 0.08, 0.1);
}

function playErrorTone() {
  const ctx = ensureAudioContext();
  beep(ctx, 340, 0.12, 0);
  beep(ctx, 280, 0.16, 0.16);
}

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function beep(ctx, freq, durationSec, delaySec) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.value = freq;

  gain.gain.setValueAtTime(0.0001, ctx.currentTime + delaySec);
  gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + delaySec + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delaySec + durationSec);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(ctx.currentTime + delaySec);
  osc.stop(ctx.currentTime + delaySec + durationSec + 0.01);
}

function maskToken(token) {
  if (!token || token.length < 8) {
    return '****';
  }
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
