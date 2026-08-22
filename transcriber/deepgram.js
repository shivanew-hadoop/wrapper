// transcriber/deepgram.js — live Deepgram stream for PCM16/16k mono
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

let deepgramLive = null;
let transcriptCb = () => {};
let keepAliveTimer = null;
let opened = false;
let bufferedChunks = [];
const MAX_BUFFERED_CHUNKS = 8;

function emit(payload) {
  if (typeof transcriptCb === 'function') {
    try { transcriptCb(payload); } catch (e) { console.error('[Deepgram] transcript callback error:', e); }
  }
}

function extractTranscript(data) {
  const alt = data?.channel?.alternatives?.[0];
  const text = (alt?.transcript || '').trim();
  return { text, isFinal: !!data?.is_final, confidence: alt?.confidence || 0 };
}

function startDeepgramStream(apiKey, onTranscript) {
  stopDeepgramStream();
  transcriptCb = typeof onTranscript === 'function' ? onTranscript : () => {};

  const key = String(apiKey || '').trim();
  if (!key) {
    emit({ error: 'Deepgram API key is empty' });
    return false;
  }

  const deepgram = createClient(key);
  opened = false;
  bufferedChunks = [];
  deepgramLive = deepgram.listen.live({
    model: 'nova-3',
    language: 'en-US',
    encoding: 'linear16',
    sample_rate: 16000,
    channels: 1,
    interim_results: true,
    endpointing: 60,
    utterance_end_ms: 700,
    vad_events: true,
    smart_format: true,
    punctuate: true,
  });

  deepgramLive.on(LiveTranscriptionEvents.Open, () => {
    opened = true;
    console.log('[Deepgram] Streaming connection open');
    emit({ type: 'status', text: 'Deepgram connected. Waiting for Meet audio...' });

    for (const chunk of bufferedChunks.splice(0)) {
      try { deepgramLive.send(chunk); } catch (_) {}
    }

    keepAliveTimer = setInterval(() => {
      try { deepgramLive?.keepAlive?.(); } catch (_) {}
    }, 8000);
  });

  deepgramLive.on(LiveTranscriptionEvents.Transcript, (data) => {
    const { text, isFinal, confidence } = extractTranscript(data);
    if (text) {
      emit({ text, isFinal, confidence });
    }
  });

  deepgramLive.on(LiveTranscriptionEvents.SpeechStarted, () => {
    console.log('[Deepgram] Speech detected');
    emit({ type: 'speech_started' });
  });

  deepgramLive.on(LiveTranscriptionEvents.UtteranceEnd, () => {
    emit({ type: 'status', text: 'Listening...' });
  });

  deepgramLive.on(LiveTranscriptionEvents.Error, (err) => {
    const msg = err?.message || err?.toString?.() || 'Deepgram error';
    console.error('[Deepgram] Stream error:', err);
    emit({ error: msg });
  });

  deepgramLive.on(LiveTranscriptionEvents.Close, () => {
    console.log('[Deepgram] Connection closed');
    opened = false;
    clearInterval(keepAliveTimer);
  });

  return true;
}

function sendAudioChunk(pcmBuffer) {
  if (!pcmBuffer || !pcmBuffer.length) return;
  try {
    if (deepgramLive?.getReadyState?.() === 1) {
      deepgramLive.send(pcmBuffer);
    } else if (!opened) {
      bufferedChunks.push(Buffer.from(pcmBuffer));
      if (bufferedChunks.length > MAX_BUFFERED_CHUNKS) bufferedChunks.shift();
    }
  } catch (e) {
    console.error('[Deepgram] sendAudioChunk error:', e.message);
  }
}

function stopDeepgramStream() {
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
  bufferedChunks = [];
  opened = false;
  if (deepgramLive) {
    try { deepgramLive.requestClose(); } catch (_) {}
    try { deepgramLive.finish(); } catch (_) {}
    deepgramLive = null;
  }
  transcriptCb = () => {};
}

module.exports = { startDeepgramStream, sendAudioChunk, stopDeepgramStream };
