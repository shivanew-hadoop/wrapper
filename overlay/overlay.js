const $ = id => document.getElementById(id);
const appEl = $('app');
const privateCursor = $('privateCursor');
let privateCursorHotspot = { x: 0, y: 0 };

// Main-process private cursor tracking
window.electronAPI.onPrivateCursorVisual(data => {
  if (!privateCursor || !data?.dataUrl) return;
  privateCursor.style.width = `${Number(data.width) || 24}px`;
  privateCursor.style.height = `${Number(data.height) || 32}px`;
  privateCursor.style.backgroundImage = `url("${data.dataUrl}")`;
  privateCursorHotspot = { x: Number(data.hotspotX) || 0, y: Number(data.hotspotY) || 0 };
});

window.electronAPI.onPrivateCursorPosition(data => {
  if (!privateCursor || !data?.visible) { privateCursor?.classList.remove('visible'); return; }
  privateCursor.style.transform = `translate3d(${(Number(data.x) || 0) - privateCursorHotspot.x}px,${(Number(data.y) || 0) - privateCursorHotspot.y}px,0)`;
  privateCursor.classList.add('visible');
});
document.addEventListener('mousedown', () => privateCursor?.classList.add('pressed'), true);
document.addEventListener('mouseup', () => privateCursor?.classList.remove('pressed'), true);

// Disable browser popups
document.querySelectorAll('[title]').forEach(element => element.removeAttribute('title'));

// Core DOM Elements
const joinPanel = $('joinPanel');
const livePanel = $('livePanel');
const joinBtn = $('joinBtn');
const backBtn = $('backBtn');
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
const reanswerBtn = $('reanswerBtn');
const autoSendBtn = $('autoSendBtn');
const sendBtn = $('sendBtn');
const manualPrompt = $('manualPrompt');
const sendFeedback = $('sendFeedback');
const transcriptPane = $('transcriptPane');
const transcriptResize = $('transcriptResize');
const creditTimer = $('creditTimer');

// Low Latency, Cost Optimization & Grounding UI Elements
const providerTierSelect = $('providerTierSelect');
const tokenBudgetLabel = $('tokenBudgetLabel');
const sttPhoneticBadge = $('sttPhoneticBadge');
const groundingBadge = $('groundingBadge');
const lexicalBypassBadge = $('lexicalBypassBadge');
const fastPathIndicator = $('fastPathIndicator');
const latencyMetric = $('latencyMetric');
const answerModeBadge = $('answerModeBadge');
const sttCorrectionNotice = $('sttCorrectionNotice');

// State Management
let creditSeconds = null;
let creditTick = null;
const creditWarnings = new Set();

// Dynamic Provider Tier Initialization
const savedTier = localStorage.getItem('providerTier') || 'cerebras-fast';
if (providerTierSelect) {
  providerTierSelect.value = savedTier;
  providerTierSelect.onchange = () => {
    localStorage.setItem('providerTier', providerTierSelect.value);
    feedback(`Provider updated: ${providerTierSelect.options[providerTierSelect.selectedIndex].text}`);
  };
}

function renderCredits() { 
  if (!Number.isFinite(creditSeconds)) return; 
  const s = Math.max(0, Math.ceil(creditSeconds));
  creditTimer.textContent = `Credits: ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; 
}

function updateCredits(data) { 
  if (!Number.isFinite(data?.remainingSeconds)) return;
  creditSeconds = Math.max(0, data.remainingSeconds);
  renderCredits();
  clearInterval(creditTick);
  creditTick = setInterval(() => { creditSeconds = Math.max(0, creditSeconds - 1); renderCredits(); }, 1000);
  for (const m of [30, 10, 5, 1]) {
    if (creditSeconds <= m * 60 && !creditWarnings.has(m)) {
      creditWarnings.add(m);
      feedback(`${m} minute${m === 1 ? '' : 's'} of credits remaining.`, true);
    }
  }
  if (data.status === 'exhausted') {
    clearInterval(creditTick);
    feedback('Credits exhausted. Listening has stopped.', true);
    leaveBtn.classList.add('hidden');
    joinBtn.disabled = false;
    showJoin();
  } 
}

let finalLines = []; // { text, sent }
let interimText = '';
let utteranceParts = [];
let llmTimer = null;
let feedbackTimer = null;
let llmRequestId = 0;
let activeStreamRequestId = null;
let streamHasText = false;
let streamedAnswerText = '';
let pendingRenderDelta = '';
let renderFramePending = false;
let lastSubmittedPrompt = null; 

function escapeAnswerHtml(value) {
  return String(value || '').replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]));
}

function cleanAnswerForHistory(text) {
  return String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^\s*```[^\r\n`]*\s*$/gm, '')
    .replace(/^\s*```\s*$/gm, '')
    .replace(/⟦(?:Resume|JD)\s*·\s*[^⟧]+⟧/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inlineAnswerMarkup(value) {
  return escapeAnswerHtml(value).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

function richAnswerHtml(text) {
  const clean = String(text || '')
    .replace(/⟦(?:Resume|JD)\s*·\s*[^⟧]+⟧/g, '')
    .replace(/^\s*```[^\r\n`]*\s*$/gm, '')
    .replace(/^\s*```\s*$/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  const lines = clean.split('\n');
  const out = [];
  let code = [];
  let inCode = false;
  const flushCode = () => {
    if (!code.length) return;
    out.push(`<pre class="answerCodeEditor"><code>${escapeAnswerHtml(code.join('\n').replace(/^\n+|\n+$/g,''))}</code></pre>`);
    code = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(Complete code|Code snippet|Logic|Solution):\s*$/i.test(trimmed)) {
      flushCode();
      inCode = true;
      out.push(`<div class="answerCodeLabel">${inlineAnswerMarkup(trimmed)}</div>`);
      continue;
    }
    if (inCode && /^(Sample input|Sample output|Complexity|Time complexity|Space complexity|Explanation|How it works):/i.test(trimmed)) {
      flushCode();
      inCode = false;
    }
    if (inCode) { code.push(line); continue; }
    if (!trimmed) { out.push('<div class="answerParagraphGap"></div>'); continue; }
    if (/^[-•]\s+/.test(trimmed)) out.push(`<div class="answerBullet">${inlineAnswerMarkup(trimmed.replace(/^[-•]\s+/,''))}</div>`);
    else out.push(`<div class="answerLine">${inlineAnswerMarkup(line)}</div>`);
  }
  flushCode();
  return out.join('');
}

function renderRichAnswer(target, text) {
  if (!target) return;
  target.innerHTML = richAnswerHtml(text);
}

function flushPendingAnswerDelta() {
  renderFramePending = false;
  if (!pendingRenderDelta) return;
  streamedAnswerText += pendingRenderDelta;
  pendingRenderDelta = '';
  if (!activeAnswerTurn) {
    renderRichAnswer(answerEl, streamedAnswerText);
    return;
  }
  activeAnswerTurn.answer = cleanAnswerForHistory(streamedAnswerText);
  renderRichAnswer(activeAnswerTurn.responseElement, streamedAnswerText);
  ensureCurrentTurnReadingSlot(activeAnswerTurn);
}

function queuePlainAnswerDelta(delta) {
  const clean = String(delta || '');
  if (!clean) return;
  pendingRenderDelta += clean;
  if (!renderFramePending) {
    renderFramePending = true;
    requestAnimationFrame(flushPendingAnswerDelta);
  }
}

let manualPromptContainsCapture = false;
let manualPromptTaskType = 'other';
let capturedScreenCount = 0;
let manualSendTimer = null;
let manualSendStartedAt = 0;
const MANUAL_SEND_QUIET_MS = 60;
const MANUAL_SEND_MAX_WAIT_MS = 140;
const MANUAL_COMMIT_DEDUPE_MS = 6500;
let manualCommitGuard = { text: '', at: 0 };

let interviewStartedAt = null;
let sessionTurns = [];
let activeAnswerTurn = null;

function formatTurnTime(ms) {
  const d = new Date(Number(ms) || Date.now());
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function clearCurrentTurnReadingSlot(turn = activeAnswerTurn) {
  if (!turn?.element) return;
  turn.element.classList.remove('currentReadingTurn');
  turn.element.style.minHeight = '';
}

function ensureCurrentTurnReadingSlot(turn) {
  if (!turn?.element || !turn.element.isConnected) return;
  turn.element.classList.add('currentReadingTurn');
  turn.element.style.minHeight = `${Math.max(1, answerEl.clientHeight)}px`;
}

function scrollTurnToTop(turn) {
  if (!turn?.element) return;
  ensureCurrentTurnReadingSlot(turn);

  const answerRect = answerEl.getBoundingClientRect();
  const turnRect = turn.element.getBoundingClientRect();
  const top = Math.max(0, answerEl.scrollTop + turnRect.top - answerRect.top);
  answerEl.scrollTop = top;
  requestAnimationFrame(() => {
    ensureCurrentTurnReadingSlot(turn);
    const settledAnswerRect = answerEl.getBoundingClientRect();
    const settledTurnRect = turn.element.getBoundingClientRect();
    answerEl.scrollTop = Math.max(0, answerEl.scrollTop + settledTurnRect.top - settledAnswerRect.top);
  });
}

function buildTurnElement(turn) {
  const wrap = document.createElement('section');
  wrap.className = 'qaTurn';
  wrap.dataset.turnId = turn.id;

  const meta = document.createElement('div');
  meta.className = 'qaMeta';
  meta.textContent = formatTurnTime(turn.askedAt);

  const response = document.createElement('div');
  response.className = 'qaResponse';
  response.textContent = '';

  const separator = document.createElement('div');
  separator.className = 'qaSeparator';
  separator.textContent = '· · · · · · · · · · · ·';

  wrap.append(meta, response, separator);
  turn.element = wrap;
  turn.responseElement = response;
  return wrap;
}

function startOrRefreshAnswerTurn({ requestId, question, auto = false, reuseAuto = false }) {
  const cleanQuestion = String(question || '').trim();
  if (reuseAuto && activeAnswerTurn) {
    activeAnswerTurn.requestId = requestId;
    activeAnswerTurn.question = cleanQuestion;
    activeAnswerTurn.answeredAt = null;
    activeAnswerTurn.auto = !!auto;
    if (reuseAuto) {
      activeAnswerTurn.answer = '';
      activeAnswerTurn.responseElement.textContent = '';
    }
    scrollTurnToTop(activeAnswerTurn);
    return activeAnswerTurn;
  }
  const turn = {
    id: `turn-${Date.now()}-${sessionTurns.length + 1}`,
    requestId,
    question: cleanQuestion,
    answer: '',
    askedAt: Date.now(),
    answeredAt: null,
    auto: !!auto,
    element: null,
    responseElement: null
  };
  const previousTurn = activeAnswerTurn;
  sessionTurns.push(turn);
  activeAnswerTurn = turn;
  if (answerEl.querySelector('.answerPlaceholder')) answerEl.textContent = '';
  clearCurrentTurnReadingSlot(previousTurn);
  answerEl.appendChild(buildTurnElement(turn));
  scrollTurnToTop(turn);
  return turn;
}

function renderPlainAnswer(text) {
  streamedAnswerText = String(text || '');
  if (!activeAnswerTurn) {
    renderRichAnswer(answerEl, streamedAnswerText);
    return;
  }
  activeAnswerTurn.answer = cleanAnswerForHistory(streamedAnswerText);
  renderRichAnswer(activeAnswerTurn.responseElement, streamedAnswerText);
}

function serializableSessionTurns() {
  return sessionTurns
    .filter(turn => String(turn.question || '').trim() && String(turn.answer || '').trim())
    .map(turn => ({
      question: String(turn.question || '').trim(),
      answer: String(turn.answer || '').trim(),
      askedAt: Number(turn.askedAt) || Date.now(),
      answeredAt: Number(turn.answeredAt) || Number(turn.askedAt) || Date.now()
    }));
}

async function saveCompletedInterviewSession() {
  const turns = serializableSessionTurns();
  if (!turns.length || !interviewStartedAt) return { success: true, skipped: true };
  return window.electronAPI.saveInterviewTranscript({
    startedAt: interviewStartedAt,
    endedAt: Date.now(),
    turns
  }).catch(() => ({ success: false }));
}

if (!localStorage.getItem('autoSendDefaultV143')) {
  localStorage.setItem('autoSend', 'false');
  localStorage.setItem('autoSendDefaultV143', '1');
}
let autoSend = localStorage.getItem('autoSend') === 'true';
let lastTranscriptAt = 0;
let lastFinalAt = 0;

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
function feedback(message, isError = false) {
  clearTimeout(feedbackTimer);
  sendFeedback.textContent = message || '';
  sendFeedback.classList.toggle('errorText', !!isError);
  if (message) feedbackTimer = setTimeout(() => { sendFeedback.textContent = ''; sendFeedback.classList.remove('errorText'); }, 2600);
}

async function initializeSession() {
  const session = await window.electronAPI.getSessionInfo().catch(() => null);
  if (!session?.licenseEmail || !session?.contextPrepared) {
    statusEl.textContent = 'Interview setup is required.';
    await window.electronAPI.stopAndReturnSetup?.();
    return;
  }
  localStorage.setItem('licenseEmail', session.licenseEmail);
  showJoin();
}
initializeSession();

backBtn.onclick = async () => {
  backBtn.disabled = true;
  joinBtn.disabled = true;
  await window.electronAPI.stopAndReturnSetup();
};

joinBtn.onclick = async () => {
  joinBtn.disabled = true;
  showLive('Validating license and connecting speech recognition...');
  const res = await window.electronAPI.startListening({ licenseEmail: effectiveEmail() });
  if (res.success) {
    interviewStartedAt = Date.now();
    sessionTurns = [];
    activeAnswerTurn = null;
    streamedAnswerText = '';
    answerEl.innerHTML = '<div class="answerPlaceholder">Waiting for a complete question...</div>';
  }
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
  await saveCompletedInterviewSession();
  await window.electronAPI.stopAndReturnSetup();
};

closeBtn.onclick = async () => {
  if (activeStreamRequestId) window.electronAPI.cancelLLMStream(activeStreamRequestId);
  activeStreamRequestId = null;
  clearTimeout(llmTimer);
  await saveCompletedInterviewSession();
  await window.electronAPI.closeOverlay();
};

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

  finalLines.filter(item => item.sent).forEach(item => {
    const line = document.createElement('div');
    line.className = 'transcriptQuestion sentQuestion';
    line.textContent = item.text;
    transcriptEl.appendChild(line);
  });

  const pendingItems = finalLines.filter(item => !item.sent);
  const pendingBase = pendingItems.map(item => item.text).join(' ').replace(/\s+/g, ' ').trim();
  const pendingText = mergeTranscriptText(pendingBase, interimText);
  if (pendingText) {
    const pending = document.createElement('div');
    pending.className = `transcriptQuestion pendingQuestion${interimText ? ' interimQuestion' : ''}`;
    pending.textContent = pendingText;
    transcriptEl.appendChild(pending);
  }
  if (followLatest) requestAnimationFrame(() => { transcriptEl.scrollTop = transcriptEl.scrollHeight; });
}

function markPendingTranscriptSent() {
  if (interimText) {
    const pendingIndex = finalLines.findIndex(item => !item.sent);
    if (pendingIndex >= 0) finalLines[pendingIndex].text = mergeTranscriptText(finalLines[pendingIndex].text, interimText);
    else finalLines.push({ text: interimText, sent: false });
    interimText = '';
  }
  finalLines.forEach(item => { if (!item.sent) item.sent = true; });
  renderTranscript();
}

function getCompleteUnsentTranscript() {
  const finalized = finalLines.filter(item => !item.sent).map(item => item.text).join(' ');
  const visible = mergeTranscriptText(finalized, interimText);
  if (visible) return visible;
  return utteranceParts.join(' ').replace(/\s+/g, ' ').trim();
}

function comparableWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).map(word => word.toLowerCase().replace(/^[^a-z0-9+#]+|[^a-z0-9+#]+$/gi, '')).filter(Boolean);
}

function mergeTranscriptText(base, tail) {
  const left = String(base || '').replace(/\s+/g, ' ').trim();
  const right = String(tail || '').replace(/\s+/g, ' ').trim();
  if (!left) return right;
  if (!right) return left;
  const leftOriginal = left.split(/\s+/), rightOriginal = right.split(/\s+/);
  const leftWords = comparableWords(left), rightWords = comparableWords(right);
  const maximum = Math.min(80, leftWords.length, rightWords.length);
  for (let count = maximum; count >= 2; count--) {
    if (leftWords.slice(-count).join(' ') === rightWords.slice(0, count).join(' ')) {
      return [...leftOriginal, ...rightOriginal.slice(count)].join(' ').trim();
    }
  }
  return `${left} ${right}`.trim();
}

function stripCommittedOverlap(incoming) {
  const raw = String(incoming || '').trim();
  if (!raw || !manualCommitGuard.text || Date.now() - manualCommitGuard.at > MANUAL_COMMIT_DEDUPE_MS) return raw;
  const committed = comparableWords(manualCommitGuard.text);
  const incomingOriginal = raw.split(/\s+/).filter(Boolean);
  const incomingComparable = comparableWords(raw);
  if (!committed.length || !incomingComparable.length) return raw;

  const maximum = Math.min(80, committed.length, incomingComparable.length);
  for (let count = maximum; count >= 2; count--) {
    const committedTail = committed.slice(-count).join(' ');
    const incomingHead = incomingComparable.slice(0, count).join(' ');
    if (committedTail === incomingHead) return incomingOriginal.slice(count).join(' ').trim();
  }
  if (incomingComparable.length >= 2 && committed.slice(-incomingComparable.length).join(' ') === incomingComparable.join(' ')) return '';
  return raw;
}

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

function hasVisibleActiveAnswer() {
  return !!(streamHasText || pendingRenderDelta || String(activeAnswerTurn?.answer || '').trim() || String(streamedAnswerText || '').trim());
}

function sendUtteranceToLLM({ auto = false, replacementText = '', typedText = '', inputSource = '', regenerate = false } = {}) {
  clearTimeout(llmTimer);
  clearTimeout(manualSendTimer);
  manualSendTimer = null;
  manualSendStartedAt = 0;
  const spoken = (replacementText || getCompleteUnsentTranscript()).replace(/\s+/g, ' ').trim();
  const typed = String(typedText || '').replace(/\r/g, '').trim();
  const text = typed || spoken;
  const source = inputSource || (typed ? (manualPromptContainsCapture ? `screen-capture-${manualPromptTaskType}` : 'typed') : 'system-audio');

  if (!text || text.length < 2) {
    feedback('Nothing to send.', true);
    return false;
  }

  if (!typed && !auto) manualCommitGuard = { text, at: Date.now() };
  const reuseAutoTurn = !!(auto && lastSendWasAuto && activeAnswerTurn?.auto && activeAutoLineIndex >= 0 && !hasVisibleActiveAnswer());

  if (typed && !regenerate) {
    utteranceParts = [];
    markPendingTranscriptSent();
    clearTimeout(llmTimer);
    lastSendWasAuto = false;
    lastAutoSentText = '';
    lastAutoSentAt = 0;
    activeAutoLineIndex = -1;
    clearTimeout(autoFinalizeTimer);
    manualPrompt.value = '';
    manualPromptContainsCapture = false;
    manualPromptTaskType = 'other';
    capturedScreenCount = 0;
  } else if (!regenerate) {
    utteranceParts = [];
    if (!auto) markPendingTranscriptSent();
  }

  if (auto) {
    lastAutoSentText = text;
    lastAutoSentAt = Date.now();
    lastSendWasAuto = true;
    if (activeAutoLineIndex < 0) activeAutoLineIndex = finalLines.findIndex(item => !item.sent);
    if (activeAutoLineIndex >= 0 && finalLines[activeAutoLineIndex]) {
      finalLines[activeAutoLineIndex].sent = true;
      renderTranscript({ followLatest: false });
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
  streamedAnswerText = '';
  pendingRenderDelta = '';
  renderFramePending = false;

  startOrRefreshAnswerTurn({ requestId, question: text, auto, reuseAuto: reuseAutoTurn });
  if (!regenerate) lastSubmittedPrompt = { text, inputSource: source };
  if (reanswerBtn) reanswerBtn.disabled = true;

  // Visual latency indicators reset
  if (fastPathIndicator) fastPathIndicator.classList.add('hidden');
  if (latencyMetric) latencyMetric.textContent = '...';

  modelLabel.textContent = '';
  feedback(regenerate ? 'Re-answering…' : (auto ? 'Auto sent' : 'Sent'));

  // Submit request with Provider Tier & Speed selections
  const currentProviderTier = providerTierSelect ? providerTierSelect.value : 'cerebras-fast';
  window.electronAPI.startLLMStream({ 
    requestId, 
    text, 
    inputSource: source, 
    licenseEmail: effectiveEmail(), 
    clientSentAt: Date.now(), 
    regenerate,
    providerTier: currentProviderTier
  });
  return true;
}

let prefetchTimer = null;
let lastPrefetchedQuestion = '';
function prefetchQuestionEvidence(text, delayMs = 0) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 8 || clean === lastPrefetchedQuestion) return;
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    lastPrefetchedQuestion = clean;
    const currentProviderTier = providerTierSelect ? providerTierSelect.value : 'cerebras-fast';
    window.electronAPI.prefetchLLMQuery?.({ text: clean, licenseEmail: effectiveEmail(), providerTier: currentProviderTier });
  }, Math.max(0, delayMs));
}

function scheduleLLM() {
  clearTimeout(llmTimer);
  if (!autoSend || !getCompleteUnsentTranscript()) return;
  const wait = Math.max(0, AUTO_SEND_QUIET_MS - (Date.now() - lastTranscriptAt));
  llmTimer = setTimeout(() => {
    const remaining = AUTO_SEND_QUIET_MS - (Date.now() - lastTranscriptAt);
    if (remaining > 0) return scheduleLLM();
    if (activeStreamRequestId && hasVisibleActiveAnswer()) {
      llmTimer = setTimeout(scheduleLLM, 120);
      return;
    }
    sendUtteranceToLLM({ auto: true });
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

function capturedPromptWithPendingSpeech(capturedText) {
  const captured = String(capturedText || '').trim();
  if (!manualPromptContainsCapture || !captured) return captured;
  const spoken = getCompleteUnsentTranscript();
  if (!spoken) return captured;
  return `${captured}\n\n--- SPOKEN QUESTION / FOLLOW-UP ---\n${spoken}`;
}

function sendManualOrPending() {
  const typed = manualPrompt.value.trim();
  if (typed) {
    const combined = capturedPromptWithPendingSpeech(typed);
    return sendUtteranceToLLM({ auto: false, typedText: combined, inputSource: manualPromptContainsCapture ? `screen-capture-${manualPromptTaskType}` : 'typed' });
  }
  clearTimeout(manualSendTimer);
  if (!manualSendStartedAt) manualSendStartedAt = Date.now();
  const run = () => {
    const quietFor = Date.now() - lastTranscriptAt;
    const waited = Date.now() - manualSendStartedAt;
    if (lastTranscriptAt && quietFor < MANUAL_SEND_QUIET_MS && waited < MANUAL_SEND_MAX_WAIT_MS) {
      manualSendTimer = setTimeout(run, Math.min(MANUAL_SEND_QUIET_MS - quietFor, 80)); return;
    }
    manualSendStartedAt = 0;
    const recent = getCompleteUnsentTranscript();
    if (recent) sendUtteranceToLLM({ auto: false, replacementText: recent, inputSource: 'system-audio' });
    else feedback('Nothing to send.', true);
  };
  run();
  return true;
}

async function copyRecentAndSend() {
  const typed = manualPrompt.value.trim();
  if (typed) {
    const combined = capturedPromptWithPendingSpeech(typed);
    const copied = await window.electronAPI.copyToClipboard(combined).catch(() => ({ success: false }));
    if (!copied?.success) feedback('Could not copy prompt to clipboard.', true);
    return sendUtteranceToLLM({ auto: false, typedText: combined, inputSource: manualPromptContainsCapture ? `screen-capture-${manualPromptTaskType}` : 'typed' });
  }
  clearTimeout(manualSendTimer);
  if (!manualSendStartedAt) manualSendStartedAt = Date.now();
  const run = async () => {
    const quietFor = Date.now() - lastTranscriptAt;
    const waited = Date.now() - manualSendStartedAt;
    if (lastTranscriptAt && quietFor < MANUAL_SEND_QUIET_MS && waited < MANUAL_SEND_MAX_WAIT_MS) {
      manualSendTimer = setTimeout(run, Math.min(MANUAL_SEND_QUIET_MS - quietFor, 80)); return;
    }
    manualSendStartedAt = 0;
    const recent = getCompleteUnsentTranscript();
    if (!recent) { feedback('Nothing to send.', true); return; }
    const copied = await window.electronAPI.copyToClipboard(recent).catch(() => ({ success: false }));
    if (!copied?.success) feedback('Could not copy prompt to clipboard.', true);
    sendUtteranceToLLM({ auto: false, replacementText: recent, inputSource: 'system-audio' });
  };
  run();
  return true;
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
    const shot = await window.electronAPI.captureCurrentWindow();
    if (!shot?.success || !shot.imageDataUrl) {
      feedback(shot?.error || 'Screen capture failed.', true);
      modelLabel.textContent = '';
      return;
    }
    modelLabel.textContent = `Reading screen… · capture ${shot.captureMs || 0}ms`;
    const extracted = await window.electronAPI.extractScreenText({
      imageDataUrl: shot.imageDataUrl,
      captureSource: shot.sourceName || '',
      licenseEmail: effectiveEmail()
    });
    if (!extracted?.success || !String(extracted.text || '').trim()) {
      feedback(extracted?.error || 'No useful text found on screen.', true);
      modelLabel.textContent = '';
      return;
    }
    const block = String(extracted.text).trim();
    const existing = manualPrompt.value.trim();
    capturedScreenCount += 1;
    const captureBlock = `--- SCREEN CAPTURE ${capturedScreenCount} ---\n${block}`;
    manualPrompt.value = existing ? `${existing}\n\n${captureBlock}` : captureBlock;
    manualPromptContainsCapture = true;
    if (['code', 'diagram'].includes(extracted.taskType)) manualPromptTaskType = extracted.taskType;
    manualPrompt.classList.remove('hidden');
    manualPrompt.scrollTop = manualPrompt.scrollHeight;
    modelLabel.textContent = `Screen added · ${extracted.captureMs || 0}ms`;
    prefetchQuestionEvidence(manualPrompt.value, 0);
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
if (reanswerBtn) reanswerBtn.onclick = () => {
  if (!lastSubmittedPrompt?.text) return feedback('No previous question to re-answer.', true);
  sendUtteranceToLLM({
    auto: false,
    typedText: lastSubmittedPrompt.text,
    inputSource: lastSubmittedPrompt.inputSource || 'typed',
    regenerate: true
  });
};

manualPrompt.addEventListener('input', () => {
  if (!manualPrompt.value.trim()) {
    manualPromptContainsCapture = false;
    manualPromptTaskType = 'other';
    capturedScreenCount = 0;
  }
});
manualPrompt.addEventListener('input', () => { if (!autoSend) prefetchQuestionEvidence(manualPrompt.value, 320); });

sendBtn.onclick = sendManualOrPending;

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey || e.repeat) return;
  if (e.ctrlKey) {
    e.preventDefault();
    e.stopPropagation();
    copyRecentAndSend();
    return;
  }
  if (!autoSend || manualPrompt.value.trim()) {
    e.preventDefault();
    e.stopPropagation();
    sendManualOrPending();
  }
}, true);
renderAutoSend();

// Handles LLM streaming, token metrics, fast path indicators, and dynamic budgets
window.electronAPI.onLLMStream(msg => {
  if (!msg || msg.requestId !== activeStreamRequestId) return;

  if (msg.type === 'delta') {
    if (!streamHasText) {
      streamedAnswerText = '';
      streamHasText = true;
      if (activeAnswerTurn?.responseElement) activeAnswerTurn.responseElement.textContent = '';
      scrollTurnToTop(activeAnswerTurn);
    }
    queuePlainAnswerDelta(msg.delta || '');
  } else if (msg.type === 'replace') {
    flushPendingAnswerDelta();
    if (!hasVisibleActiveAnswer()) {
      streamHasText = true;
      renderPlainAnswer(msg.text || 'No answer returned.');
    }
  } else if (msg.type === 'meta') {
    // Update Latency Metric
    if (msg.latency?.firstTokenMs) {
      if (latencyMetric) latencyMetric.textContent = `${msg.latency.firstTokenMs}ms`;
    }

    // Update Fast Path Indicator
    if (fastPathIndicator) {
      if (msg.fastPath || msg.retrievalMode === 'lexical') {
        fastPathIndicator.classList.remove('hidden');
      } else {
        fastPathIndicator.classList.add('hidden');
      }
    }

    // Update Token Budget Allocation Label
    if (tokenBudgetLabel && msg.tokenBudget) {
      tokenBudgetLabel.textContent = `Budget: ${msg.tokenBudget}t`;
    }

    // Update Answer Mode Badge
    if (answerModeBadge && msg.answerMode) {
      answerModeBadge.textContent = msg.answerMode;
    }

    if (msg.phase === 'retrieval') {
      const bits = [];
      if (msg.retrievalMode) bits.push(msg.retrievalMode);
      if (Number.isFinite(msg.embeddingMs)) bits.push(`embed ${msg.embeddingMs}ms`);
      if (Number.isFinite(msg.retrievalMs)) bits.push(`search ${msg.retrievalMs}ms`);
      modelLabel.textContent = bits.join(' · ') || msg.model || '';
    } else if (msg.phase === 'hybrid-upgrade') {
      modelLabel.textContent = msg.status === 'sol-finalizing' ? 'instant answer · upgrading to Sol…' : 'Cerebras instant · Sol quality running…';
    } else if (msg.phase === 'retry') {
      modelLabel.textContent = 'provider retry…';
    } else if (msg.phase === 'format-retry') {
      modelLabel.textContent = 'completing required format…';
    } else if (msg.phase === 'complete' && msg.latency) {
      const first = msg.latency.firstTokenMs;
      modelLabel.textContent = `${msg.model || ''}${Number.isFinite(first) ? ` · first ${first}ms` : ''}`.trim();
      if (latencyMetric) latencyMetric.textContent = `${first || msg.latency.totalMs || 0}ms`;
    }
  } else if (msg.type === 'done') {
    flushPendingAnswerDelta();
    if (!streamedAnswerText && !String(activeAnswerTurn?.answer || '').trim()) {
      renderPlainAnswer(msg.answer || 'No answer returned.');
    } else if (activeAnswerTurn) {
      activeAnswerTurn.answer = streamedAnswerText || activeAnswerTurn.answer;
    }
    if (msg.model) {
      const first = msg.latency?.firstTokenMs;
      modelLabel.textContent = `${msg.model}${Number.isFinite(first) ? ` · first ${first}ms` : ''}`;
      if (latencyMetric) latencyMetric.textContent = `${first || msg.latency?.totalMs || 0}ms`;
    }
    if (activeAnswerTurn && activeAnswerTurn.requestId === msg.requestId) activeAnswerTurn.answeredAt = Date.now();
    ensureCurrentTurnReadingSlot(activeAnswerTurn);
    activeStreamRequestId = null;
    if (reanswerBtn) reanswerBtn.disabled = !lastSubmittedPrompt?.text;
  } else if (msg.type === 'error') {
    const errorText = `LLM error: ${msg.error || 'Request failed'}`;
    streamedAnswerText = errorText;
    if (activeAnswerTurn?.responseElement) {
      activeAnswerTurn.answer = errorText;
      activeAnswerTurn.answeredAt = Date.now();
      activeAnswerTurn.responseElement.textContent = errorText;
    } else answerEl.textContent = errorText;
    modelLabel.textContent = '';
    ensureCurrentTurnReadingSlot(activeAnswerTurn);
    activeStreamRequestId = null;
    if (reanswerBtn) reanswerBtn.disabled = !lastSubmittedPrompt?.text;
  }
});

window.electronAPI.onStatus(msg => statusEl.textContent = msg);
window.electronAPI.onSpeechStart(() => { statusEl.textContent = 'Speech detected from Windows system audio...'; });
window.electronAPI.onCredits(updateCredits);

window.electronAPI.onTranscript(({ text, isFinal, phoneticCorrected = false }) => {
  if (!text) return;
  const clean = stripCommittedOverlap(text);
  if (!clean) {
    if (!isFinal) interimText = '';
    renderTranscript({ followLatest: false });
    return;
  }

  // Display STT Phonetic Cleanup Notification if correction occurred
  if (sttCorrectionNotice) {
    sttCorrectionNotice.style.display = phoneticCorrected ? 'inline-block' : 'none';
  }

  lastTranscriptAt = Date.now();
  if (isFinal) {
    const now = Date.now();
    const withinMergeWindow = lastSendWasAuto && lastAutoSentText && (now - lastAutoSentAt) <= AUTO_MERGE_WINDOW_MS;
    const shouldMerge = autoSend && withinMergeWindow && !hasVisibleActiveAnswer();

    if (shouldMerge) {
      const combined = mergeTranscriptText(lastAutoSentText, clean);
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
      prefetchQuestionEvidence(combined, 0);
      llmTimer = setTimeout(() => sendUtteranceToLLM({ auto: true, replacementText: combined }), AUTO_SEND_QUIET_MS);
    } else {
      if (lastSendWasAuto && activeAutoLineIndex >= 0 && finalLines[activeAutoLineIndex]) {
        finalLines[activeAutoLineIndex].sent = true;
      }
      activeAutoLineIndex = -1;
      lastSendWasAuto = false;
      lastAutoSentText = '';
      lastAutoSentAt = 0;
      
      const pendingIndex = finalLines.findIndex(item => !item.sent);
      if (pendingIndex >= 0) {
        finalLines[pendingIndex].text = mergeTranscriptText(finalLines[pendingIndex].text, clean);
      } else {
        finalLines.push({ text: clean, sent: false });
      }
      if (finalLines.length > MAX_LINES) finalLines = finalLines.slice(-MAX_LINES);
      utteranceParts.push(clean);
      lastTranscriptAt = now;
      lastFinalAt = now;
      prefetchQuestionEvidence(getCompleteUnsentTranscript(), 0);
      scheduleLLM();
    }
    interimText = '';
  } else {
    interimText = clean;
  }
  renderTranscript();
});