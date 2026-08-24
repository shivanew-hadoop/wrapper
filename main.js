// main.js — Electron main process: setup -> Windows system audio -> STT -> low-latency RAG LLM overlay
const { app, BrowserWindow, ipcMain, screen, globalShortcut, desktopCapturer, session, clipboard, safeStorage, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Topper must use its own Chromium/Electron profile. Zapper uses the legacy
// MeetingCaptionServiceProfile path, and sharing it makes Chromium report the
// profile as already in use when both EXEs are launched together.
app.setPath('userData', path.join(app.getPath('appData'), 'TopperMeetingCaptionServiceProfile'));
app.setName('Topper');
if (process.defaultApp) app.setAsDefaultProtocolClient('topper', process.execPath, [path.resolve(process.argv[1] || '.')]);
else app.setAsDefaultProtocolClient('topper');

const { startRemoteTranscriptStream, sendAudioChunk, stopRemoteTranscriptStream } = require('./transcriber/remoteDeepgram');

let overlayWindow = null;
let setupWindow = null;
let captureWindow = null;
let started = false;
let remoteSttStarted = false;
let transcriptLimitReached = false;
let usageSessionId = '';
let usageHeartbeatTimer = null;
let creditHardStopTimer = null;
const deviceId = crypto.createHash('sha256').update(app.getPath('userData')).digest('hex');
const activeLLMStreams = new Map();
let desktopAccessToken = '';
let desktopAccount = null;
const pendingLaunchUrl = process.argv.find(x => String(x).startsWith('topper://')) || '';

function readAppConfig() {
  const defaults = { backendUrl: 'http://localhost:8080' };
  try {
    const cfgPath = path.join(__dirname, 'app-config.json');
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return { ...defaults, ...parsed };
  } catch (err) {
    console.warn('[Config] Could not read app-config.json:', err.message);
    return defaults;
  }
}

function normalizeBackendHttpUrl(rawUrl) {
  let url = String(rawUrl || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('Backend URL is empty');
  if (url.startsWith('ws://')) url = url.replace('ws://', 'http://');
  if (url.startsWith('wss://')) url = url.replace('wss://', 'https://');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

function backendBase() { return normalizeBackendHttpUrl(readAppConfig().backendUrl); }

function desktopSessionPath() { return path.join(app.getPath('userData'), 'desktop-session.bin'); }
function saveDesktopSession() {
  if (!desktopAccessToken || !safeStorage.isEncryptionAvailable()) return;
  const encrypted = safeStorage.encryptString(JSON.stringify({accessToken:desktopAccessToken,account:desktopAccount}));
  fs.writeFileSync(desktopSessionPath(), encrypted, {mode:0o600});
}
function loadDesktopSession() {
  try { const saved=JSON.parse(safeStorage.decryptString(fs.readFileSync(desktopSessionPath())));desktopAccessToken=String(saved.accessToken||'');desktopAccount=saved.account||null;global.currentLicenseEmail=desktopAccount?.email||''; } catch (_) {}
}
async function desktopRequest(route, options={}) {
  const headers={'content-type':'application/json',...(desktopAccessToken?{authorization:`Bearer ${desktopAccessToken}`}:{}) ,...(options.headers||{})};
  const res=await fetch(`${backendBase()}${route}`,{...options,headers});const data=await res.json().catch(()=>({}));
  if(!res.ok||!data.ok)throw new Error(data.error||`Desktop account request failed (${res.status})`);return data;
}
async function refreshDesktopAccount() {
  if(!desktopAccessToken)return null;const data=await desktopRequest('/api/desktop/account');desktopAccount=data.account;global.currentLicenseEmail=desktopAccount.email;saveDesktopSession();return desktopAccount;
}
async function handleLaunchUrl(rawUrl) {
  let parsed;try{parsed=new URL(String(rawUrl||''));}catch(_){return;}
  if(parsed.protocol!=='topper:'||parsed.hostname!=='launch')return;
  const token=String(parsed.searchParams.get('token')||'');if(token.length<32||token.length>200)return;
  try { const data=await desktopRequest('/api/desktop/exchange',{method:'POST',body:JSON.stringify({token,deviceId,appVersion:app.getVersion()})});desktopAccessToken=data.accessToken;desktopAccount=data.account;global.currentLicenseEmail=desktopAccount.email;saveDesktopSession();createSetupWindow();setupWindow?.webContents.send('desktop-account-updated',desktopAccount); }
  catch(err){createSetupWindow();setupWindow?.webContents.send('desktop-account-error',err.message||'Launch link is invalid or expired.');}
}

function sendStatus(msg) {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('status', msg);
}
function sendCredits(data) { if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send('credits', data); }
async function usageCall(route, body) { const r=await fetch(`${backendBase()}${route}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${desktopAccessToken}`},body:JSON.stringify(body)}); const d=await r.json().catch(()=>({})); return {...d,httpStatus:r.status}; }
function armCreditHardStop(remainingSeconds) { clearTimeout(creditHardStopTimer); if(Number.isFinite(remainingSeconds)) creditHardStopTimer=setTimeout(()=>hardStopCredits(),Math.max(0,remainingSeconds)*1000+500); }
async function hardStopCredits() { if(!started)return; resetRuntimeFlags(); await stopSystemAudioCapture().catch(()=>{}); stopRemoteTranscriptStream(); await stopUsageSession(); sendCredits({remainingSeconds:0,status:'exhausted'}); sendStatus('Credits exhausted. Listening stopped.'); }
async function stopUsageSession() { clearInterval(usageHeartbeatTimer);clearTimeout(creditHardStopTimer);usageHeartbeatTimer=null;creditHardStopTimer=null;if(usageSessionId){const id=usageSessionId;usageSessionId='';await usageCall('/api/usage/stop',{sessionId:id}).catch(()=>{});} }
async function startUsageSession(email) { const d=await usageCall('/api/usage/start',{email,deviceId}); if(!d.ok)throw new Error(d.error||'No credits remaining'); usageSessionId=d.sessionId;sendCredits(d);armCreditHardStop(d.remainingSeconds);usageHeartbeatTimer=setInterval(async()=>{if(!usageSessionId)return;try{const s=await usageCall('/api/usage/heartbeat',{sessionId:usageSessionId});sendCredits(s);armCreditHardStop(s.remainingSeconds);if(!s.ok||s.status==='exhausted')await hardStopCredits();}catch(_){sendStatus('Credit service reconnecting…');}},5000);return d; }

function resetRuntimeFlags() {
  started = false;
  remoteSttStarted = false;
  transcriptLimitReached = false;
}

async function validateLicenseWithBackend({ licenseEmail }) {
  if(desktopAccessToken){try{const account=await refreshDesktopAccount();return {success:true,user:account};}catch(err){return {success:false,error:err.message};}}
  const res = await fetch(`${backendBase()}/validate-license`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: String(licenseEmail || '').trim().toLowerCase() })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) return { success: false, error: data.reason || data.error || `License check failed (${res.status})` };
  return { success: true, validTill: data.user?.validTill, plan: data.user?.plan, user: data.user };
}


function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function captureCurrentScreen() {
  if (process.platform !== 'win32') throw new Error('Capture Screen currently requires Windows.');
  const startedAt = Date.now();
  // Capture the physical display itself, not a browser/application source. Topper stays visible.
  // setContentProtection(true) on the overlay asks Windows to exclude Topper from screen capture.
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay();
  const targetWidth = Math.min(1920, Math.max(1280, display.size.width));
  const scale = targetWidth / Math.max(1, display.size.width);
  const targetHeight = Math.round(display.size.height * scale);
  const sources = await desktopCapturer.getSources({
    types:['screen'], thumbnailSize:{ width:targetWidth, height:targetHeight }, fetchWindowIcons:false
  });
  const displayId = String(display.id);
  const source = sources.find(s => String(s.display_id) === displayId) || sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error('Could not capture the current screen.');
  const image = source.thumbnail;
  const size = image.getSize();
  const jpeg = image.toJPEG(86);
  return {
    success:true,
    imageDataUrl:`data:image/jpeg;base64,${jpeg.toString('base64')}`,
    sourceName:`Display ${displayId}`,
    width:size.width,
    height:size.height,
    captureMs:Date.now()-startedAt
  };
}

function createSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 900, height: 760, minWidth: 720, minHeight: 650,
    show: true, autoHideMenuBar: true, backgroundColor: '#0b0f17',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  setupWindow.loadFile(path.join(__dirname, 'setup', 'index.html'));
  setupWindow.on('closed', () => { setupWindow = null; });
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) { overlayWindow.show(); return; }
  const { workArea } = screen.getPrimaryDisplay();
  const overlayWidth = 760;
  overlayWindow = new BrowserWindow({
    width: overlayWidth, height: 430, minWidth: 520, minHeight: 48,
    x: workArea.x + workArea.width - overlayWidth - 16, y: workArea.y + 80,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: true, show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  overlayWindow.setContentProtection(true);
  overlayWindow.loadFile(path.join(__dirname, 'overlay', 'index.html'));
  overlayWindow.setContentProtection(true);
  // Use the strongest practical Windows top-most level and reassert it if another app steals Z-order.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.on('blur', () => { if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) { overlayWindow.setAlwaysOnTop(true, 'screen-saver'); overlayWindow.moveTop(); } });
  overlayWindow.on('show', () => { if (overlayWindow && !overlayWindow.isDestroyed()) { overlayWindow.setAlwaysOnTop(true, 'screen-saver'); overlayWindow.moveTop(); } });
  overlayWindow.on('closed', () => { overlayWindow = null; });
}

function configureSystemAudioCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const primaryId = String(screen.getPrimaryDisplay().id);
      const source = sources.find(s => String(s.display_id) === primaryId) || sources[0];
      if (!source) return callback({});
      callback({ video: source, audio: 'loopback' });
    } catch (err) {
      console.error('[SystemAudio] display media grant failed:', err);
      callback({});
    }
  });
}

async function startSystemAudioCapture() {
  if (process.platform !== 'win32') throw new Error('This build captures Windows system audio and currently requires Windows.');
  if (captureWindow && !captureWindow.isDestroyed()) return;
  captureWindow = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'system-audio', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await captureWindow.loadFile(path.join(__dirname, 'system-audio', 'capture.html'));
  captureWindow.webContents.send('capture-start');
}

async function stopSystemAudioCapture() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    try { captureWindow.webContents.send('capture-stop'); } catch (_) {}
    await new Promise(r => setTimeout(r, 80));
    captureWindow.destroy();
  }
  captureWindow = null;
}

function handleRemoteTranscriptPayload(payload) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (payload.error) return overlayWindow.webContents.send('status', 'Transcription error: ' + payload.error);
  if (payload.type === 'status') return overlayWindow.webContents.send('status', payload.text);
  if (payload.type === 'limit_reached') {
    transcriptLimitReached = true;
    overlayWindow.webContents.send('status', payload.text || 'Transcript limit reached.');
    stopRemoteTranscriptStream();
    remoteSttStarted = false;
    return;
  }
  if (payload.type === 'speech_started') return overlayWindow.webContents.send('speech-started');
  overlayWindow.webContents.send('transcript', { text: payload.text, isFinal: payload.isFinal, speechFinal: payload.speechFinal });
}

function ensureRemoteSttStarted() {
  if (remoteSttStarted) return;
  remoteSttStarted = true;
  const email = global.currentLicenseEmail;
  startRemoteTranscriptStream({ backendUrl: backendBase(), licenseEmail: email }, handleRemoteTranscriptPayload);
}

ipcMain.on('system-audio-chunk', (_event, bytes) => {
  if (!started || transcriptLimitReached || !bytes) return;
  const pcmBuffer = Buffer.from(bytes);
  if (!pcmBuffer.length) return;

  if (!remoteSttStarted) {
    sendStatus('Connecting speech recognition...');
    ensureRemoteSttStarted();
  }
  sendAudioChunk(pcmBuffer);
});

ipcMain.on('system-audio-status', (_event, msg) => sendStatus(String(msg || '')));
ipcMain.on('system-audio-error', (_event, msg) => sendStatus('System audio error: ' + String(msg || 'Unknown error')));

ipcMain.handle('get-app-config', async () => readAppConfig());
ipcMain.handle('get-session-info', async () => ({
  licenseEmail: global.currentLicenseEmail || '',
  contextPrepared: !!global.contextPrepared,
  contextMeta: global.contextMeta || null,
}));
ipcMain.handle('get-desktop-account', async () => { try { const account=await refreshDesktopAccount();return account?{success:true,account}:{success:false,error:'Launch Topper from the customer portal first.'}; } catch(err) { return {success:false,error:err.message||'Account validation failed.'}; } });
ipcMain.handle('open-customer-portal', () => shell.openExternal(`${backendBase()}/portal/`));

ipcMain.handle('validate-license', async (_, data) => {
  try { return await validateLicenseWithBackend(data || {}); }
  catch (err) { return { success: false, error: err.message || 'Could not connect to license server' }; }
});

ipcMain.handle('prepare-context', async (_, payload) => {
  try {
    const email = String(payload?.licenseEmail || '').trim().toLowerCase();
    const license = await validateLicenseWithBackend({ licenseEmail: email });
    if (!license.success) return { success:false, error:license.error };
    const res = await fetch(`${backendBase()}/prepare-context`, {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({
        email,
        resume: payload.resume || null,
        jd: payload.jd || null,
        jdText: String(payload.jdText || ''),
        yearsExperience: payload.yearsExperience,
        role: String(payload.role || '')
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) return { success:false, error:data.error || `Context preparation failed (${res.status})` };
    global.currentLicenseEmail = email;
    global.contextPrepared = true;
    global.contextMeta = data;
    return { success:true, ...data };
  } catch (err) {
    return { success:false, error:err.message || 'Context preparation failed' };
  }
});

ipcMain.handle('open-overlay-after-setup', async () => {
  if (!global.currentLicenseEmail || !global.contextPrepared) return { success:false, error:'Prepare context first.' };
  const license = await validateLicenseWithBackend({ licenseEmail: global.currentLicenseEmail }).catch(err => ({ success:false, error:err.message }));
  if (!license.success) return { success:false, error:license.error || 'License is not valid.' };
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
  createOverlayWindow();
  return { success:true };
});

ipcMain.handle('start-listening', async (_, { licenseEmail }) => {
  if (started) return { success: true, started: true };
  try {
    const effectiveEmail = String(licenseEmail || global.currentLicenseEmail || '').trim().toLowerCase();
    const license = await validateLicenseWithBackend({ licenseEmail: effectiveEmail });
    if (!license.success) return { success: false, licenseRequired: true, error: license.error };
    global.currentLicenseEmail = effectiveEmail;
    const usage = Number.isFinite(license.user?.remainingSeconds) ? await startUsageSession(effectiveEmail) : { remainingSeconds:null };
    started = true;
    transcriptLimitReached = false;
    remoteSttStarted = false;
    sendStatus('Connecting speech recognition...');
    ensureRemoteSttStarted(); // Pre-connect before the first audio frame to reduce startup latency.
    sendStatus('Starting Windows system-audio capture...');
    await startSystemAudioCapture();
    sendStatus('Listening to Windows system audio. Play meeting/call audio normally.');
    return { success: true, started: true, remainingSeconds:usage.remainingSeconds };
  } catch (err) {
    await stopSystemAudioCapture().catch(() => {});
    stopRemoteTranscriptStream();
    await stopUsageSession();
    resetRuntimeFlags();
    return { success: false, error: err.message || 'Could not start system audio capture' };
  }
});

ipcMain.handle('stop-listening', async () => {
  resetRuntimeFlags();
  await stopSystemAudioCapture();
  stopRemoteTranscriptStream();
  await stopUsageSession();
  sendStatus('Stopped');
  return { success: true };
});

ipcMain.handle('stop-and-return-setup', async () => {
  resetRuntimeFlags();
  for (const controller of activeLLMStreams.values()) controller.abort();
  activeLLMStreams.clear();
  await stopSystemAudioCapture().catch(() => {});
  stopRemoteTranscriptStream();
  await stopUsageSession();
  // Keep the already prepared backend context until the user prepares another session, but return UI to setup.
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
  createSetupWindow();
  return { success:true };
});

ipcMain.handle('ask-llm', async (_, { text, licenseEmail }) => {
  const prompt = String(text || '').trim();
  if (!prompt) return { success: false, error: 'Empty transcript' };
  try {
    const res = await fetch(`${backendBase()}/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: String(licenseEmail || global.currentLicenseEmail || '').trim().toLowerCase(), text: prompt })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) return { success: false, error: data.error || `LLM request failed (${res.status})` };
    return { success: true, answer: data.answer, model: data.model, latency: data.latency };
  } catch (err) { return { success: false, error: err.message || 'LLM request failed' }; }
});

ipcMain.on('cancel-llm-stream', (_event, requestId) => {
  const controller = activeLLMStreams.get(String(requestId || ''));
  if (controller) controller.abort();
});

ipcMain.on('ask-llm-stream', async (event, payload) => {
  const requestId = String(payload?.requestId || Date.now());
  const prompt = String(payload?.text || '').trim();
  const imageDataUrl = String(payload?.imageDataUrl || '').trim();
  const captureSource = String(payload?.captureSource || '').trim();
  const email = String(payload?.licenseEmail || global.currentLicenseEmail || '').trim().toLowerCase();
  const send = data => {
    try { if (!event.sender.isDestroyed()) event.sender.send('llm-stream', { requestId, ...data }); } catch (_) {}
  };
  if (!prompt && !imageDataUrl) return send({ type:'error', error:'Empty prompt' });

  const controller = new AbortController();
  activeLLMStreams.set(requestId, controller);
  try {
    const res = await fetch(`${backendBase()}/ask/stream`, {
      method:'POST', signal:controller.signal,
      headers:{'content-type':'application/json'},
      body:JSON.stringify({ email, text:prompt, imageDataUrl, captureSource })
    });
    if (!res.ok) {
      const body = await res.text();
      let message = `LLM request failed (${res.status})`;
      try { message = JSON.parse(body).error || message; } catch (_) { if (body) message = body.slice(0, 500); }
      return send({ type:'error', error:message });
    }
    send({ type:'start' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream:true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const evt of events) {
        const lines = evt.split('\n');
        let eventName = 'message';
        let dataLine = '';
        for (const line of lines) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        let data; try { data = JSON.parse(dataLine); } catch (_) { data = { text:dataLine }; }
        if (eventName === 'delta') send({ type:'delta', delta:data.delta || '' });
        else if (eventName === 'meta') send({ type:'meta', ...data });
        else if (eventName === 'done') send({ type:'done', ...data });
        else if (eventName === 'error') send({ type:'error', error:data.error || 'LLM stream failed' });
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') send({ type:'error', error:err.message || 'LLM stream failed' });
  } finally {
    activeLLMStreams.delete(requestId);
  }
});


ipcMain.handle('capture-current-window', async () => {
  try { return await captureCurrentScreen(); }
  catch (err) { return { success:false, error:err.message || 'Screen capture failed' }; }
});

ipcMain.handle('extract-screen-text', async (_, payload) => {
  try {
    const res = await fetch(`${backendBase()}/extract-screen-text`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ email:String(payload?.licenseEmail || global.currentLicenseEmail || '').trim().toLowerCase(), imageDataUrl:String(payload?.imageDataUrl || ''), captureSource:String(payload?.captureSource || '') }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) return { success:false, error:data.error || `Screen text extraction failed (${res.status})` };
    return { success:true, text:data.text || '', captureMs:data.captureMs || 0 };
  } catch (err) { return { success:false, error:err.message || 'Screen text extraction failed' }; }
});

ipcMain.handle('copy-to-clipboard', async (_, text) => {
  const value = String(text || '');
  if (!value.trim()) return { success: false, error: 'Nothing to copy.' };
  clipboard.writeText(value);
  return { success: true };
});

ipcMain.handle('close-overlay', async () => {
  resetRuntimeFlags();
  for (const controller of activeLLMStreams.values()) controller.abort();
  activeLLMStreams.clear();
  await stopSystemAudioCapture().catch(() => {});
  stopRemoteTranscriptStream();
  await stopUsageSession();
  app.quit();
  return { success: true };
});

ipcMain.handle('overlay-set-collapsed', async (_, collapsed) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return true;
  const b = overlayWindow.getBounds();
  overlayWindow.setResizable(!collapsed);
  overlayWindow.setBounds({ x: b.x, y: b.y, width: b.width, height: collapsed ? 48 : Math.max(430, b.height) });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.moveTop();
  return true;
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();
else app.on('second-instance', (_event, argv) => {
  const launchUrl=argv.find(x=>String(x).startsWith('topper://')); if(launchUrl)handleLaunchUrl(launchUrl);
  const win = overlayWindow || setupWindow;
  if (win && !win.isDestroyed()) { win.show(); win.focus(); if (win === overlayWindow) win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop(); }
});

app.whenReady().then(async () => {
  loadDesktopSession();
  configureSystemAudioCapture();
  createSetupWindow();
  if(pendingLaunchUrl)await handleLaunchUrl(pendingLaunchUrl);
  globalShortcut.register('CommandOrControl+Shift+T', () => {
    if (!overlayWindow) return;
    overlayWindow.isVisible() ? overlayWindow.hide() : overlayWindow.show();
    overlayWindow.setAlwaysOnTop(true, 'floating');
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', async () => {
  resetRuntimeFlags();
  await stopSystemAudioCapture().catch(() => {});
  stopRemoteTranscriptStream();
  await stopUsageSession();
  app.quit();
});
