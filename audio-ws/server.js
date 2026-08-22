// audio-ws/server.js — local relay from Meet preload to Electron main process
const WebSocket = require('ws');

const PORT = 9999;
let wss = null;
let audioCb = () => {};
let clients = new Set();

function startAudioWSServer() {
  if (wss) return true;

  wss = new WebSocket.Server({ port: PORT });
  clients = new Set();

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('[AudioRelay] Meet audio client connected');

    ws.on('message', (data) => {
      if (!data || data.length === 0) return;
      try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        audioCb(buf);
      } catch (err) {
        console.error('[AudioRelay] Audio chunk error:', err.message);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log('[AudioRelay] Meet audio client disconnected');
    });

    ws.on('error', (err) => {
      clients.delete(ws);
      console.error('[AudioRelay] Client error:', err.message);
    });
  });

  wss.on('listening', () => {
    console.log(`[AudioRelay] Listening on ws://localhost:${PORT}`);
  });

  wss.on('error', (err) => {
    console.error('[AudioRelay] Server error:', err.message);
  });

  return true;
}

function onAudioChunk(cb) {
  audioCb = typeof cb === 'function' ? cb : () => {};
}

function stopAudioWSServer() {
  audioCb = () => {};

  for (const ws of clients) {
    try { ws.close(1000, 'app stopped'); } catch (_) {}
  }
  clients.clear();

  if (wss) {
    try { wss.close(); } catch (_) {}
    wss = null;
  }
}

module.exports = { startAudioWSServer, onAudioChunk, stopAudioWSServer };
