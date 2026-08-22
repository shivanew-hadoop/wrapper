// meet-controller/index.js — Google Meet inside Electron BrowserWindow with persistent Google profile
const { BrowserWindow, screen, session } = require('electron');
const path = require('path');

const GOOGLE_PROFILE_PARTITION = 'persist:gmeet-profile';

let meetWindow = null;
let loginWindow = null;
let debugVisible = false;
let pollTimer = null;
let manualJoinWatcher = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeStatus(cb, msg) { try { cb && cb(msg); } catch (_) {} }

function getRandomGuestName() {
  // Short American-style display names, max 6 characters.
  const names = ['Liam', 'Noah', 'Emma', 'Ava', 'Mia', 'Ella', 'Jack', 'Luke', 'Ryan', 'Owen', 'Evan', 'Nora'];
  return names[Math.floor(Math.random() * names.length)];
}

function makeMeetWindowClickableForJoin() {
  if (!meetWindow || meetWindow.isDestroyed() || debugVisible) return null;
  const state = {
    opacity: meetWindow.getOpacity(),
    bounds: meetWindow.getBounds(),
    skipTaskbar: true,
  };

  // IMPORTANT:
  // Ctrl+Shift+M was fixing join because it makes the hidden Meet BrowserWindow
  // visible/focused. Google Meet sometimes ignores synthetic clicks when the
  // BrowserWindow is at 0.01 opacity and click-through. During auto-join only,
  // make it a real interactive window, perform native click, then restore it.
  meetWindow.setIgnoreMouseEvents(false);
  meetWindow.setOpacity(1);
  meetWindow.setSkipTaskbar(true);
  meetWindow.show();
  meetWindow.focus();
  return state;
}

function restoreMeetWindowAfterJoinClick(state) {
  if (!meetWindow || meetWindow.isDestroyed() || debugVisible || !state) return;
  try {
    meetWindow.setOpacity(state.opacity || 0.01);
    meetWindow.setBounds(state.bounds);
    meetWindow.setSkipTaskbar(true);
    meetWindow.setIgnoreMouseEvents(true, { forward: true });
  } catch (_) {}
}


function showMeetWindowForManualJoin() {
  if (!meetWindow || meetWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  debugVisible = true;
  meetWindow.setOpacity(1);
  meetWindow.setIgnoreMouseEvents(false);
  meetWindow.setSkipTaskbar(false);
  meetWindow.setBounds({
    x: Math.floor((width - 1050) / 2),
    y: Math.max(20, Math.floor((height - 760) / 2)),
    width: 1050,
    height: Math.min(760, height - 40),
  });
  meetWindow.show();
  meetWindow.focus();
}

function hideMeetWindowAfterManualJoin() {
  if (!meetWindow || meetWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  debugVisible = false;
  meetWindow.setOpacity(0.01);
  meetWindow.setBounds({ x: display.bounds.x + 4, y: display.bounds.y + 4, width: 1050, height: 760 });
  meetWindow.setSkipTaskbar(true);
  meetWindow.setIgnoreMouseEvents(true, { forward: true });
}

async function readMeetBodyText() {
  if (!meetWindow || meetWindow.isDestroyed()) return '';
  return await meetWindow.webContents.executeJavaScript(`document.body ? document.body.innerText : ''`, true).catch(() => '');
}

function isManualJoinSubmitted(bodyText) {
  const body = String(bodyText || '').toLowerCase();
  return (
    body.includes('waiting to be admitted') ||
    body.includes('asking to join') ||
    body.includes('asking to be joined') ||
    body.includes('someone will let you in') ||
    body.includes('you’ll join when someone lets you in') ||
    body.includes("you'll join when someone lets you in") ||
    body.includes('you will join when someone lets you in') ||
    body.includes('leave call') ||
    body.includes('meeting details') ||
    body.includes('chat with everyone') ||
    (body.includes('people') && body.includes('chat'))
  );
}

async function prepareMeetPreJoinOnly(guestName, onStatusUpdate) {
  if (!meetWindow || meetWindow.isDestroyed()) return;
  const js = `(async () => {
    const guestName = ${JSON.stringify(guestName || getRandomGuestName())};
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    function visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    }
    function textOf(el) {
      return ((el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '') + '').trim();
    }
    function clickByText(patterns) {
      const nodes = [...document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]')].filter(visible);
      for (const el of nodes) {
        const t = textOf(el).toLowerCase().replace(/\s+/g, ' ');
        if (patterns.some(p => t.includes(p))) { try { el.click(); } catch (_) {} return t; }
      }
      return null;
    }
    function setInputValue(el, value) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function pageText() { return (document.body?.innerText || '').toLowerCase(); }

    clickByText(['got it', 'dismiss', 'understood', 'continue']);
    await sleep(150);

    const inputs = [...document.querySelectorAll('input, textarea')].filter(visible);
    const nameInput = inputs.find(i => /name/i.test(i.placeholder || '') || /name/i.test(i.getAttribute('aria-label') || '') || i.type === 'text');
    if (nameInput && !nameInput.value) {
      nameInput.focus();
      setInputValue(nameInput, guestName);
      await sleep(150);
    }

    for (let round = 0; round < 2; round++) {
      for (const b of [...document.querySelectorAll('button, div[role="button"]')].filter(visible)) {
        const label = (b.getAttribute('aria-label') || b.getAttribute('data-tooltip') || b.innerText || '').toLowerCase();
        if (label.includes('turn off microphone') || label.includes('mute microphone') || label.includes('turn off mic') || label === 'microphone on') {
          try { b.click(); } catch (_) {}
        }
        if (label.includes('turn off camera') || label.includes('turn off video') || label === 'camera on') {
          try { b.click(); } catch (_) {}
        }
      }
      try {
        for (const s of window.__gmeetLocalStreams || []) {
          s.getAudioTracks().forEach(t => { t.enabled = false; try { t.stop(); } catch(e) {} });
          s.getVideoTracks().forEach(t => { t.enabled = false; try { t.stop(); } catch(e) {} });
        }
      } catch (_) {}
      await sleep(200);
      const body = pageText();
      if (!body.includes('microphone is on') && !body.includes('camera is on')) break;
    }

    clickByText(['continue without microphone', 'continue without mic', 'continue without camera']);
    return { body: document.body?.innerText || '', title: document.title, url: location.href };
  })()`;
  await meetWindow.webContents.executeJavaScript(js, true).catch((e) => {
    console.error('[MeetManualJoin] pre-join preparation failed:', e.message);
  });
  safeStatus(onStatusUpdate, 'Meet window opened. Click Ask to join / Join now manually. It will hide automatically after that.');
}

function getBotSession() {
  const ses = session.fromPartition(GOOGLE_PROFILE_PARTITION);
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(['media', 'microphone', 'camera', 'notifications'].includes(permission));
  });
  return ses;
}


async function isGoogleLoggedIn() {
  const ses = getBotSession();
  const googleCookies = await ses.cookies.get({ domain: '.google.com' }).catch(() => []);

  // These cookies are long-lived Google auth/session indicators. Presence means
  // Electron has an existing Google profile; Google may still re-auth if expired.
  const authCookieNames = new Set(['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID']);
  return googleCookies.some(c => authCookieNames.has(c.name));
}

function normalizeMeetUrl(url) {
  const u = String(url || '').trim();
  if (!u) throw new Error('Meet URL is empty');
  if (!/^https:\/\/meet\.google\.com\//i.test(u)) throw new Error('Invalid Google Meet URL');
  return u;
}

function createMeetWindow(onStatusUpdate) {
  if (meetWindow && !meetWindow.isDestroyed()) return meetWindow;

  const display = screen.getPrimaryDisplay();
  // IMPORTANT:
  // Do NOT keep Meet completely off-screen. Google Meet sometimes stays on
  // "Getting ready..." until the Chromium view is actually rendered.
  // Keep it rendered on the real screen, but almost invisible and click-through.
  // Ctrl+Shift+M can still bring it fully visible for debugging.
  meetWindow = new BrowserWindow({
    width: 1050,
    height: 760,
    x: display.bounds.x + 4,
    y: display.bounds.y + 4,
    show: true,
    opacity: 0.01,
    skipTaskbar: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'meet-preload.js'),
      partition: GOOGLE_PROFILE_PARTITION, // same signed-in Google session every run
      contextIsolation: false,             // required: patch page RTCPeerConnection directly
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  meetWindow.webContents.setAudioMuted(true); // no speaker/system audio leakage
  meetWindow.setIgnoreMouseEvents(true, { forward: true });
  meetWindow.setContentProtection(true);

  meetWindow.webContents.on('console-message', (_, level, message) => {
    console.log('[MeetWindow]', message);
  });

  meetWindow.on('closed', () => {
    meetWindow = null;
    if (pollTimer) clearInterval(pollTimer);
  });

  safeStatus(onStatusUpdate, 'Meet window ready');
  return meetWindow;
}

async function openGoogleSignIn(onStatusUpdate, force = false) {
  getBotSession();

  if (!force && await isGoogleLoggedIn()) {
    safeStatus(onStatusUpdate, 'Google account verified. You are signed in.');
  } else {
    safeStatus(onStatusUpdate, 'Please sign in with your Google account.');
  }

  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.show();
    loginWindow.focus();
    return true;
  }

  loginWindow = new BrowserWindow({
    width: 1120,
    height: 820,
    show: true,
    title: 'Google Sign-In for Meeting Caption Service',
    webPreferences: {
      partition: GOOGLE_PROFILE_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  let signInCheckTimer = null;
  let countdownStarted = false;

  loginWindow.on('closed', () => {
    if (signInCheckTimer) clearInterval(signInCheckTimer);
    signInCheckTimer = null;
    loginWindow = null;
    safeStatus(onStatusUpdate, 'Ready to join meetings.');
  });

  // Check if user successfully signed in
  signInCheckTimer = setInterval(async () => {
    if (!loginWindow || loginWindow.isDestroyed()) {
      if (signInCheckTimer) clearInterval(signInCheckTimer);
      return;
    }

    const loggedIn = await isGoogleLoggedIn().catch(() => false);
    if (loggedIn && !countdownStarted) {
      countdownStarted = true;
      if (signInCheckTimer) clearInterval(signInCheckTimer);
      
      // Signal overlay to show countdown timer (5 seconds)
      if (global.overlayWindow && !global.overlayWindow.isDestroyed()) {
        try {
          global.overlayWindow.webContents.send('start-countdown-timer', 5);
        } catch (e) {
          console.error('[OpenGoogleSignIn] Error sending countdown signal:', e);
        }
      }
      
      safeStatus(onStatusUpdate, 'Sign-in successful! Check the countdown panel below.');
    }
  }, 500);

  await loginWindow.loadURL('https://accounts.google.com/').catch((err) => {
    console.error('[GoogleSignIn] load error:', err);
    safeStatus(onStatusUpdate, 'Failed to load sign-in page. Check your internet connection.');
  });
  return true;
}

async function clearGoogleProfile(onStatusUpdate) {
  const ses = getBotSession();
  await ses.clearStorageData();
  await ses.clearCache();
  safeStatus(onStatusUpdate, 'Saved Google profile cleared. Sign in again if needed.');
  return true;
}

async function runMeetAutomation(guestName, onStatusUpdate) {
  if (!meetWindow || meetWindow.isDestroyed()) return false;

  const js = `(async () => {
    const guestName = ${JSON.stringify(guestName || getRandomGuestName())};
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    }
    function textOf(el) {
      return ((el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '') + '').trim();
    }
    function allClickable() {
      return [...document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]')].filter(visible);
    }
    function hardClick(el) {
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
      try { el.focus && el.focus(); } catch (_) {}
      const rect = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
        try { el.dispatchEvent(new MouseEvent(type, opts)); } catch (_) {}
      }
      try { el.click(); } catch (_) {}
    }
    function clickByText(patterns) {
      const candidates = allClickable();
      for (const el of candidates) {
        const t = textOf(el).toLowerCase().replace(/\s+/g, ' ');
        if (patterns.some(p => t.includes(p))) { hardClick(el); return t; }
      }
      return null;
    }
    function findJoinButton() {
      // Extended patterns for better button detection including guest mode
      const patterns = [
        'switch here','ask to join','request to join','join now','join meeting',
        'join this call','join call','join','join the meeting','enter the meeting',
        'continue to meeting'
      ];
      for (const el of allClickable()) {
        const t = textOf(el).toLowerCase().replace(/\s+/g, ' ');
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
        if (!disabled && patterns.some(p => t.includes(p) || aria.includes(p))) return { el, text: t || aria };
      }
      return null;
    }
    function setInputValue(el, value) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function pageText() { return (document.body?.innerText || '').toLowerCase(); }

    async function forceMicCameraOff() {
      const before = pageText();
      for (let round = 0; round < 3; round++) {
        for (const b of [...document.querySelectorAll('button, div[role="button"]')].filter(visible)) {
          const label = (b.getAttribute('aria-label') || b.getAttribute('data-tooltip') || b.innerText || '').toLowerCase();
          if (
            label.includes('turn off microphone') ||
            label.includes('mute microphone') ||
            label.includes('turn off mic') ||
            label === 'microphone on'
          ) b.click();
          if (
            label.includes('turn off camera') ||
            label.includes('turn off video') ||
            label === 'camera on'
          ) b.click();
        }
        try {
          for (const s of window.__gmeetLocalStreams || []) {
            s.getAudioTracks().forEach(t => { t.enabled = false; try { t.stop(); } catch(e) {} });
            s.getVideoTracks().forEach(t => { t.enabled = false; try { t.stop(); } catch(e) {} });
          }
        } catch (_) {}
        await sleep(300);
        const body = pageText();
        if (!body.includes('microphone is on') && !body.includes('camera is on')) break;
      }
      return before;
    }

    clickByText(['got it', 'dismiss', 'understood', 'continue']);
    await sleep(300);

    const inputs = [...document.querySelectorAll('input, textarea')].filter(visible);
    const nameInput = inputs.find(i => /name/i.test(i.placeholder || '') || /name/i.test(i.getAttribute('aria-label') || '') || i.type === 'text');
    if (nameInput && !nameInput.value) {
      nameInput.focus();
      setInputValue(nameInput, guestName);
      await sleep(400);
    }

    await forceMicCameraOff();
    clickByText(['continue without microphone', 'continue without mic', 'continue without camera']);

    // Meet sometimes shows "Getting ready... You'll be able to join in just a moment".
    // Do not fail during this state. Keep polling until Join button appears.
    const bodyRaw = document.body.innerText || '';
    const body = bodyRaw.toLowerCase();
    if (body.includes('getting ready') || body.includes("you'll be able to join") || body.includes('you’ll be able to join')) {
      return { action: 'getting_ready', title: document.title, body: bodyRaw.slice(0, 500) };
    }

    await forceMicCameraOff();

    const joinBtn = findJoinButton();
    if (joinBtn) {
      hardClick(joinBtn.el);
      return { action: 'clicked', text: joinBtn.text };
    }

    // Final fallback: some Meet builds expose the button text only inside nested spans.
    const clicked = clickByText(['switch here', 'ask to join', 'request to join', 'join now', 'join meeting', 'join this call', 'join call']);
    if (clicked) return { action: 'clicked', text: clicked };

    const latestRaw = document.body.innerText || '';
    const latest = latestRaw.toLowerCase();
    if (latest.includes('asking to be joined') || latest.includes('waiting to be admitted') || latest.includes('someone will let you in') || latest.includes('you’ll join when someone lets you in') || latest.includes('you will join when someone lets you in')) return { action: 'waiting_admission' };
    if (latest.includes('leave call') || latest.includes('you are in the meeting') || latest.includes('meeting details') || (latest.includes('people') && latest.includes('chat'))) return { action: 'already_joined' };
    if ((latest.includes('sign in') || latest.includes('signin')) && (latest.includes('join') || latest.includes('continue'))) return { action: 'signin_required' };
    return { action: 'not_found', title: document.title, url: location.href, body: latestRaw.slice(0, 900) };
  })()`;

  const result = await meetWindow.webContents.executeJavaScript(js, true);

  if (result.action === 'getting_ready') {
    safeStatus(onStatusUpdate, 'Meeting loading. Auto-joining when ready...');
    return false;
  }
  if (result.action === 'clicked') {
    safeStatus(onStatusUpdate, 'Join button clicked. Waiting for host to admit...');
    return true;
  }
  if (result.action === 'waiting_admission') {
    safeStatus(onStatusUpdate, 'Join request sent. Waiting for host admission...');
    return true;
  }
  if (result.action === 'already_joined') {
    safeStatus(onStatusUpdate, 'Successfully joined! Transcription active...');
    return true;
  }
  if (result.action === 'signin_required') {
    safeStatus(onStatusUpdate, 'Guest mode not available for this meeting. Try signing in (Ctrl+Shift+G).');
    return false;
  }

  console.log('[AutoJoin] Not found:', result);
  safeStatus(onStatusUpdate, 'Searching for join button...');
  return false;
}


async function nativeClickMeetEntryButton(onStatusUpdate) {
  if (!meetWindow || meetWindow.isDestroyed()) return false;

  const candidate = await meetWindow.webContents.executeJavaScript(`(() => {
    function visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 8 && r.height > 8 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.right > 0;
    }
    function textOf(el) {
      return ((el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '') + '').trim();
    }
    const patterns = ['switch here','ask to join','request to join','join now','join meeting','join this call','join call'];
    const nodes = [...document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]')].filter(visible);
    for (const el of nodes) {
      const txt = textOf(el).toLowerCase().replace(/\s+/g, ' ');
      const aria = (el.getAttribute('aria-label') || '').toLowerCase().replace(/\s+/g, ' ');
      const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
      if (disabled) continue;
      if (patterns.some(p => txt.includes(p) || aria.includes(p))) {
        const r = el.getBoundingClientRect();
        el.scrollIntoView({ block: 'center', inline: 'center' });
        return { found: true, text: txt || aria, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
    }
    return { found: false, body: (document.body?.innerText || '').slice(0, 700), url: location.href, title: document.title };
  })()`, true).catch(err => ({ found: false, error: err.message }));

  if (!candidate || !candidate.found) {
    console.log('[MeetNativeClick] No entry button:', candidate);
    return false;
  }

  console.log('[MeetNativeClick] Clicking:', candidate.text, candidate.x, candidate.y);
  safeStatus(onStatusUpdate, `Clicking Meet button: ${candidate.text}`);

  const restoreState = makeMeetWindowClickableForJoin();
  try {
    meetWindow.webContents.focus();
    await sleep(220);

    // Native click path. This is the same practical effect as user opening
    // Ctrl+Shift+M and clicking, but done automatically.
    meetWindow.webContents.sendInputEvent({ type: 'mouseMove', x: candidate.x, y: candidate.y });
    await sleep(80);
    meetWindow.webContents.sendInputEvent({ type: 'mouseDown', x: candidate.x, y: candidate.y, button: 'left', clickCount: 1 });
    await sleep(120);
    meetWindow.webContents.sendInputEvent({ type: 'mouseUp', x: candidate.x, y: candidate.y, button: 'left', clickCount: 1 });

    // Keyboard fallback for Meet builds where the focused button accepts Enter
    // but rejects synthetic mouse click.
    await sleep(250);
    meetWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    meetWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

    await sleep(1600);
    return true;
  } finally {
    restoreMeetWindowAfterJoinClick(restoreState);
  }
}

async function joinMeet(meetUrl, guestName, onStatusUpdate) {
  const url = normalizeMeetUrl(meetUrl);
  getBotSession();

  createMeetWindow(onStatusUpdate);
  const loggedIn = await isGoogleLoggedIn().catch(() => false);
  
  if (loggedIn) {
    safeStatus(onStatusUpdate, 'Opening Google Meet using saved Google profile...');
  } else {
    safeStatus(onStatusUpdate, 'Opening Google Meet. Joining as guest...');
  }

  await meetWindow.loadURL(url, {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  });
  await sleep(1000);

  // AUTOMATIC JOIN FLOW:
  // Skip showing the window to the user - automatically join instead
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (manualJoinWatcher) clearInterval(manualJoinWatcher);
  manualJoinWatcher = null;

  let attempts = 0;
  const maxAttempts = 40; // ~40 seconds worth of retries

  safeStatus(onStatusUpdate, 'Preparing to join meeting...');

  // Run automation polling to automatically click join buttons
  pollTimer = setInterval(async () => {
    if (!meetWindow || meetWindow.isDestroyed()) {
      clearInterval(pollTimer);
      return;
    }

    attempts++;
    
    try {
      // Keep mic/camera off
      if (attempts % 3 === 0) await prepareMeetPreJoinOnly(guestName, onStatusUpdate);

      // Attempt automatic join
      const result = await runMeetAutomation(guestName, onStatusUpdate);
      
      // Check if join was successful
      const bodyText = await readMeetBodyText();
      if (isManualJoinSubmitted(bodyText)) {
        clearInterval(pollTimer);
        pollTimer = null;
        safeStatus(onStatusUpdate, 'Successfully joined meeting. Captions active...');
      } else if (attempts >= maxAttempts) {
        clearInterval(pollTimer);
        pollTimer = null;
        safeStatus(onStatusUpdate, 'Could not auto-join. Please check meeting URL and try again.');
      }
    } catch (e) {
      console.error('[AutoJoin] error:', e.message);
      if (attempts >= maxAttempts) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }
  }, 1000);

  return true;
}

async function leaveMeet() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (manualJoinWatcher) clearInterval(manualJoinWatcher);
  manualJoinWatcher = null;

  try {
    if (meetWindow && !meetWindow.isDestroyed()) {
      await meetWindow.webContents.executeJavaScript(`(() => {
        const btns = [...document.querySelectorAll('button, div[role="button"]')];
        const btn = btns.find(b => /leave call|hang up/i.test((b.getAttribute('aria-label') || b.innerText || '')));
        if (btn) btn.click();
      })()`, true).catch(() => {});
      meetWindow.close();
    }
  } catch (_) {}
  meetWindow = null;
}


async function sendMeetChatToMeeting(message) {
  const text = String(message || '').trim();
  if (!text) return { success: false, error: 'Empty chat message' };
  if (!meetWindow || meetWindow.isDestroyed()) return { success: false, error: 'Meet window is not active' };

  // Keep the customer message complete. Overlay currently caps at 8000 chars; Meet may still enforce
  // its own product-side limit, but this app should not truncate before sending.
  const safeText = JSON.stringify(text.slice(0, 8000));

  const sendJs = `(async () => {
    const message = ${safeText};
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    function norm(v) { return String(v || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim(); }
    function visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    }
    function labelOf(el) {
      return norm([
        el.getAttribute('aria-label'),
        el.getAttribute('data-tooltip'),
        el.getAttribute('title'),
        el.getAttribute('placeholder'),
        el.innerText,
        el.textContent
      ].filter(Boolean).join(' ')).toLowerCase();
    }
    function clickEl(el) {
      if (!el) return false;
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
      try { el.click(); return true; } catch (_) {}
      try {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      } catch (_) {}
      return false;
    }
    function clickBest(patterns) {
      const nodes = [...document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]')].filter(visible);
      for (const el of nodes) {
        const t = labelOf(el);
        if (patterns.some(p => t.includes(p))) {
          if (clickEl(el)) return true;
        }
      }
      return false;
    }
    function findChatInput() {
      const inputs = [...document.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"], div[role="textbox"]')]
        .filter(visible)
        .map(el => ({
          el,
          hint: norm(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('data-tooltip') || '').toLowerCase(),
          text: norm(el.innerText || el.textContent || el.value || '').toLowerCase()
        }))
        .filter(x => {
          const h = x.hint + ' ' + x.text;
          return /send.*message|message.*everyone|message everyone|send a message|chat/i.test(h);
        });
      if (!inputs.length) return null;
      return (inputs.find(x => /send.*message|message.*everyone|message everyone|send a message/i.test(x.hint)) || inputs[0]).el;
    }
    async function openChatPanel() {
      let input = findChatInput();
      if (input) return input;

      clickBest(['chat with everyone', 'in-call messages', 'open chat', 'show chat']);
      await sleep(650);
      input = findChatInput();
      if (input) return input;

      clickBest(['meeting tools', 'activities']);
      await sleep(350);
      clickBest(['chat with everyone', 'in-call messages', 'open chat', 'show chat', 'chat']);
      await sleep(900);
      input = findChatInput();
      if (input) return input;

      return null;
    }
    function setNativeValue(el, value) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    }
    function fireInput(el, value) {
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      try { el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: value })); } catch (_) {}
      try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); } catch (_) {}
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
    }
    function insertIntoInput(input, value) {
      input.focus();
      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
        setNativeValue(input, value);
        fireInput(input, value);
        return norm(input.value).length > 0;
      }
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, value);
        fireInput(input, value);
        if (norm(input.innerText || input.textContent).includes(norm(value).slice(0, Math.min(30, norm(value).length)))) return true;
      } catch (_) {}
      try {
        input.textContent = value;
        fireInput(input, value);
        return norm(input.innerText || input.textContent).length > 0;
      } catch (_) {}
      return false;
    }
    function findSendButton(input) {
      const roots = [];
      let el = input;
      for (let i = 0; el && i < 12; i += 1, el = el.parentElement) roots.push(el);
      roots.push(document.body);
      for (const root of roots) {
        const btns = [...root.querySelectorAll('button, div[role="button"], span[role="button"]')].filter(visible);
        for (const btn of btns) {
          const t = labelOf(btn);
          const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
          if (!disabled && (/send.*message/i.test(t) || t === 'send message' || t === 'send')) return btn;
        }
      }
      return null;
    }
    async function sendInput(input) {
      input.focus();
      await sleep(300);
      let btn = findSendButton(input);
      if (btn && clickEl(btn)) return true;

      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
      await sleep(350);
      btn = findSendButton(input);
      if (btn && clickEl(btn)) return true;
      return true;
    }

    const input = await openChatPanel();
    if (!input) return { success: false, error: 'Meet chat input not found. Open Meet chat on Meet window once and confirm chat is enabled.' };

    const inserted = insertIntoInput(input, message);
    if (!inserted) return { success: false, error: 'Could not type into Meet chat input' };

    await sendInput(input);
    try { if (window.__topperRememberLocalOutgoingChat) window.__topperRememberLocalOutgoingChat(message); } catch (_) {}
    return { success: true };
  })()`;

  try {
    return await meetWindow.webContents.executeJavaScript(sendJs, true);
  } catch (err) {
    return { success: false, error: err.message || 'Could not send Meet chat message' };
  }
}

function toggleMeetDebug() {
  if (!meetWindow || meetWindow.isDestroyed()) return;
  debugVisible = !debugVisible;
  if (debugVisible) {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    meetWindow.setOpacity(1);
    meetWindow.setIgnoreMouseEvents(false);
    meetWindow.setBounds({ x: Math.floor((width - 1050) / 2), y: 280, width: 1050, height: Math.min(760, height - 320) });
    meetWindow.setSkipTaskbar(false);
    meetWindow.show();
    meetWindow.focus();
  } else {
    meetWindow.setOpacity(0.01);
    const display = screen.getPrimaryDisplay();
    meetWindow.setBounds({ x: display.bounds.x + 4, y: display.bounds.y + 4, width: 1050, height: 760 });
    meetWindow.setSkipTaskbar(true);
    meetWindow.setIgnoreMouseEvents(true, { forward: true });
  }
}

module.exports = { joinMeet, leaveMeet, toggleMeetDebug, openGoogleSignIn, clearGoogleProfile, isGoogleLoggedIn, sendMeetChatToMeeting };
