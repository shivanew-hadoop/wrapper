const $ = id => document.getElementById(id);
const appEl = $('app');
const privateCursor = $('privateCursor');
let privateCursorHotspot={x:0,y:0};

window.electronAPI.onPrivateCursorVisual(data => {
  if (!privateCursor||!data?.dataUrl) return;
  privateCursor.style.width=`${Number(data.width)||24}px`;
  privateCursor.style.height=`${Number(data.height)||32}px`;
  privateCursor.style.backgroundImage=`url("${data.dataUrl}")`;
  privateCursorHotspot={x:Number(data.hotspotX)||0,y:Number(data.hotspotY)||0};
});

// Main-process screen-coordinate polling continues across draggable header and
// native frame areas where Chromium mousemove events are intentionally absent.
window.electronAPI.onPrivateCursorPosition(data => {
  if (!privateCursor || !data?.visible) { privateCursor?.classList.remove('visible');return; }
  privateCursor.style.transform=`translate3d(${(Number(data.x)||0)-privateCursorHotspot.x}px,${(Number(data.y)||0)-privateCursorHotspot.y}px,0)`;
  privateCursor.classList.add('visible');
});
document.addEventListener('mousedown', () => privateCursor?.classList.add('pressed'), true);
document.addEventListener('mouseup', () => privateCursor?.classList.remove('pressed'), true);
// Disable browser/native title popups throughout the overlay.
document.querySelectorAll('[title]').forEach(element => element.removeAttribute('title'));
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
let pendingRenderDelta = '';
let renderFramePending = false;
let streamRenderState = null;
let lastSubmittedPrompt = null; // {text,inputSource} for explicit Re-answer
let pendingUserSendStartedAt = 0;
let activeLatencyTrace = null;
let lastLatencyTraceText = '';

function fmtMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : '-';
}
function fmtSec(value) {
  return Number.isFinite(value) ? `${(value/1000).toFixed(value >= 10000 ? 1 : 2)}s` : '-';
}
function buildLatencyTraceText(trace, msg={}) {
  const t = msg.transportTiming || trace?.transportTiming || {};
  const b = msg.latency || trace?.backendLatency || {};
  const clickAt = Number(trace?.clickAt || 0);
  const sentAt = Number(trace?.ipcSentAt || 0);
  const firstDeltaAt = Number(trace?.firstRendererDeltaAt || 0);
  const firstPaintAt = Number(trace?.firstPaintAt || 0);
  const doneAt = Number(trace?.doneAt || 0);
  const clickToSend = clickAt && sentAt ? sentAt - clickAt : null;
  const clickToDelta = clickAt && firstDeltaAt ? firstDeltaAt - clickAt : null;
  const clickToPaint = clickAt && firstPaintAt ? firstPaintAt - clickAt : null;
  const clickToDone = clickAt && doneAt ? doneAt - clickAt : null;
  const paintToDone = firstPaintAt && doneAt ? doneAt - firstPaintAt : null;
  return [
    'TOPPER LATENCY TRACE',
    `requestId: ${trace?.requestId || '-'}`,
    `provider/model: ${msg.model || trace?.model || '-'}`,
    `inputSource: ${trace?.inputSource || '-'}`,
    '',
    `01 user action -> IPC send: ${fmtMs(clickToSend)}`,
    `02 IPC send -> Electron main receive: ${fmtMs(t.mainIpcAfterClientSendMs)}`,
    `03 Electron main -> backend fetch start: ${fmtMs(t.mainFetchStartAfterIpcMs)}`,
    `04 backend fetch -> SSE headers: ${fmtMs(t.backendHeadersAfterFetchMs)}`,
    `05 backend fetch -> first SSE byte: ${fmtMs(t.firstBackendByteAfterFetchMs)}`,
    `06 client send -> backend prepare start (clock-based): ${fmtMs(b.clientToBackendMs)}`,
    `07 backend handler -> prepare start: ${fmtMs(b.backendHandlerToPrepareStartMs)}`,
    `08 backend prompt ready: ${fmtMs(b.promptReadyMs)}`,
    `   intent: ${fmtMs(b.intentMs)} | retrieval decision: ${fmtMs(b.retrievalDecisionMs)} | embedding: ${fmtMs(b.embeddingMs)} | retrieval: ${fmtMs(b.retrievalMs)} | prompt build: ${fmtMs(b.promptBuildMs)}`,
    `   retrieval mode: ${b.retrievalMode || '-'} | embedding cache: ${b.embeddingCacheHit === true ? 'hit' : b.embeddingCacheHit === false ? 'miss' : '-'} | retrieval cache: ${b.retrievalCacheHit === true ? 'hit' : b.retrievalCacheHit === false ? 'miss' : '-'}`,
    `   prompt size: ${Number.isFinite(b.promptChars) ? b.promptChars : '-'} chars / ~${Number.isFinite(b.promptTokenEstimate) ? b.promptTokenEstimate : '-'} tokens`,
    `09 backend prepare start -> provider request: ${fmtMs(b.providerRequestAtMs)}`,
    `10 provider request -> response headers: ${fmtMs(b.providerHeadersMs)}`,
    `11 provider request -> first text delta: ${fmtMs(b.firstProviderDeltaAfterRequestMs)}`,
    `12 provider generation after first delta: ${fmtMs(b.providerGenerationAfterFirstDeltaMs)}`,
    `13 backend first delta write from prepare start: ${fmtMs(b.firstBackendDeltaWriteMs)}`,
    `14 backend post-processing after provider stream: ${fmtMs(b.backendPostProcessMs)}`,
    `15 backend fetch -> first delta seen by Electron: ${fmtMs(t.firstBackendDeltaAfterFetchMs)}`,
    `16 user action -> first renderer delta: ${fmtMs(clickToDelta)}`,
    `17 user action -> first painted answer: ${fmtMs(clickToPaint)}`,
    `18 first painted answer -> completed answer: ${fmtMs(paintToDone)}`,
    `19 user action -> completed answer: ${fmtMs(clickToDone)}`,
    `20 backend LLM section total: ${fmtMs(b.llmMs)}`,
    `21 backend internal total: ${fmtMs(b.totalMs)}`,
    `22 Electron backend fetch -> done event: ${fmtMs(t.backendDoneAfterFetchMs)}`,
    `attempts: ${Number.isFinite(b.attempts) ? b.attempts : '-'}`
  ].join('\n');
}
function updateLatencyLabel(trace, msg={}) {
  if (!trace) return;
  if (msg.transportTiming) trace.transportTiming = msg.transportTiming;
  if (msg.latency) trace.backendLatency = msg.latency;
  if (msg.model) trace.model = msg.model;
  const b = trace.backendLatency || {};
  const clickAt = Number(trace.clickAt || 0);
  const paintMs = clickAt && trace.firstPaintAt ? trace.firstPaintAt - clickAt : null;
  const doneMs = clickAt && trace.doneAt ? trace.doneAt - clickAt : null;
  const parts = [trace.model || 'LLM'];
  if (Number.isFinite(paintMs)) parts.push(`click→paint ${fmtSec(paintMs)}`);
  if (Number.isFinite(b.promptReadyMs)) parts.push(`prep ${fmtSec(b.promptReadyMs)}`);
  if (Number.isFinite(b.firstProviderDeltaAfterRequestMs)) parts.push(`provider→1st ${fmtSec(b.firstProviderDeltaAfterRequestMs)}`);
  if (Number.isFinite(b.providerGenerationAfterFirstDeltaMs)) parts.push(`gen ${fmtSec(b.providerGenerationAfterFirstDeltaMs)}`);
  if (Number.isFinite(doneMs)) parts.push(`total ${fmtSec(doneMs)}`);
  modelLabel.textContent = parts.join(' · ');
  modelLabel.style.cursor = 'copy';
  modelLabel.style.userSelect = 'text';
  lastLatencyTraceText = buildLatencyTraceText(trace, msg);
}
modelLabel.addEventListener('click', async () => {
  if (!lastLatencyTraceText) return;
  const copied = await window.electronAPI.copyToClipboard(lastLatencyTraceText).catch(()=>({success:false}));
  feedback(copied?.success ? 'Latency trace copied.' : 'Could not copy latency trace.', !copied?.success);
});

function normalizedCodeLanguage(value) {
  const raw=String(value||'').trim().toLowerCase().replace(/[^a-z0-9+#.-]/g,'');
  const aliases={js:'javascript',javascript:'javascript',node:'javascript',nodejs:'javascript',jsx:'javascript',ts:'typescript',typescript:'typescript',tsx:'typescript',py:'python',python:'python',java:'java',golang:'go',go:'go',sql:'sql',postgres:'sql',postgresql:'sql',mysql:'sql',sh:'bash',shell:'bash',bash:'bash',cs:'csharp','c#':'csharp',cpp:'cpp','c++':'cpp',json:'json',yaml:'yaml',yml:'yaml',html:'html',css:'css'};
  return aliases[raw]||raw||'code';
}
function codeLanguageLabel(language) {
  const labels={javascript:'JavaScript',typescript:'TypeScript',python:'Python',java:'Java',go:'Go',sql:'SQL',bash:'Bash',csharp:'C#',cpp:'C++',json:'JSON',yaml:'YAML',html:'HTML',css:'CSS',code:'Code'};
  return labels[language]||language.toUpperCase();
}
function codeTokenClass(token, language) {
  if(/^\s*(?:\/\/|#)/.test(token)||/^\/\*/.test(token))return 'codeComment';
  if(/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)$/.test(token))return 'codeString';
  if(/^\d/.test(token))return 'codeNumber';
  const keywordSets={
    javascript:new Set('const let var function return if else for while do switch case break continue class extends new async await try catch finally throw import from export default true false null undefined typeof instanceof this'.split(' ')),
    typescript:new Set('const let var function return if else for while do switch case break continue class extends implements interface type enum new async await try catch finally throw import from export default true false null undefined public private protected readonly abstract this'.split(' ')),
    java:new Set('public private protected class interface extends implements static final void int long double float boolean char byte short new return if else for while do switch case break continue try catch finally throw throws true false null this super package import'.split(' ')),
    go:new Set('package import func return if else for range switch case break continue go defer select chan map struct interface var const type true false nil'.split(' ')),
    python:new Set('def return if elif else for while in is not and or class import from as try except finally raise with lambda True False None async await yield pass break continue'.split(' ')),
    sql:new Set('select from where join inner left right full on group by order having insert update delete into values create alter drop table view index and or not null as distinct union all case when then else end limit offset'.split(' '))
  };
  const set=keywordSets[language];
  if(set&&set.has(token.toLowerCase()))return 'codeKeyword';
  return '';
}
function appendHighlightedCodeLine(codeEl, line, language) {
  const tokenRe=/(\/\/.*$|#.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/gm;
  let last=0;
  for(const match of line.matchAll(tokenRe)){
    const index=match.index||0;
    if(index>last)codeEl.appendChild(document.createTextNode(line.slice(last,index)));
    const token=match[0];
    const cls=codeTokenClass(token,language);
    if(cls){const span=document.createElement('span');span.className=cls;span.textContent=token;codeEl.appendChild(span);}
    else codeEl.appendChild(document.createTextNode(token));
    last=index+token.length;
  }
  if(last<line.length)codeEl.appendChild(document.createTextNode(line.slice(last)));
}
function resetStreamingRenderer(target) {
  streamRenderState={target,inCode:false,lineStart:true,lineProbe:'',codeLineBuffer:'',codeEl:null,language:'code'};
}
function openStreamingCodeBlock(state, languageRaw) {
  const language=normalizedCodeLanguage(languageRaw);
  const pre=document.createElement('pre');
  pre.className='answerCodeBlock';
  pre.dataset.language=codeLanguageLabel(language);
  const code=document.createElement('code');
  code.className=`answerCode language-${language}`;
  pre.appendChild(code);
  state.target.appendChild(pre);
  state.inCode=true;
  state.codeEl=code;
  state.language=language;
  state.codeLineBuffer='';
  state.lineStart=true;
  state.lineProbe='';
}
function appendProseNode(state, text) {
  if(!text)return;
  // Spoken answers are requested as plain text. Remove only Markdown emphasis markers;
  // the actual words are appended once and are never rebuilt later.
  state.target.appendChild(document.createTextNode(String(text).replace(/\*\*/g,'')));
}
function consumeStreamingAnswerChunk(chunk) {
  const state=streamRenderState;
  if(!state?.target)return;
  const text=String(chunk||'');
  let i=0;
  while(i<text.length){
    if(state.inCode){
      const nl=text.indexOf('\n',i);
      if(nl<0){state.codeLineBuffer+=text.slice(i);break;}
      state.codeLineBuffer+=text.slice(i,nl);
      if(/^\s*```\s*$/.test(state.codeLineBuffer)){
        state.inCode=false;state.codeEl=null;state.language='code';state.codeLineBuffer='';state.lineStart=true;state.lineProbe='';
      }else{
        appendHighlightedCodeLine(state.codeEl,state.codeLineBuffer,state.language);
        state.codeEl.appendChild(document.createTextNode('\n'));
        state.codeLineBuffer='';
      }
      i=nl+1;
      continue;
    }

    if(state.lineStart){
      const ch=text[i++];
      state.lineProbe+=ch;
      if(ch==='\n'){
        const probe=state.lineProbe.slice(0,-1);
        const fence=probe.match(/^\s*```\s*([A-Za-z0-9_+#.-]*)\s*$/);
        if(fence)openStreamingCodeBlock(state,fence[1]||'code');
        else appendProseNode(state,state.lineProbe);
        state.lineProbe='';
        state.lineStart=true;
        continue;
      }
      const trimmed=state.lineProbe.trimStart();
      if(trimmed.length<=3 && /^`{1,3}$/.test(trimmed))continue;
      if(/^```/.test(trimmed))continue; // hold the fence/lang line until its newline
      appendProseNode(state,state.lineProbe);
      state.lineProbe='';
      state.lineStart=false;
      continue;
    }

    const nl=text.indexOf('\n',i);
    if(nl<0){appendProseNode(state,text.slice(i));break;}
    appendProseNode(state,text.slice(i,nl+1));
    i=nl+1;
    state.lineStart=true;
    state.lineProbe='';
  }
}
function finalizeStreamingRenderer() {
  const state=streamRenderState;
  if(!state?.target)return;
  if(state.inCode&&state.codeLineBuffer){
    if(!/^\s*```\s*$/.test(state.codeLineBuffer))appendHighlightedCodeLine(state.codeEl,state.codeLineBuffer,state.language);
    state.codeLineBuffer='';
  }else if(!state.inCode&&state.lineProbe){
    const fence=state.lineProbe.match(/^\s*```\s*([A-Za-z0-9_+#.-]*)\s*$/);
    if(!fence)appendProseNode(state,state.lineProbe);
    state.lineProbe='';
  }
}
function flushPendingAnswerDelta() {
  renderFramePending = false;
  if (!pendingRenderDelta) return;
  const delta = pendingRenderDelta;
  pendingRenderDelta = '';
  streamedAnswerText += delta;
  if (!streamRenderState?.target) resetStreamingRenderer(activeAnswerTurn?.responseElement || answerEl);
  consumeStreamingAnswerChunk(delta);
  if (activeAnswerTurn) {
    activeAnswerTurn.answer = cleanStoredAnswer(streamedAnswerText);
    ensureCurrentTurnReadingSlot(activeAnswerTurn);
  }
  if (activeLatencyTrace && !activeLatencyTrace.firstPaintAt && !activeLatencyTrace.paintProbePending) {
    activeLatencyTrace.paintProbePending = true;
    requestAnimationFrame(() => {
      if (!activeLatencyTrace || activeLatencyTrace.firstPaintAt) return;
      activeLatencyTrace.firstPaintAt = Date.now();
      activeLatencyTrace.paintProbePending = false;
      updateLatencyLabel(activeLatencyTrace);
    });
  }
}
function queuePlainAnswerDelta(delta) {
  const text = String(delta || '');
  if (!text) return;
  pendingRenderDelta += text;
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
let manualCommitGuard = { text:'', at:0 };

let interviewStartedAt = null;
let sessionTurns = []; // completed/in-progress Q&A retained only in renderer memory until Stop/End Session
let activeAnswerTurn = null;

function formatTurnTime(ms) {
  const d = new Date(Number(ms) || Date.now());
  return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}

function clearCurrentTurnReadingSlot(turn = activeAnswerTurn) {
  if (!turn?.element) return;
  turn.element.classList.remove('currentReadingTurn');
  turn.element.style.minHeight = '';
}

function ensureCurrentTurnReadingSlot(turn) {
  if (!turn?.element || !turn.element.isConnected) return;
  // Keep the newest turn at least one answer-viewport tall. This gives a short
  // answer a stable reading position at the top without adding a scrollable tail
  // after the response. When the next question starts, this reservation is removed
  // from the previous turn so chronological history remains compact.
  turn.element.classList.add('currentReadingTurn');
  turn.element.style.minHeight = `${Math.max(1, answerEl.clientHeight)}px`;
}

function scrollTurnToTop(turn) {
  if (!turn?.element) return;
  ensureCurrentTurnReadingSlot(turn);

  // History stays chronological. Only the viewport is positioned at the newest
  // turn. No token/delta handler changes scrollTop after this initial positioning.
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

  // Do not duplicate the interviewer prompt in the answer pane. The prompt remains
  // in renderer memory only for end-session history/PDF persistence.
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

function startOrRefreshAnswerTurn({ requestId, question, auto=false, reuseAuto=false }) {
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
    // Auto-send continuation replaces only the same still-forming logical question.
    scrollTurnToTop(activeAnswerTurn);
    return activeAnswerTurn;
  }
  const turn = {
    id:`turn-${Date.now()}-${sessionTurns.length+1}`,
    requestId,
    question:cleanQuestion,
    answer:'',
    askedAt:Date.now(),
    answeredAt:null,
    auto:!!auto,
    element:null,
    responseElement:null
  };
  const previousTurn = activeAnswerTurn;
  sessionTurns.push(turn);
  activeAnswerTurn = turn;
  if (answerEl.querySelector('.answerPlaceholder')) answerEl.textContent = '';
  // Preserve normal chronological history: oldest answer stays at the top and the
  // newest answer is appended at the bottom. The viewport alone is moved to the new
  // turn so the user can read its first line immediately.
  clearCurrentTurnReadingSlot(previousTurn);
  answerEl.appendChild(buildTurnElement(turn));
  scrollTurnToTop(turn);
  return turn;
}

function cleanStoredAnswer(text) {
  return String(text || '')
    // Grounding tags are internal metadata and are never part of the candidate answer.
    .replace(/⟦(?:Resume|JD)\s*·\s*[^⟧]+⟧/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function renderPlainAnswer(text) {
  streamedAnswerText = String(text || '');
  const target=activeAnswerTurn?.responseElement || answerEl;
  target.textContent='';
  resetStreamingRenderer(target);
  consumeStreamingAnswerChunk(streamedAnswerText);
  finalizeStreamingRenderer();
  if (activeAnswerTurn) activeAnswerTurn.answer = cleanStoredAnswer(streamedAnswerText);
}

function appendPlainAnswerDelta(delta) {
  queuePlainAnswerDelta(delta);
}

function serializableSessionTurns() {
  return sessionTurns
    .filter(turn => String(turn.question || '').trim() && String(turn.answer || '').trim())
    .map(turn => ({
      question:String(turn.question || '').trim(),
      answer:String(turn.answer || '').trim(),
      askedAt:Number(turn.askedAt) || Date.now(),
      answeredAt:Number(turn.answeredAt) || Number(turn.askedAt) || Date.now()
    }));
}

async function saveCompletedInterviewSession() {
  const turns = serializableSessionTurns();
  if (!turns.length || !interviewStartedAt) return { success:true, skipped:true };
  return window.electronAPI.saveInterviewTranscript({
    startedAt:interviewStartedAt,
    endedAt:Date.now(),
    turns
  }).catch(() => ({ success:false }));
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
  const pendingText = mergeTranscriptText(pendingBase,interimText);
  if (pendingText) {
    const pending = document.createElement('div');
    pending.className = `transcriptQuestion pendingQuestion${interimText ? ' interimQuestion' : ''}`;
    pending.textContent = pendingText;
    transcriptEl.appendChild(pending);
  }
  if (followLatest) requestAnimationFrame(() => { transcriptEl.scrollTop = transcriptEl.scrollHeight; });
}
function markPendingTranscriptSent() {
  // Promote the visible interim tail into transcript history before clearing it.
  // This keeps the exact words sent by Send/Ctrl+Enter visible and prevents the
  // final line from remaining behind as a new unsent fragment.
  if (interimText) {
    const pendingIndex=finalLines.findIndex(item=>!item.sent);
    if (pendingIndex>=0) finalLines[pendingIndex].text=mergeTranscriptText(finalLines[pendingIndex].text,interimText);
    else finalLines.push({text:interimText,sent:false});
    interimText='';
  }
  finalLines.forEach(item => { if (!item.sent) item.sent = true; });
  renderTranscript();
}

function getCompleteUnsentTranscript() {
  // finalLines is the UI/source-of-truth for everything Deepgram has finalized since
  // the last send. Include the current interim tail so Send/Ctrl+Enter cannot lose
  // words that are already visible in Live Questions but not yet speech_final.
  const finalized = finalLines.filter(item => !item.sent).map(item => item.text).join(' ');
  const visible = mergeTranscriptText(finalized,interimText);
  if (visible) return visible;
  // Fallback for an edge case where a finalized chunk reached the utterance buffer
  // before the transcript row was painted.
  return utteranceParts.join(' ').replace(/\s+/g, ' ').trim();
}

function comparableWords(text) {
  return String(text||'').trim().split(/\s+/).filter(Boolean).map(word=>word.toLowerCase().replace(/^[^a-z0-9+#]+|[^a-z0-9+#]+$/gi,'')).filter(Boolean);
}

function mergeTranscriptText(base,tail) {
  const left=String(base||'').replace(/\s+/g,' ').trim();
  const right=String(tail||'').replace(/\s+/g,' ').trim();
  if(!left)return right;
  if(!right)return left;
  const leftOriginal=left.split(/\s+/),rightOriginal=right.split(/\s+/);
  const leftWords=comparableWords(left),rightWords=comparableWords(right);
  const maximum=Math.min(80,leftWords.length,rightWords.length);
  for(let count=maximum;count>=2;count--){
    if(leftWords.slice(-count).join(' ')===rightWords.slice(0,count).join(' ')){
      return [...leftOriginal,...rightOriginal.slice(count)].join(' ').trim();
    }
  }
  return `${left} ${right}`.trim();
}

function stripCommittedOverlap(incoming) {
  const raw=String(incoming||'').trim();
  if (!raw||!manualCommitGuard.text||Date.now()-manualCommitGuard.at>MANUAL_COMMIT_DEDUPE_MS) return raw;
  const committed=comparableWords(manualCommitGuard.text);
  const incomingOriginal=raw.split(/\s+/).filter(Boolean);
  const incomingComparable=comparableWords(raw);
  if (!committed.length||!incomingComparable.length) return raw;

  // Deepgram can emit a late final containing the same cumulative words that
  // were already visible and manually committed. Remove the longest exact
  // suffix/prefix overlap; keep only genuinely new words spoken after Enter.
  const maximum=Math.min(80,committed.length,incomingComparable.length);
  for(let count=maximum;count>=2;count--){
    const committedTail=committed.slice(-count).join(' ');
    const incomingHead=incomingComparable.slice(0,count).join(' ');
    if(committedTail===incomingHead)return incomingOriginal.slice(count).join(' ').trim();
  }
  // A short late interim can be fully contained at the committed tail.
  if(incomingComparable.length>=2&&committed.slice(-incomingComparable.length).join(' ')===incomingComparable.join(' '))return '';
  return raw;
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

function sendUtteranceToLLM({ auto = false, replacementText = '', typedText = '', inputSource = '', regenerate = false } = {}) {
  clearTimeout(llmTimer);
  clearTimeout(manualSendTimer);
  manualSendTimer=null;
  manualSendStartedAt=0;
  const spoken = (replacementText || getCompleteUnsentTranscript()).replace(/\s+/g, ' ').trim();
  // Preserve line breaks and code indentation from typed/captured prompts.
  const typed = String(typedText || '').replace(/\r/g,'').trim();
  const text = typed || spoken;
  const source=inputSource||(typed?(manualPromptContainsCapture?`screen-capture-${manualPromptTaskType}`:'typed'):'system-audio');

  if (!text || text.length < 2) {
    pendingUserSendStartedAt = 0;
    feedback('Nothing to send.', true);
    return false;
  }

  if (!typed&&!auto) manualCommitGuard={text,at:Date.now()};
  // Auto-send continuations regenerate the same logical question. Reuse the existing
  // visible turn instead of leaving a stale partial answer in history.
  const reuseAutoTurn = !!(auto && lastSendWasAuto && activeAnswerTurn?.auto && activeAutoLineIndex >= 0 && !streamHasText);

  // A manually submitted prompt is authoritative for this turn. When it contains staged
  // screen captures, sendManualOrPending first appends the current unsent spoken question.
  // Once submitted, close that transcript question so it cannot auto-send again.
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
  const ipcSentAt = Date.now();
  const clickAt = pendingUserSendStartedAt || ipcSentAt;
  pendingUserSendStartedAt = 0;
  activeStreamRequestId = requestId;
  activeLatencyTrace = { requestId, clickAt, ipcSentAt, inputSource:source, firstRendererDeltaAt:null, firstPaintAt:null, doneAt:null, transportTiming:null, backendLatency:null, model:'' };
  lastLatencyTraceText = '';
  streamHasText = false;
  streamedAnswerText = '';
  pendingRenderDelta = '';
  renderFramePending = false;
  streamRenderState = null;
  // Re-answer is intentionally a NEW chronological turn. The prior answer stays intact
  // and the regenerated answer streams below it exactly like a newly asked question.
  startOrRefreshAnswerTurn({ requestId, question:text, auto, reuseAuto:reuseAutoTurn });
  if (!regenerate) lastSubmittedPrompt={text,inputSource:source};
  if (reanswerBtn) reanswerBtn.disabled=true;
  // Keep prior answers readable while the next request is being prepared. Re-answer
  // creates a separate turn, so no completed answer is overwritten. Do not insert a
  // local 'Thinking' state; the first provider delta is rendered immediately.
  modelLabel.textContent = '';
  feedback(regenerate ? 'Re-answering…' : (auto ? 'Auto sent' : 'Sent'));
  window.electronAPI.startLLMStream({ requestId, text, inputSource:source, licenseEmail:effectiveEmail(), clientSentAt:ipcSentAt, clientClickedAt:clickAt, regenerate });
  return true;
}

let prefetchTimer = null;
let lastPrefetchedQuestion = '';
function prefetchQuestionEvidence(text, delayMs=0) {
  const clean = String(text || '').replace(/\s+/g,' ').trim();
  if (clean.length < 8 || clean === lastPrefetchedQuestion) return;
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    lastPrefetchedQuestion = clean;
    window.electronAPI.prefetchLLMQuery?.({text:clean,licenseEmail:effectiveEmail()});
  }, Math.max(0, delayMs));
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
function capturedPromptWithPendingSpeech(capturedText) {
  const captured=String(capturedText||'').trim();
  if (!manualPromptContainsCapture || !captured) return captured;
  const spoken=getCompleteUnsentTranscript();
  if (!spoken) return captured;
  return `${captured}

--- SPOKEN QUESTION / FOLLOW-UP ---
${spoken}`;
}

function sendManualOrPending() {
  const typed = manualPrompt.value.trim();
  if (typed) {
    const combined=capturedPromptWithPendingSpeech(typed);
    return sendUtteranceToLLM({auto:false,typedText:combined,inputSource:manualPromptContainsCapture?`screen-capture-${manualPromptTaskType}`:'typed'});
  }
  clearTimeout(manualSendTimer);
  if (!manualSendStartedAt) manualSendStartedAt=Date.now();
  const run=()=>{
    const quietFor=Date.now()-lastTranscriptAt;
    const waited=Date.now()-manualSendStartedAt;
    if (lastTranscriptAt&&quietFor<MANUAL_SEND_QUIET_MS&&waited<MANUAL_SEND_MAX_WAIT_MS) {
      manualSendTimer=setTimeout(run,Math.min(MANUAL_SEND_QUIET_MS-quietFor,80));return;
    }
    manualSendStartedAt=0;
    const recent=getCompleteUnsentTranscript();
    if (recent) sendUtteranceToLLM({auto:false,replacementText:recent,inputSource:'system-audio'});
    else { pendingUserSendStartedAt = 0; feedback('Nothing to send.',true); }
  };
  run();
  return true;
}

async function copyRecentAndSend() {
  const typed=manualPrompt.value.trim();
  if (typed) {
    const combined=capturedPromptWithPendingSpeech(typed);
    const copied=await window.electronAPI.copyToClipboard(combined).catch(()=>({success:false}));
    if (!copied?.success) feedback('Could not copy prompt to clipboard.',true);
    return sendUtteranceToLLM({auto:false,typedText:combined,inputSource:manualPromptContainsCapture?`screen-capture-${manualPromptTaskType}`:'typed'});
  }
  clearTimeout(manualSendTimer);
  if (!manualSendStartedAt) manualSendStartedAt=Date.now();
  const run=async()=>{
    const quietFor=Date.now()-lastTranscriptAt;
    const waited=Date.now()-manualSendStartedAt;
    if (lastTranscriptAt&&quietFor<MANUAL_SEND_QUIET_MS&&waited<MANUAL_SEND_MAX_WAIT_MS) {
      manualSendTimer=setTimeout(run,Math.min(MANUAL_SEND_QUIET_MS-quietFor,80));return;
    }
    manualSendStartedAt=0;
    const recent=getCompleteUnsentTranscript();
    if (!recent) { pendingUserSendStartedAt = 0; feedback('Nothing to send.',true);return; }
    // Copy and send the same complete snapshot after the short transcript flush.
    const copied=await window.electronAPI.copyToClipboard(recent).catch(()=>({success:false}));
    if (!copied?.success) feedback('Could not copy prompt to clipboard.',true);
    sendUtteranceToLLM({auto:false,replacementText:recent,inputSource:'system-audio'});
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
    capturedScreenCount += 1;
    const captureBlock = `--- SCREEN CAPTURE ${capturedScreenCount} ---\n${block}`;
    manualPrompt.value = existing ? `${existing}\n\n${captureBlock}` : captureBlock;
    manualPromptContainsCapture = true;
    if(['code','diagram'].includes(extracted.taskType))manualPromptTaskType=extracted.taskType;
    // Captured text is deliberately staged, not auto-sent: repeated captures accumulate here.
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
  pendingUserSendStartedAt = Date.now();
  sendUtteranceToLLM({
    auto:false,
    typedText:lastSubmittedPrompt.text,
    inputSource:lastSubmittedPrompt.inputSource || 'typed',
    regenerate:true
  });
};
manualPrompt.addEventListener('input',()=>{if(!manualPrompt.value.trim()){manualPromptContainsCapture=false;manualPromptTaskType='other';capturedScreenCount=0}});
manualPrompt.addEventListener('input',()=>{ if(!autoSend) prefetchQuestionEvidence(manualPrompt.value, 320); });

sendBtn.onclick = () => { pendingUserSendStartedAt = Date.now(); sendManualOrPending(); };

// Keyboard shortcuts work at overlay level, not only when the text box already has focus.
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey || e.repeat) return;
  if (e.ctrlKey) {
    e.preventDefault();
    e.stopPropagation();
    pendingUserSendStartedAt = Date.now();
    copyRecentAndSend();
    return;
  }
  // Plain Enter is the Send key in manual mode.
  if (!autoSend || manualPrompt.value.trim()) {
    e.preventDefault();
    e.stopPropagation();
    pendingUserSendStartedAt = Date.now();
    sendManualOrPending();
  }
}, true);
renderAutoSend();

window.electronAPI.onLLMStream(msg => {
  if (!msg || msg.requestId !== activeStreamRequestId) return;
  if (msg.type === 'start') {
    if (activeLatencyTrace) {
      activeLatencyTrace.transportTiming = msg.transportTiming || activeLatencyTrace.transportTiming;
      updateLatencyLabel(activeLatencyTrace, msg);
    }
  } else if (msg.type === 'delta') {
    if (activeLatencyTrace) {
      if (!activeLatencyTrace.firstRendererDeltaAt) activeLatencyTrace.firstRendererDeltaAt = Date.now();
      if (msg.transportTiming) activeLatencyTrace.transportTiming = msg.transportTiming;
      updateLatencyLabel(activeLatencyTrace, msg);
    }
    if (!streamHasText) {
      streamedAnswerText = '';
      streamHasText = true;
      if (activeAnswerTurn?.responseElement && !activeAnswerTurn.answer) activeAnswerTurn.responseElement.textContent = '';
      resetStreamingRenderer(activeAnswerTurn?.responseElement || answerEl);
      // Re-anchor on first provider output as a second guard against layout changes
      // between Send and first-token arrival. The user can start reading immediately.
      scrollTurnToTop(activeAnswerTurn);
    }
    // Append each provider delta immediately. Avoid rebuilding the whole answer on every token.
    appendPlainAnswerDelta(msg.delta || '');
  } else if (msg.type === 'replace') {
    // Backward-compatibility safety: never replace wording that has already appeared.
    // Older backends may still emit a repair/upgrade event; accept it only before any text.
    if (!streamHasText && !streamedAnswerText) {
      streamHasText=true;
      renderPlainAnswer(msg.text||'No answer returned.');
    }
  } else if (msg.type === 'meta') {
    if (activeLatencyTrace) {
      if (msg.transportTiming) activeLatencyTrace.transportTiming = msg.transportTiming;
      if (msg.latency) activeLatencyTrace.backendLatency = msg.latency;
      if (msg.model) activeLatencyTrace.model = msg.model;
      updateLatencyLabel(activeLatencyTrace, msg);
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
      modelLabel.textContent='completing required format…';
    } else if (msg.phase === 'complete' && msg.latency) {
      const first = msg.latency.firstTokenMs;
      modelLabel.textContent = `${msg.model || ''}${Number.isFinite(first) ? ` · first ${first}ms` : ''}`.trim();
    }
  } else if (msg.type === 'done') {
    if (activeLatencyTrace) {
      activeLatencyTrace.doneAt = Date.now();
      if (msg.transportTiming) activeLatencyTrace.transportTiming = msg.transportTiming;
      if (msg.latency) activeLatencyTrace.backendLatency = msg.latency;
      if (msg.model) activeLatencyTrace.model = msg.model;
    }
    flushPendingAnswerDelta();
    finalizeStreamingRenderer();
    // Do not rebuild a response that the user has already been reading. Replacing the
    // streamed DOM at completion can reflow long answers and make the text appear to
    // resize/jump even when the wording is effectively the same. Keep the exact live
    // rendering in place; only use the completed payload when no text was streamed.
    if (!streamHasText && !streamedAnswerText) {
      renderPlainAnswer(msg.answer || 'No answer returned.');
    } else if (activeAnswerTurn) {
      // Store a clean copy for transcript/PDF persistence without touching the pixels
      // already on screen. Any explicit backend format-repair has already arrived as
      // a `replace` event and is therefore already reflected in streamedAnswerText.
      activeAnswerTurn.answer = cleanStoredAnswer(streamedAnswerText);
    }
    if (activeLatencyTrace) {
      updateLatencyLabel(activeLatencyTrace, msg);
      console.log(lastLatencyTraceText);
      feedback('Latency trace ready — click the timing line to copy it.');
    } else if (msg.model) {
      const first = msg.latency?.firstTokenMs;
      modelLabel.textContent = `${msg.model}${Number.isFinite(first) ? ` · first ${first}ms` : ''}`;
    }
    if (activeAnswerTurn && activeAnswerTurn.requestId === msg.requestId) activeAnswerTurn.answeredAt = Date.now();
    ensureCurrentTurnReadingSlot(activeAnswerTurn);
    activeStreamRequestId = null;
    if (reanswerBtn) reanswerBtn.disabled=!lastSubmittedPrompt?.text;
  } else if (msg.type === 'error') {
    flushPendingAnswerDelta();
    finalizeStreamingRenderer();
    const errorText = `LLM error: ${msg.error || 'Request failed'}`;
    if (!streamHasText && !streamedAnswerText) {
      streamedAnswerText = errorText;
      renderPlainAnswer(errorText);
      if (activeAnswerTurn) activeAnswerTurn.answer = errorText;
    } else if (activeAnswerTurn) {
      // Preserve every word already shown. Surface the failure only in the status label.
      activeAnswerTurn.answer = cleanStoredAnswer(streamedAnswerText);
    }
    if (activeAnswerTurn) activeAnswerTurn.answeredAt = Date.now();
    modelLabel.textContent = streamHasText ? 'stream interrupted' : '';
    ensureCurrentTurnReadingSlot(activeAnswerTurn);
    activeStreamRequestId = null;
    if (reanswerBtn) reanswerBtn.disabled=!lastSubmittedPrompt?.text;
  }
});

window.electronAPI.onStatus(msg => statusEl.textContent = msg);
window.electronAPI.onSpeechStart(() => { statusEl.textContent = 'Speech detected from Windows system audio...'; });
window.electronAPI.onCredits(updateCredits);
window.electronAPI.onTranscript(({text,isFinal}) => {
  if (!text) return;
  const clean = stripCommittedOverlap(text);
  if (!clean) {
    if (!isFinal) interimText='';
    renderTranscript({followLatest:false});
    return;
  }
  lastTranscriptAt = Date.now();
  if (isFinal) {
    const now = Date.now();
    const withinMergeWindow = lastSendWasAuto && lastAutoSentText && (now - lastAutoSentAt) <= AUTO_MERGE_WINDOW_MS;
    const shouldMerge = autoSend && withinMergeWindow && !streamHasText;

    if (shouldMerge) {
      // Any speech that resumes during the continuation window belongs to the same auto question.
      // Keep one transcript line, cancel the stale generation, combine ALL fragments, and regenerate.
      const combined = mergeTranscriptText(lastAutoSentText,clean);
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
        finalLines[pendingIndex].text = mergeTranscriptText(finalLines[pendingIndex].text,clean);
      } else {
        finalLines.push({ text: clean, sent: false });
      }
      if (finalLines.length > MAX_LINES) finalLines = finalLines.slice(-MAX_LINES);
      utteranceParts.push(clean);
      lastTranscriptAt = now;
      lastFinalAt = now;
      // Overlap a possible embedding request with the existing 450ms auto-send quiet window.
      // Backend skips this entirely for lexical-fast/history-reuse questions.
      prefetchQuestionEvidence(getCompleteUnsentTranscript(), 0);
      scheduleLLM();
    }
    interimText = '';
  } else {
    interimText = clean;
  }
  renderTranscript();
});
