let stream = null;
let ctx = null;
let processor = null;
let source = null;
let sink = null;
let running = false;
let intentionalStop = false;
let recoveryTimer = null;
let healthTimer = null;
let lastAudioCallbackAt = 0;
let recovering = false;

const AUDIO_CALLBACK_STALL_MS = 7000;
const RECOVERY_DELAY_MS = 1200;

function resampleTo16k(input, inputRate) {
  if (inputRate === 16000) return input;
  const ratio = inputRate / 16000;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) { sum += input[j]; count++; }
    out[i] = count ? sum / count : input[Math.min(start, input.length - 1)];
  }
  return out;
}

function floatToPcm16(float32) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(pcm.buffer);
}

function clearPipeline({ stopTracks = true } = {}) {
  running = false;
  try { if (processor) processor.disconnect(); } catch (_) {}
  try { if (source) source.disconnect(); } catch (_) {}
  try { if (sink) sink.disconnect(); } catch (_) {}
  if (stopTracks && stream) stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
  if (ctx) ctx.close().catch(() => {});
  stream = ctx = processor = source = sink = null;
}

function scheduleRecovery(reason) {
  if (intentionalStop || recovering || recoveryTimer) return;
  recovering = true;
  window.systemAudioAPI.status(`System audio interrupted (${reason}). Recovering automatically...`);
  recoveryTimer = setTimeout(async () => {
    recoveryTimer = null;
    clearPipeline();
    recovering = false;
    await start(true);
  }, RECOVERY_DELAY_MS);
}

function armHealthWatch() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(() => {
    if (intentionalStop || !running) return;
    const audioTrack = stream?.getAudioTracks?.()[0];
    if (!audioTrack || audioTrack.readyState === 'ended') return scheduleRecovery('audio track ended');
    if (ctx?.state === 'suspended') ctx.resume().catch(() => scheduleRecovery('audio context suspended'));
    if (lastAudioCallbackAt && Date.now() - lastAudioCallbackAt > AUDIO_CALLBACK_STALL_MS) scheduleRecovery('audio processing stalled');
  }, 2000);
}

async function start(isRecovery = false) {
  if (running || recoveryTimer) return;
  intentionalStop = false;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: { width: 2, height: 2, frameRate: 1 }
    });
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) throw new Error('Windows did not provide a system-audio track.');

    audioTracks[0].addEventListener('ended', () => { if (!intentionalStop) scheduleRecovery('audio track ended'); }, { once:true });
    ctx = new AudioContext({ latencyHint: 'interactive' });
    source = ctx.createMediaStreamSource(new MediaStream(audioTracks));
    processor = ctx.createScriptProcessor(2048, Math.max(1, source.channelCount || 1), 1);
    sink = ctx.createGain();
    sink.gain.value = 0;
    lastAudioCallbackAt = Date.now();
    processor.onaudioprocess = (event) => {
      if (!running) return;
      lastAudioCallbackAt = Date.now(); // callback health, including legitimate silence
      const channels = event.inputBuffer.numberOfChannels;
      const len = event.inputBuffer.length;
      const mono = new Float32Array(len);
      for (let c = 0; c < channels; c++) {
        const data = event.inputBuffer.getChannelData(c);
        for (let i = 0; i < len; i++) mono[i] += data[i] / channels;
      }
      const resampled = resampleTo16k(mono, ctx.sampleRate);
      window.systemAudioAPI.sendChunk(floatToPcm16(resampled));
    };
    source.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);
    running = true;
    armHealthWatch();
    window.systemAudioAPI.status(isRecovery
      ? `Windows system audio recovered (${ctx.sampleRate} Hz -> 16 kHz mono).`
      : `Windows system audio active (${ctx.sampleRate} Hz -> 16 kHz mono).`);
  } catch (err) {
    clearPipeline();
    if (isRecovery && !intentionalStop) scheduleRecovery(err?.message || 'capture restart failed');
    else window.systemAudioAPI.error(err?.message || String(err));
  }
}

function stop() {
  intentionalStop = true;
  recovering = false;
  if (recoveryTimer) clearTimeout(recoveryTimer);
  if (healthTimer) clearInterval(healthTimer);
  recoveryTimer = healthTimer = null;
  clearPipeline();
}
window.systemAudioAPI.onStart(() => start(false));
window.systemAudioAPI.onStop(stop);
