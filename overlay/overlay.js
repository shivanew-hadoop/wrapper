const $ = id => document.getElementById(id);
const appEl = $('app');
const joinPanel = $('joinPanel');
const livePanel = $('livePanel');
const joinBtn = $('joinBtn');
const leaveBtn = $('leaveBtn');
const closeBtn = $('closeBtn');
const collapseBtn = $('collapseBtn');
const statusEl = $('status');
const transcriptEl = $('transcript');
const answerEl = $('answer');
const modelLabel = $('modelLabel');
const fontDown = $('fontDown');
const fontUp = $('fontUp');
const fontSizeLabel = $('fontSizeLabel');
const captureWindowBtn = $('captureWindowBtn');
const autoSendBtn = $('autoSendBtn');
const sendBtn = $('sendBtn');
const manualPrompt = $('manualPrompt');
const sendFeedback = $('sendFeedback');
const transcriptPane = $('transcriptPane');
const transcriptResize = $('transcriptResize');
const creditTimer = $('creditTimer');
let creditSeconds = null;
let creditTick = null;
const creditWarnings = new Set();
function renderCredits() { if(!Number.isFinite(creditSeconds))return; const s=Math.max(0,Math.ceil(creditSeconds));creditTimer.textContent=`Credits: ${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }
function updateCredits(data) { if(!Number.isFinite(data?.remainingSeconds))return;creditSeconds=Math.max(0,data.remainingSeconds);renderCredits();clearInterval(creditTick);creditTick=setInterval(()=>{creditSeconds=Math.max(0,creditSeconds-1);renderCredits();},1000);for(const m of [30,10,5,1])if(creditSeconds<=m*60&&!creditWarnings.has(m)){creditWarnings.add(m);feedback(`${m} minute${m===1?'':'s'} of credits remaining.`,true);}if(data.status==='exhausted'){clearInterval(creditTick);feedback('Credits exhausted. Listening has stopped.',true);leaveBtn.classList.add('hidden');joinBtn.disabled=false;showJoin();} }

let finalLines = []; // { text, sent } — one finalized speech segment per visible line
let interimText = '';
let utteranceParts = [];
let llmTimer = null;
let feedbackTimer = null;
let llmRequestId = 0;
let activeStreamRequestId = null;
let streamHasText = false;
let streamedAnswerText = '';

function renderPlainAnswer(text) {
  streamedAnswerText = String(text || '').replace(/\*\*/g, '');
  answerEl.textContent = streamedAnswerText;
}

function appendPlainAnswerDelta(delta) {
  const clean = String(delta || '').replace(/\*\*/g, '');
  if (!clean) return;
  streamedAnswerText += clean;
  answerEl.appendChild(document.createTextNode(clean));
}

if (!localStorage.getItem('autoSendDefaultV143')) {
  localStorage.setItem('autoSend', 'false');
  localStorage.setItem('autoSendDefaultV143', '1');
}
let autoSend = localStorage.getItem('autoSend') === 'true';
let lastTranscriptAt = 0;
let lastFinalAt = 0;
// Fast auto-submit: start quickly after a short pause, but keep a continuation window so
// resumed speech is folded into the SAME logical question and regenerates one answer.
const AUTO_SEND_QUIET_MS = 450;
const AUTO_MERGE_WINDOW_MS = 8000;
let lastAutoSentText = '';
let lastAutoSentAt = 0;
let lastSendWasAuto = false;
let activeAutoLineIndex = -1;
let autoFinalizeTimer = null;
const MAX_LINES = 120;
const MIN_FONT = 10, MAX_FONT = 34, DEFAULT_FONT = 16;
let transcriptFont = Number(localStorage.getItem('transcriptFontPx') || DEFAULT_FONT);

function effectiveEmail() { return (localStorage.getItem('licenseEmail') || '').trim().toLowerCase(); }
function applyFontSize() {
  transcriptFont = Math.max(MIN_FONT, Math.min(MAX_FONT, transcriptFont));
  document.documentElement.style.setProperty('--transcript-font', `${transcriptFont}px`);
  fontSizeLabel.textContent = String(transcriptFont);
  localStorage.setItem('transcriptFontPx', String(transcriptFont));
}
fontDown.onclick = () => { transcriptFont -= 2; applyFontSize(); };
fontUp.onclick = () => { transcriptFont += 2; applyFontSize(); };
applyFontSize();

function showJoin() {
  joinPanel.classList.remove('hidden');
  livePanel.classList.add('hidden');
  leaveBtn.classList.add('hidden');
}
function showLive(msg) {
  joinPanel.classList.add('hidden');
  livePanel.classList.remove('hidden');
  leaveBtn.classList.remove('hidden');
  statusEl.textContent = msg;
}
function feedback(message, isError=false) {
  clearTimeout(feedbackTimer);
  sendFeedback.textContent = message || '';
  sendFeedback.classList.toggle('errorText', !!isError);
  if (message) feedbackTimer = setTimeout(() => { sendFeedback.textContent=''; sendFeedback.classList.remove('errorText'); }, 2600);
}

async function initializeSession() {
  const session = await window.electronAPI.getSessionInfo().catch(() => null);
  if (!session?.licenseEmail || !session?.contextPrepared) {
    // Overlay is only reachable after setup validation; if state is missing, close back to setup path.
    statusEl.textContent = 'Interview setup is required.';
    await window.electronAPI.stopAndReturnSetup?.();
    return;
  }
  localStorage.setItem('licenseEmail', session.licenseEmail);
  showJoin();
}
initializeSession();

joinBtn.onclick = async () => {
  joinBtn.disabled = true;
  showLive('Validating license and connecting speech recognition...');
  const res = await window.electronAPI.startListening({ licenseEmail: effectiveEmail() });
  if (!res.success) {
    joinBtn.disabled = false;
    statusEl.textContent = res.error || 'Failed to start';
    feedback(res.error || 'License validation/start failed.', true);
    if (res.licenseRequired) {
      await window.electronAPI.stopAndReturnSetup();
    } else {
      showJoin();
    }
  }
};

leaveBtn.onclick = async () => {
  markPendingTranscriptSent();

  if (activeStreamRequestId) window.electronAPI.cancelLLMStream(activeStreamRequestId);
  activeStreamRequestId = null;
  clearTimeout(llmTimer);
  await window.electronAPI.stopAndReturnSetup();
};
closeBtn.onclick = () => window.electronAPI.closeOverlay();

let collapsed = localStorage.getItem('overlayCollapsed') === 'true';
async function applyCollapsed() {
  appEl.classList.toggle('collapsed', collapsed);
  collapseBtn.textContent = collapsed ? '+' : '−';
  localStorage.setItem('overlayCollapsed', String(collapsed));
  await window.electronAPI.setOverlayCollapsed(collapsed);
}
collapseBtn.onclick = async () => { collapsed = !collapsed; await applyCollapsed(); };
setTimeout(applyCollapsed, 150);

function renderTranscript({ followLatest = true } = {}) {
  transcriptEl.innerHTML = '';
  if (!finalLines.length && !interimText) {
    const empty = document.createElement('div');
    empty.className = 'transcriptEmpty';
    empty.textContent = 'Waiting for system audio...';
    transcriptEl.appendChild(empty);
    return;
  }

  // Keep transcript history in natural reading order. Sent questions stay above and
  // the current speech-to-text question is always the last row, so followLatest can
  // keep the newest printed words visible without overlapping the controls.
  finalLines.filter(item => item.sent).forEach(item => {
    const line = document.createElement('div');
    line.className = 'transcriptQuestion sentQuestion';
    line.textContent = item.text;
    transcriptEl.appendChild(line);
  });

  const pendingItems = finalLines.filter(item => !item.sent);
  const pendingBase = pendingItems.map(item => item.text).join(' ').replace(/\s+/g, ' ').trim();
  const pendingText = [pendingBase, interimText].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (pendingText) {
    const pending = document.createElement('div');
    pending.className = `transcriptQuestion pendingQuestion${interimText ? ' interimQuestion' : ''}`;
    pending.textContent = pendingText;
    transcriptEl.appendChild(pending);
  }
  if (followLatest) requestAnimationFrame(() => { transcriptEl.scrollTop = transcriptEl.scrollHeight; });
}
function markPendingTranscriptSent() {
  finalLines.forEach(item => { if (!item.sent) item.sent = true; });
  renderTranscript();
}

function getCompleteUnsentTranscript() {
  // finalLines is the UI/source-of-truth for everything Deepgram has finalized since
  // the last send. Include the current interim tail so Send/Ctrl+Enter cannot lose
  // words that are already visible in Live Questions but not yet speech_final.
  const finalized = finalLines.filter(item => !item.sent).map(item => item.text).join(' ');
  const visible = [finalized, interimText].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (visible) return visible;
  // Fallback for an edge case where a finalized chunk reached the utterance buffer
  // before the transcript row was painted.
  return utteranceParts.join(' ').replace(/\s+/g, ' ').trim();
}

// Growing Live Questions grows the whole overlay by the same amount, preserving LLM answer room.
let transcriptHeight = Number(localStorage.getItem('transcriptPaneHeight') || 104);
function applyTranscriptHeight() {
  transcriptHeight = Math.max(88, Math.min(320, transcriptHeight));
  document.documentElement.style.setProperty('--transcript-pane-height', `${transcriptHeight}px`);
  localStorage.setItem('transcriptPaneHeight', String(transcriptHeight));
}
applyTranscriptHeight();
let resizingTranscript = false;
let transcriptPointerY = 0;
let transcriptResizePending = false;
transcriptResize.addEventListener('pointerdown', e => {
  resizingTranscript = true;
  transcriptPointerY = e.clientY;
  transcriptResize.setPointerCapture(e.pointerId);
  e.preventDefault();
});
transcriptResize.addEventListener('pointermove', async e => {
  if (!resizingTranscript || transcriptResizePending) return;
  const delta = Math.trunc(e.clientY - transcriptPointerY);
  if (!delta) return;
  const target = Math.max(88, Math.min(320, transcriptHeight + delta));
  const requested = target - transcriptHeight;
  if (!requested) return;
  transcriptPointerY = e.clientY;
  transcriptResizePending = true;
  try {
    const applied = await window.electronAPI.resizeOverlayForTranscript(requested);
    transcriptHeight += Number(applied) || 0;
    applyTranscriptHeight();
  } finally { transcriptResizePending = false; }
});
transcriptResize.addEventListener('pointerup', e => {
  resizingTranscript = false;
  try { transcriptResize.releasePointerCapture(e.pointerId); } catch (_) {}
});

function isLikelyContinuation(fragment) {
  const q = String(fragment || '').trim().toLowerCase();
  return /^(and|also|but|or|then|so|because|which|where|when|with|without|using|for|from|in|on|to|if|while|plus|along with)\b/.test(q);
}

function sendUtteranceToLLM({ auto = false, replacementText = '', typedText = '' } = {}) {
  clearTimeout(llmTimer);
  const spoken = (replacementText || getCompleteUnsentTranscript()).replace(/\s+/g, ' ').trim();
  const typed = String(typedText || '').replace(/\s+/g, ' ').trim();
  const text = typed || spoken;

  if (!text || text.length < 2) {
    feedback('Nothing to send.', true);
    return false;
  }

  // A manually typed prompt is authoritative for this turn. When the user explicitly
  // presses Send/Enter, close any pending system-audio question as already read so it
  // cannot be auto-sent later or compete with the manual question. Only the typed text
  // is sent to the LLM; the pending speech remains visible below as dim history.
  if (typed) {
    utteranceParts = [];
    interimText = '';
    markPendingTranscriptSent();
    clearTimeout(llmTimer);
    lastSendWasAuto = false;
    lastAutoSentText = '';
    lastAutoSentAt = 0;
    activeAutoLineIndex = -1;
    clearTimeout(autoFinalizeTimer);
    manualPrompt.value = '';
  } else {
    utteranceParts = [];
    // Manual sends close the current transcript question immediately. Auto sends keep
    // the same visible question addressable during the continuation window.
    if (!auto) markPendingTranscriptSent();
  }

  if (auto) {
    lastAutoSentText = text;
    lastAutoSentAt = Date.now();
    lastSendWasAuto = true;
    if (activeAutoLineIndex < 0) activeAutoLineIndex = finalLines.findIndex(item => !item.sent);
    // Auto Send has actually submitted this question, so dim it immediately. If speech
    // resumes inside the merge window, the transcript handler flips this SAME line back
    // to pending/bright, appends the continuation, cancels the stale answer and resends it.
    if (activeAutoLineIndex >= 0 && finalLines[activeAutoLineIndex]) {
      finalLines[activeAutoLineIndex].sent = true;
      renderTranscript({ followLatest:false });
    }
    clearTimeout(autoFinalizeTimer);
    const sentStamp = lastAutoSentAt;
    autoFinalizeTimer = setTimeout(() => {
      if (lastSendWasAuto && lastAutoSentAt === sentStamp) {
        activeAutoLineIndex = -1;
        lastSendWasAuto = false;
        lastAutoSentText = '';
        lastAutoSentAt = 0;
      }
    }, AUTO_MERGE_WINDOW_MS);
  } else {
    lastSendWasAuto = false;
    lastAutoSentText = '';
    lastAutoSentAt = 0;
    activeAutoLineIndex = -1;
    clearTimeout(autoFinalizeTimer);
  }

  if (activeStreamRequestId) window.electronAPI.cancelLLMStream(activeStreamRequestId);
  const requestId = `q-${Date.now()}-${++llmRequestId}`;
  activeStreamRequestId = requestId;
  streamHasText = false;
  // Keep the previous answer readable while the next request is being prepared.
  // The answer body is replaced only when the first token of the new answer arrives.
  modelLabel.textContent = 'Thinking… · retrieving context…';
  feedback(auto ? 'Auto sent' : 'Sent');
  window.electronAPI.startLLMStream({ requestId, text, licenseEmail:effectiveEmail() });
  return true;
}

function scheduleLLM() {
  clearTimeout(llmTimer);
  if (!autoSend || !getCompleteUnsentTranscript()) return;
  const wait = Math.max(0, AUTO_SEND_QUIET_MS - (Date.now() - lastTranscriptAt));
  llmTimer = setTimeout(() => {
    const remaining = AUTO_SEND_QUIET_MS - (Date.now() - lastTranscriptAt);
    if (remaining > 0) return scheduleLLM();
    sendUtteranceToLLM({ auto:true });
  }, wait);
}

function renderAutoSend() {
  autoSendBtn.textContent = `Auto Send: ${autoSend ? 'ON' : 'OFF'}`;
  autoSendBtn.classList.toggle('autoOn', autoSend);
  manualPrompt.classList.remove('hidden');
  if (!autoSend) setTimeout(() => manualPrompt.focus(), 0);
}
autoSendBtn.onclick = () => {
  autoSend = !autoSend;
  localStorage.setItem('autoSend', String(autoSend));
  clearTimeout(llmTimer);
  renderAutoSend();
  feedback(autoSend ? 'Auto Send enabled.' : 'Auto Send disabled. Type or use captured speech, then Send.');
  if (autoSend && getCompleteUnsentTranscript()) scheduleLLM();
};
function sendManualOrPending() {
  const typed = manualPrompt.value.trim();
  if (typed) return sendUtteranceToLLM({ auto:false, typedText:typed });
  const recent = getCompleteUnsentTranscript();
  if (recent) return sendUtteranceToLLM({ auto:false, replacementText:recent });
  feedback('Nothing to send.', true);
  return false;
}

async function copyRecentAndSend() {
  const recent = getCompleteUnsentTranscript();
  if (!recent) { feedback('Nothing to send.', true); return false; }

  // Ctrl+Enter copies the latest unsent captured question to the Windows clipboard
  // and sends the exact same question to the LLM. It intentionally does not alter
  // or focus the manual input field, so the clipboard remains ready for Ctrl+V in
  // another Windows application.
  const copied = await window.electronAPI.copyToClipboard(recent).catch(() => ({ success:false }));
  if (!copied?.success) feedback('Could not copy prompt to clipboard.', true);
  return sendUtteranceToLLM({ auto:false, replacementText:recent });
}


async function captureWindowAndSolve() {
  if (!captureWindowBtn || captureWindowBtn.disabled) return;
  captureWindowBtn.disabled = true;
  captureWindowBtn.classList.add('capturing');
  const previousLabel = captureWindowBtn.textContent;
  captureWindowBtn.textContent = 'Capturing…';
  modelLabel.textContent = 'Capturing screen…';
  feedback('Capturing current screen…');
  try {
    // Topper remains on screen. Windows content-protection excludes the overlay from the capture.
    const shot = await window.electronAPI.captureCurrentWindow();
    if (!shot?.success || !shot.imageDataUrl) {
      feedback(shot?.error || 'Screen capture failed.', true);
      modelLabel.textContent = '';
      return;
    }
    modelLabel.textContent = `Reading screen… · capture ${shot.captureMs || 0}ms`;
    const extracted = await window.electronAPI.extractScreenText({
      imageDataUrl:shot.imageDataUrl,
      captureSource:shot.sourceName || '',
      licenseEmail:effectiveEmail()
    });
    if (!extracted?.success || !String(extracted.text || '').trim()) {
      feedback(extracted?.error || 'No useful text found on screen.', true);
      modelLabel.textContent = '';
      return;
    }
    const block = String(extracted.text).trim();
    const existing = manualPrompt.value.trim();
    manualPrompt.value = existing ? `${existing}\n\n--- CAPTURE ${Date.now()} ---\n${block}` : block;
    // Captured text is deliberately staged, not auto-sent: repeated captures accumulate here.
    manualPrompt.classList.remove('hidden');
    manualPrompt.scrollTop = manualPrompt.scrollHeight;
    modelLabel.textContent = `Screen added · ${extracted.captureMs || 0}ms`;
    feedback('Screen text added to prompt. Capture more screens or press Send.');
  } catch (err) {
    feedback(err?.message || 'Screen capture failed.', true);
    modelLabel.textContent = '';
  } finally {
    captureWindowBtn.disabled = false;
    captureWindowBtn.classList.remove('capturing');
    captureWindowBtn.textContent = previousLabel;
  }
}

captureWindowBtn.onclick = captureWindowAndSolve;

sendBtn.onclick = sendManualOrPending;

// Keyboard shortcuts work at overlay level, not only when the text box already has focus.
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey || e.repeat) return;
  if (e.ctrlKey) {
    e.preventDefault();
    e.stopPropagation();
    copyRecentAndSend();
    return;
  }
  // Plain Enter is the Send key in manual mode.
  if (!autoSend || manualPrompt.value.trim()) {
    e.preventDefault();
    e.stopPropagation();
    sendManualOrPending();
  }
}, true);
renderAutoSend();

window.electronAPI.onLLMStream(msg => {
  if (!msg || msg.requestId !== activeStreamRequestId) return;
  if (msg.type === 'delta') {
    if (!streamHasText) {
      streamedAnswerText = '';
      streamHasText = true;
      answerEl.textContent = '';
      answerEl.scrollTop = 0;
    }
    // Append each provider delta immediately. Avoid rebuilding the whole answer on every token.
    appendPlainAnswerDelta(msg.delta || '');
  } else if (msg.type === 'meta') {
    if (msg.phase === 'retrieval') {
      const bits = [];
      if (msg.retrievalMode) bits.push(msg.retrievalMode);
      if (Number.isFinite(msg.embeddingMs)) bits.push(`embed ${msg.embeddingMs}ms`);
      if (Number.isFinite(msg.retrievalMs)) bits.push(`search ${msg.retrievalMs}ms`);
      modelLabel.textContent = bits.join(' · ') || msg.model || '';
    } else if (msg.phase === 'retry') {
      modelLabel.textContent = 'provider retry…';
    } else if (msg.phase === 'complete' && msg.latency) {
      const first = msg.latency.firstTokenMs;
      modelLabel.textContent = `${msg.model || ''}${Number.isFinite(first) ? ` · first ${first}ms` : ''}`.trim();
    }
  } else if (msg.type === 'done') {
    if (!streamHasText) renderPlainAnswer(msg.answer || 'No answer returned.');
    if (msg.model) {
      const first = msg.latency?.firstTokenMs;
      modelLabel.textContent = `${msg.model}${Number.isFinite(first) ? ` · first ${first}ms` : ''}`;
    }
    activeStreamRequestId = null;
  } else if (msg.type === 'error') {
    answerEl.textContent = `LLM error: ${msg.error || 'Request failed'}`;
    modelLabel.textContent = '';
    activeStreamRequestId = null;
  }
});

window.electronAPI.onStatus(msg => statusEl.textContent = msg);
window.electronAPI.onSpeechStart(() => { statusEl.textContent = 'Speech detected from Windows system audio...'; });
window.electronAPI.onCredits(updateCredits);
window.electronAPI.onTranscript(({text,isFinal}) => {
  if (!text) return;
  const clean = text.trim();
  if (isFinal) {
    const now = Date.now();
    const withinMergeWindow = lastSendWasAuto && lastAutoSentText && (now - lastAutoSentAt) <= AUTO_MERGE_WINDOW_MS;
    const shouldMerge = autoSend && withinMergeWindow;

    if (shouldMerge) {
      // Any speech that resumes during the continuation window belongs to the same auto question.
      // Keep one transcript line, cancel the stale generation, combine ALL fragments, and regenerate.
      const combined = `${lastAutoSentText} ${clean}`.replace(/\s+/g, ' ').trim();
      lastAutoSentText = combined;
      lastAutoSentAt = now;
      lastTranscriptAt = now;
      if (activeAutoLineIndex >= 0 && finalLines[activeAutoLineIndex]) {
        finalLines[activeAutoLineIndex].text = combined;
        finalLines[activeAutoLineIndex].sent = false;
      } else {
        finalLines.push({ text: combined, sent: false });
        activeAutoLineIndex = finalLines.length - 1;
      }
      if (activeStreamRequestId) window.electronAPI.cancelLLMStream(activeStreamRequestId);
      clearTimeout(llmTimer);
      llmTimer = setTimeout(() => sendUtteranceToLLM({ auto:true, replacementText:combined }), AUTO_SEND_QUIET_MS);
    } else {
      // New logical question: close the prior auto question only after its continuation window expired.
      if (lastSendWasAuto && activeAutoLineIndex >= 0 && finalLines[activeAutoLineIndex]) {
        finalLines[activeAutoLineIndex].sent = true;
      }
      activeAutoLineIndex = -1;
      lastSendWasAuto = false;
      lastAutoSentText = '';
      lastAutoSentAt = 0;
      // Keep every finalized Deepgram chunk for the CURRENT unsent question in one line.
      // A new line is created only after the previous question has actually been sent.
      const pendingIndex = finalLines.findIndex(item => !item.sent);
      if (pendingIndex >= 0) {
        finalLines[pendingIndex].text = `${finalLines[pendingIndex].text} ${clean}`.replace(/\s+/g, ' ').trim();
      } else {
        finalLines.push({ text: clean, sent: false });
      }
      if (finalLines.length > MAX_LINES) finalLines = finalLines.slice(-MAX_LINES);
      utteranceParts.push(clean);
      lastTranscriptAt = now;
      lastFinalAt = now;
      scheduleLLM();
    }
    interimText = '';
  } else {
    interimText = clean;
  }
  renderTranscript();
});
