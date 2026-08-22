// transcriber/remoteDeepgram.js — sends PCM audio to your backend; backend owns Deepgram key
// v126: auto-reconnects backend /stt WebSocket when network/Railway/client socket drops unexpectedly.
const WebSocket = require('ws');

let socket = null;
let transcriptCb = () => {};
let opened = false;
let bufferedChunks = [];
let heartbeatTimer = null;
let reconnectTimer = null;
let currentUrl = '';
let manuallyStopped = false;
let reconnectAttempt = 0;
let permanentClose = false;

const MAX_BUFFERED_CHUNKS = 40;
const BACKEND_HEARTBEAT_MS = 15000;
const BASE_RECONNECT_MS = 3000;
const MAX_RECONNECT_MS = 15000;

function emit(payload) {
  if (typeof transcriptCb === 'function') {
    try { transcriptCb(payload); } catch (e) { console.error('[RemoteSTT] callback error:', e); }
  }
}

function normalizeBackendUrl(rawUrl) {
  let url = String(rawUrl || '').trim();
  if (!url) throw new Error('Backend URL is empty');
  url = url.replace(/\/+$/, '');
  if (url.startsWith('http://')) url = url.replace('http://', 'ws://');
  if (url.startsWith('https://')) url = url.replace('https://', 'wss://');
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) url = `wss://${url}`;
  if (!url.endsWith('/stt')) url += '/stt';
  return url;
}

function clearHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function isSocketActive() {
  return socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING);
}

function shouldReconnect(code) {
  if (manuallyStopped || permanentClose) return false;
  if (code === 1000 || code === 1008) return false;
  return Boolean(currentUrl);
}

function scheduleReconnect(code, reasonText) {
  if (!shouldReconnect(code)) return;
  if (reconnectTimer || isSocketActive()) return;

  reconnectAttempt += 1;
  const delay = Math.min(BASE_RECONNECT_MS * reconnectAttempt, MAX_RECONNECT_MS);

  console.log(`[RemoteSTT] Backend STT disconnected. Reconnecting in ${delay}ms...`, code || '', reasonText || '');
  emit({ type: 'status', text: 'Caption connection dropped. Reconnecting automatically...' });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!manuallyStopped && !permanentClose && currentUrl) {
      connectSocket(currentUrl, true);
    }
  }, delay);
}

function connectSocket(url, isReconnect = false) {
  if (isSocketActive()) return;

  opened = false;
  socket = new WebSocket(url);

  socket.on('open', () => {
    opened = true;
    reconnectAttempt = 0;
    console.log(isReconnect ? '[RemoteSTT] Reconnected to backend STT' : '[RemoteSTT] Connected to backend STT');

    emit({
      type: 'status',
      text: isReconnect
        ? 'Reconnected to backend. Captions resumed.'
        : 'Connected to backend. Low-latency STT ready. Waiting for Windows system audio...',
    });

    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        try { socket.ping(); } catch (_) {}
      }
    }, BACKEND_HEARTBEAT_MS);

    for (const chunk of bufferedChunks.splice(0)) {
      try {
        if (socket && socket.readyState === WebSocket.OPEN) socket.send(chunk);
      } catch (_) {}
    }
  });

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    if (msg.type === 'error') {
      const text = msg.message || 'Backend transcription error';
      if (/license|DEEPGRAM_API_KEY|invalid/i.test(text)) permanentClose = true;
      return emit({ error: text });
    }

    if (msg.type === 'limit_reached') {
      permanentClose = true;
      return emit({
        type: 'limit_reached',
        text: msg.message || 'Transcript limit reached. Captions are disconnecting now.',
      });
    }

    if (msg.type === 'status') return emit({ type: 'status', text: msg.text });
    if (msg.type === 'speech_started') return emit({ type: 'speech_started' });

    if (msg.type === 'transcript' && msg.text) {
      return emit({
        text: msg.text,
        isFinal: !!msg.isFinal,
        confidence: msg.confidence || 0,
        speechFinal: !!msg.speechFinal,
      });
    }
  });

  socket.on('close', (code, reason) => {
    opened = false;
    clearHeartbeat();

    const msg = reason?.toString?.() || '';
    console.log('[RemoteSTT] Backend STT closed:', code, msg);
    socket = null;

    if (shouldReconnect(code)) {
      scheduleReconnect(code, msg);
    } else if (code !== 1000 && !manuallyStopped) {
      emit({ error: msg || 'Backend transcription connection closed. Check license/backend.' });
    }
  });

  socket.on('error', (err) => {
    opened = false;
    clearHeartbeat();
    console.error('[RemoteSTT] Backend STT error:', err.message);
  });
}

function startRemoteTranscriptStream({ backendUrl, licenseEmail }, onTranscript) {
  stopRemoteTranscriptStream();

  transcriptCb = typeof onTranscript === 'function' ? onTranscript : () => {};

  const email = String(licenseEmail || '').trim().toLowerCase();

  if (!email) throw new Error('License email is required');

  const base = normalizeBackendUrl(backendUrl);
  currentUrl = `${base}?email=${encodeURIComponent(email)}`;

  manuallyStopped = false;
  permanentClose = false;
  reconnectAttempt = 0;
  opened = false;
  bufferedChunks = [];

  connectSocket(currentUrl, false);
  return true;
}

function sendAudioChunk(pcmBuffer) {
  if (!pcmBuffer || !pcmBuffer.length) return;

  if (socket && socket.readyState === WebSocket.OPEN) {
    try { socket.send(pcmBuffer); } catch (_) {}
    return;
  }

  if (!manuallyStopped && !permanentClose) {
    bufferedChunks.push(Buffer.from(pcmBuffer));
    if (bufferedChunks.length > MAX_BUFFERED_CHUNKS) bufferedChunks.shift();

    if (!isSocketActive() && currentUrl && !reconnectTimer) {
      scheduleReconnect(1006, 'audio arrived while STT socket was closed');
    }
  }
}

function stopRemoteTranscriptStream() {
  manuallyStopped = true;
  permanentClose = false;
  bufferedChunks = [];
  opened = false;
  currentUrl = '';
  reconnectAttempt = 0;

  clearReconnect();
  clearHeartbeat();

  if (socket) {
    try { socket.close(1000, 'client stopped'); } catch (_) {}
    socket = null;
  }

  transcriptCb = () => {};
}

module.exports = {
  startRemoteTranscriptStream,
  sendAudioChunk,
  stopRemoteTranscriptStream,
};