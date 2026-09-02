// main.js — Electron main process: setup -> Windows system audio -> STT -> low-latency RAG LLM overlay
const { app, BrowserWindow, ipcMain, screen, globalShortcut, desktopCapturer, session, clipboard, safeStorage, shell, nativeImage } = require('electron');
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
let publicCursorWindow = null;
let cursorTrackerTimer = null;
let cursorInsideOverlay = false;
let lastPrivateCursorPoint = '';
const fallbackCursorSvg='<svg xmlns="http://www.w3.org/2000/svg" width="24" height="32" viewBox="0 0 24 32"><path d="M2 1v25l6.7-6.1 4.2 9.1 4-1.9-4.2-8.8H22z" fill="white" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
let cursorVisual={dataUrl:`data:image/svg+xml;base64,${Buffer.from(fallbackCursorSvg).toString('base64')}`,width:24,height:32,hotspotX:2,hotspotY:1};
let setupWindow = null;
let captureWindow = null;
let overlayCollapsed = false;
let expandedOverlayBounds = null;
let boundsSaveTimer = null;
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
function setupDefaultsPath() { return path.join(app.getPath('userData'), 'setup-defaults.bin'); }
function saveSetupDefaults(payload) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    const compact={
      resume:payload?.resume||null,
      jd:payload?.jd||null,
      jdText:String(payload?.jdText||''),
      yearsExperience:payload?.yearsExperience,
      role:String(payload?.role||''),
      savedAt:Date.now()
    };
    fs.writeFileSync(setupDefaultsPath(), safeStorage.encryptString(JSON.stringify(compact)), {mode:0o600});
  } catch (err) { console.warn('[SetupDefaults] Could not save previous interview inputs:', err.message); }
}
function loadSetupDefaults() {
  try {
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(setupDefaultsPath())) return null;
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(setupDefaultsPath())));
  } catch (_) { return null; }
}
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

function queryWindowsRegistry(name) {
  return new Promise(resolve => execFile('reg.exe',['query','HKCU\\Control Panel\\Cursors','/v',name],{windowsHide:true},(error,stdout) => {
    if (error) return resolve('');
    const match=String(stdout||'').match(/REG_(?:SZ|EXPAND_SZ|DWORD)\s+(.+)$/mi);
    resolve(match ? match[1].trim() : '');
  }));
}

async function loadSystemCursorVisual() {
  if (process.platform!=='win32') return cursorVisual;
  try {
    let [cursorPath,baseSizeRaw]=await Promise.all([queryWindowsRegistry('Arrow'),queryWindowsRegistry('CursorBaseSize')]);
    cursorPath=cursorPath.replace(/^"|"$/g,'').replace(/%([^%]+)%/g,(_match,name)=>{
      const key=Object.keys(process.env).find(item=>item.toLowerCase()===String(name).toLowerCase());
      return key?process.env[key]:_match;
    });
    if (!cursorPath) cursorPath=path.join(process.env.SystemRoot||'C:\\Windows','Cursors','aero_arrow.cur');
    if (!fs.existsSync(cursorPath)) return cursorVisual;
    const bytes=fs.readFileSync(cursorPath);
    let image=nativeImage.createFromPath(cursorPath);
    if (image.isEmpty()) image=nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return cursorVisual;
    const sourceSize=image.getSize();
    const configuredBase=/^0x/i.test(baseSizeRaw)?parseInt(baseSizeRaw,16):parseInt(baseSizeRaw,10);
    const targetBase=Number.isFinite(configuredBase)?Math.max(16,Math.min(96,configuredBase)):0;
    if (targetBase&&sourceSize.width!==targetBase) image=image.resize({width:targetBase,height:targetBase,quality:'best'});
    const size=image.getSize();
    const isCur=path.extname(cursorPath).toLowerCase()==='.cur'&&bytes.length>=22;
    const entryWidth=isCur?(bytes[6]||256):(size.width||32),entryHeight=isCur?(bytes[7]||256):(size.height||32);
    const hotspotX=isCur?bytes.readUInt16LE(10):0;
    const hotspotY=isCur?bytes.readUInt16LE(12):0;
    cursorVisual={
      dataUrl:image.toDataURL(),
      width:Math.max(16,Math.min(96,size.width||entryWidth)),
      height:Math.max(16,Math.min(96,size.height||entryHeight)),
      hotspotX:Math.round(hotspotX*((size.width||entryWidth)/entryWidth)),
      hotspotY:Math.round(hotspotY*((size.height||entryHeight)/entryHeight))
    };
  } catch (err) { console.warn('[Cursor] Windows cursor fallback:',err.message); }
  return cursorVisual;
}

function createPublicCursorWindow(point) {
  if (publicCursorWindow && !publicCursorWindow.isDestroyed()) {
    publicCursorWindow.setPosition(Math.round(point.x-cursorVisual.hotspotX),Math.round(point.y-cursorVisual.hotspotY),false);
    publicCursorWindow.showInactive();
    return;
  }
  publicCursorWindow = new BrowserWindow({
    x:Math.round(point.x-cursorVisual.hotspotX),y:Math.round(point.y-cursorVisual.hotspotY),width:cursorVisual.width+2,height:cursorVisual.height+2,
    frame:false, transparent:true, backgroundColor:'#00000000', show:false,
    focusable:false, resizable:false, movable:false, minimizable:false,
    maximizable:false, closable:false, skipTaskbar:true, alwaysOnTop:true,
    webPreferences:{contextIsolation:true,nodeIntegration:false}
  });
  publicCursorWindow.setIgnoreMouseEvents(true);
  publicCursorWindow.setAlwaysOnTop(true, 'floating');
  publicCursorWindow.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true});
  // This window intentionally has no content protection. Screen-share viewers
  // see this frozen pointer at the entry edge while Topper itself stays hidden.
  const cursorHtml=`<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}img{display:block;width:${cursorVisual.width}px;height:${cursorVisual.height}px}</style><img src="${cursorVisual.dataUrl}">`;
  publicCursorWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(cursorHtml)}`);
  publicCursorWindow.once('ready-to-show', () => publicCursorWindow?.showInactive());
  publicCursorWindow.on('closed', () => { publicCursorWindow=null; });
}

function hidePublicCursorWindow() {
  if (publicCursorWindow && !publicCursorWindow.isDestroyed()) publicCursorWindow.hide();
}

function stopPrivateCursorTracking() {
  clearInterval(cursorTrackerTimer);
  cursorTrackerTimer=null;
  cursorInsideOverlay=false;
  lastPrivateCursorPoint='';
  hidePublicCursorWindow();
}

function startPrivateCursorTracking() {
  stopPrivateCursorTracking();
  if (overlayWindow&&!overlayWindow.isDestroyed()) overlayWindow.webContents.send('private-cursor-visual',cursorVisual);
  cursorTrackerTimer=setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible() || overlayWindow.isMinimized()) {
      if (cursorInsideOverlay) overlayWindow?.webContents.send('private-cursor-position',{visible:false});
      cursorInsideOverlay=false;lastPrivateCursorPoint='';hidePublicCursorWindow();return;
    }
    const point=screen.getCursorScreenPoint();
    const bounds=overlayWindow.getBounds();
    const inside=point.x>=bounds.x&&point.x<bounds.x+bounds.width&&point.y>=bounds.y&&point.y<bounds.y+bounds.height;
    if (!inside) {
      if (cursorInsideOverlay) overlayWindow.webContents.send('private-cursor-position',{visible:false});
      cursorInsideOverlay=false;lastPrivateCursorPoint='';hidePublicCursorWindow();return;
    }
    if (!cursorInsideOverlay) createPublicCursorWindow(point);
    cursorInsideOverlay=true;
    const relative={visible:true,x:point.x-bounds.x,y:point.y-bounds.y};
    const key=`${relative.x}:${relative.y}`;
    if (key!==lastPrivateCursorPoint) { lastPrivateCursorPoint=key;overlayWindow.webContents.send('private-cursor-position',relative); }
  },16);
}

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
  const defaultBounds = {
    width: Math.min(1050, workArea.width - 32),
    height: Math.min(620, workArea.height - 48),
    x: workArea.x + Math.max(16, workArea.width - Math.min(1050, workArea.width - 32) - 16),
    y: workArea.y + 32
  };
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'overlay-bounds.json'), 'utf8'));
    const visible = screen.getAllDisplays().some(d => saved.x < d.bounds.x + d.bounds.width && saved.x + saved.width > d.bounds.x && saved.y < d.bounds.y + d.bounds.height && saved.y + saved.height > d.bounds.y);
    if (visible && saved.width >= 900 && saved.height >= 520) expandedOverlayBounds = saved;
  } catch (_) {}
  const initialBounds = expandedOverlayBounds || defaultBounds;
  overlayWindow = new BrowserWindow({
    ...initialBounds, minWidth: 680, minHeight: 48,
    frame: false, transparent: true, thickFrame: true, hasShadow: true, alwaysOnTop: true, skipTaskbar: true, resizable: true, maximizable: true, minimizable: true, show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  overlayWindow.setContentProtection(true);
  overlayWindow.loadFile(path.join(__dirname, 'overlay', 'index.html'));
  overlayWindow.webContents.once('did-finish-load', startPrivateCursorTracking);
  overlayWindow.setContentProtection(true);
  // Use the strongest practical Windows top-most level and reassert it if another app steals Z-order.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.on('blur', () => { if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) { overlayWindow.setAlwaysOnTop(true, 'screen-saver'); overlayWindow.moveTop(); } });
  overlayWindow.on('show', () => { if (overlayWindow && !overlayWindow.isDestroyed()) { overlayWindow.setAlwaysOnTop(true, 'screen-saver'); overlayWindow.moveTop(); } });
  const rememberBounds = () => {
    if (!overlayWindow || overlayWindow.isDestroyed() || overlayCollapsed || overlayWindow.isMinimized() || overlayWindow.isMaximized()) return;
    const b = overlayWindow.getBounds();
    if (b.height < 430) return;
    expandedOverlayBounds = b;
    clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      try { fs.writeFileSync(path.join(app.getPath('userData'), 'overlay-bounds.json'), JSON.stringify(expandedOverlayBounds), {mode:0o600}); } catch (_) {}
    }, 250);
  };
  overlayWindow.on('resize', rememberBounds);
  overlayWindow.on('move', rememberBounds);
  overlayWindow.on('unmaximize', () => { if (expandedOverlayBounds) overlayWindow.setBounds(expandedOverlayBounds); });
  overlayWindow.on('closed', () => {
    stopPrivateCursorTracking();
    if (publicCursorWindow && !publicCursorWindow.isDestroyed()) publicCursorWindow.destroy();
    publicCursorWindow=null;
    overlayWindow = null;
  });
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
ipcMain.handle('get-setup-defaults', async () => ({ success:true, defaults:loadSetupDefaults() }));
ipcMain.handle('clear-setup-default-field', async (_, field) => {
  try {
    if (!['resume','jd'].includes(String(field))) return {success:false,error:'Invalid setup field'};
    const current=loadSetupDefaults() || {};
    current[String(field)] = null;
    if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(setupDefaultsPath(), safeStorage.encryptString(JSON.stringify(current)), {mode:0o600});
    return {success:true};
  } catch (err) { return {success:false,error:err.message||'Could not remove saved file'}; }
});
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
    // Persist only after successful preparation; encrypted with Electron safeStorage.
    saveSetupDefaults(payload);
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

ipcMain.handle('save-interview-transcript', async (_, payload) => {
  try {
    const turns = Array.isArray(payload?.turns) ? payload.turns : [];
    if (!turns.length) return { success:true, skipped:true };
    if (!desktopAccessToken) return { success:false, error:'Launch Topper from the customer portal to save interview history.' };
    const data = await desktopRequest('/api/desktop/interview-transcripts', {
      method:'POST',
      body:JSON.stringify({
        startedAt:Number(payload?.startedAt) || Date.now(),
        endedAt:Number(payload?.endedAt) || Date.now(),
        turns
      })
    });
    return { success:true, transcriptId:data.transcriptId };
  } catch (err) {
    console.warn('[Transcript] Could not save completed interview:', err.message);
    return { success:false, error:err.message || 'Could not save interview history.' };
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
  const inputSource = String(payload?.inputSource || '').trim().slice(0,40);
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
      body:JSON.stringify({ email, text:prompt, imageDataUrl, captureSource, inputSource })
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
        else if (eventName === 'replace') send({type:'replace',text:data.text||''});
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
    return {success:true,text:data.text||'',taskType:String(data.taskType||'other').toLowerCase(),captureMs:data.captureMs||0};
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
  if (collapsed && !overlayCollapsed && b.height >= 430) expandedOverlayBounds = b;
  overlayCollapsed = !!collapsed;
  overlayWindow.setResizable(!overlayCollapsed);
  if (overlayCollapsed) overlayWindow.setBounds({x:b.x,y:b.y,width:b.width,height:48});
  else if (expandedOverlayBounds) overlayWindow.setBounds(expandedOverlayBounds);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.moveTop();
  return true;
});

ipcMain.handle('overlay-resize-transcript', async (_, delta) => {
  if (!overlayWindow || overlayWindow.isDestroyed() || overlayCollapsed) return 0;
  const requested = Math.trunc(Number(delta) || 0);
  if (!requested) return 0;
  const b = overlayWindow.getBounds();
  const display = screen.getDisplayMatching(b);
  const maxHeight = Math.max(430, display.workArea.y + display.workArea.height - b.y - 12);
  const nextHeight = Math.max(430, Math.min(maxHeight, b.height + requested));
  const applied = nextHeight - b.height;
  if (applied) overlayWindow.setBounds({...b,height:nextHeight});
  return applied;
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
  await loadSystemCursorVisual();
  configureSystemAudioCapture();
  createSetupWindow();
  if(pendingLaunchUrl)await handleLaunchUrl(pendingLaunchUrl);
  globalShortcut.register('CommandOrControl+Shift+T', () => {
    if (!overlayWindow) return;
    overlayWindow.isVisible() ? overlayWindow.hide() : overlayWindow.show();
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  });
});

app.on('will-quit', () => { stopPrivateCursorTracking();globalShortcut.unregisterAll(); });
app.on('window-all-closed', async () => {
  resetRuntimeFlags();
  await stopSystemAudioCapture().catch(() => {});
  stopRemoteTranscriptStream();
  await stopUsageSession();
  app.quit();
});
