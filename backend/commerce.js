const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

module.exports = function createCommerce({ app, dataDir, publicDir }) {
  const db = new Database(path.join(dataDir, 'topper-commerce.db'));
  db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000'); db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT DEFAULT '', role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active', credit_seconds INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, provider_order_id TEXT UNIQUE NOT NULL, provider_payment_id TEXT UNIQUE, amount_paise INTEGER NOT NULL, credits_seconds INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'created', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, paid_at TEXT, FOREIGN KEY(user_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS credit_ledger(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, delta_seconds INTEGER NOT NULL, reason TEXT NOT NULL, reference TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS usage_sessions(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, started_at_ms INTEGER NOT NULL, last_billed_at_ms INTEGER NOT NULL, ended_at_ms INTEGER, status TEXT NOT NULL DEFAULT 'active', device_id TEXT, FOREIGN KEY(user_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS webhook_events(event_id TEXT PRIMARY KEY, received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS desktop_launch_tokens(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at_ms INTEGER NOT NULL, used_at_ms INTEGER, created_at_ms INTEGER NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS desktop_sessions(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, device_id TEXT, created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER, last_seen_at_ms INTEGER, FOREIGN KEY(user_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS interview_transcripts(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER NOT NULL, turn_count INTEGER NOT NULL DEFAULT 0, transcript_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS idx_usage_active ON usage_sessions(user_id,status); CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id,id DESC);
    CREATE INDEX IF NOT EXISTS idx_interview_transcripts_user ON interview_transcripts(user_id,ended_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_launch_token_hash ON desktop_launch_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_desktop_session_user ON desktop_sessions(user_id,revoked_at_ms);
  `);
  const jwtSecret = String(process.env.JWT_SECRET || '');
  if (jwtSecret.length < 32) console.warn('[COMMERCE] JWT_SECRET must be at least 32 characters in production.');
  const secret = jwtSecret || crypto.randomBytes(48).toString('hex');
  const planSeconds = Math.max(60, Number(process.env.PLAN_CREDITS_MINUTES || 60) * 60);
  const planPaise = Math.max(100, Number(process.env.PLAN_PRICE_PAISE || 59900));

  // PhonePe Business Payment Gateway (Standard Checkout v2).
  // Kept entirely on the commerce/control plane so interview/STT/RAG/LLM latency paths are unchanged.
  const phonePeEnv = String(process.env.PHONEPE_ENV || 'sandbox').trim().toLowerCase();
  const phonePeProduction = phonePeEnv === 'production' || phonePeEnv === 'prod' || phonePeEnv === 'live';
  const phonePeClientId = String(process.env.PHONEPE_CLIENT_ID || '').trim();
  const phonePeClientSecret = String(process.env.PHONEPE_CLIENT_SECRET || '').trim();
  const phonePeClientVersion = String(process.env.PHONEPE_CLIENT_VERSION || '1').trim();
  const phonePeWebhookUsername = String(process.env.PHONEPE_WEBHOOK_USERNAME || '').trim();
  const phonePeWebhookPassword = String(process.env.PHONEPE_WEBHOOK_PASSWORD || '').trim();
  const phonePeOAuthBase = phonePeProduction ? 'https://api.phonepe.com/apis/identity-manager' : 'https://api-preprod.phonepe.com/apis/pg-sandbox';
  const phonePePgBase = phonePeProduction ? 'https://api.phonepe.com/apis/pg' : 'https://api-preprod.phonepe.com/apis/pg-sandbox';
  let phonePeTokenCache = { token:'', expiresAtMs:0 };

  const phonePeConfigured = () => Boolean(phonePeClientId && phonePeClientSecret && phonePeClientVersion);
  const safeJson = async response => {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch (_) { return { message:text }; }
  };
  const phonePeError = (data, fallback) => String(data?.message || data?.error_description || data?.error || data?.code || fallback);
  async function phonePeAccessToken() {
    const now=Date.now();
    if (phonePeTokenCache.token && phonePeTokenCache.expiresAtMs > now + 30000) return phonePeTokenCache.token;
    if (!phonePeConfigured()) throw new Error('PhonePe payments are not configured');
    const form=new URLSearchParams({
      client_id:phonePeClientId,
      client_version:phonePeClientVersion,
      client_secret:phonePeClientSecret,
      grant_type:'client_credentials'
    });
    const response=await fetch(`${phonePeOAuthBase}/v1/oauth/token`,{
      method:'POST',
      headers:{'content-type':'application/x-www-form-urlencoded'},
      body:form.toString()
    });
    const data=await safeJson(response);
    if(!response.ok || !data.access_token) throw new Error(phonePeError(data,'Could not authenticate with PhonePe'));
    const expiresAtRaw=Number(data.expires_at || data.expiresAt || 0);
    const expiresInRaw=Number(data.expires_in || data.expiresIn || 0);
    const expiresAtMs=expiresAtRaw
      ? (expiresAtRaw > 100000000000 ? expiresAtRaw : expiresAtRaw * 1000)
      : now + Math.max(60, expiresInRaw || 300) * 1000;
    phonePeTokenCache={token:String(data.access_token),expiresAtMs};
    return phonePeTokenCache.token;
  }
  async function phonePeRequest(pathname,{method='GET',body}={}) {
    const run=async token => {
      const response=await fetch(`${phonePePgBase}${pathname}`,{
        method,
        headers:{'content-type':'application/json','authorization':`O-Bearer ${token}`},
        ...(body===undefined?{}:{body:JSON.stringify(body)})
      });
      return {response,data:await safeJson(response)};
    };
    let token=await phonePeAccessToken();
    let result=await run(token);
    if(result.response.status===401){
      phonePeTokenCache={token:'',expiresAtMs:0};
      token=await phonePeAccessToken();
      result=await run(token);
    }
    if(!result.response.ok) throw new Error(phonePeError(result.data,`PhonePe request failed (${result.response.status})`));
    return result.data;
  }

  const emailOf = v => String(v || '').trim().toLowerCase();
  const publicUser = u => ({ id:u.id, email:u.email, name:u.name, role:u.role, status:u.status, remainingSeconds:u.credit_seconds });
  const sign = u => jwt.sign({sub:u.id,email:u.email,role:u.role}, secret, {expiresIn:'7d',issuer:'topper'});
  const launchTtlMs = Math.max(30, Number(process.env.LAUNCH_TOKEN_TTL_SECONDS || 120)) * 1000;
  const desktopSessionDays = Math.max(1, Number(process.env.DESKTOP_SESSION_TTL_DAYS || 30));
  const installerUrl = String(process.env.DESKTOP_INSTALLER_URL || 'https://github.com/shivanew-hadoop/topper-downloads/releases/latest/download/Topper-Setup.exe');
  const tokenHash = token => crypto.createHash('sha256').update(String(token || '')).digest('hex');
  const desktopSign = (u, sessionId) => jwt.sign({sub:u.id,email:u.email,sid:sessionId,type:'desktop'}, secret, {expiresIn:`${desktopSessionDays}d`,issuer:'topper-desktop',audience:'topper-electron'});
  const auth = (role) => (req,res,next) => { try { const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,''); const p=jwt.verify(token,secret,{issuer:'topper'}); const u=db.prepare('SELECT * FROM users WHERE id=?').get(p.sub); if(!u||u.status!=='active'||(role&&u.role!==role)) return res.status(403).json({ok:false,error:'Access denied'}); req.authUser=u; next(); } catch (_) { res.status(401).json({ok:false,error:'Please log in again'}); } };
  const settle = db.transaction((sessionId, now=Date.now()) => {
    const s=db.prepare("SELECT * FROM usage_sessions WHERE id=? AND status='active'").get(sessionId); if(!s) return null;
    const u=db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id); if(!u) return null;
    const elapsed=Math.max(0,Math.floor((now-s.last_billed_at_ms)/1000)); const debit=Math.min(elapsed,u.credit_seconds);
    if(debit){ db.prepare('UPDATE users SET credit_seconds=credit_seconds-? WHERE id=?').run(debit,u.id); const updated=db.prepare("UPDATE credit_ledger SET delta_seconds=delta_seconds-?,created_at=CURRENT_TIMESTAMP WHERE user_id=? AND reason='usage' AND reference=?").run(debit,u.id,s.id); if(!updated.changes)db.prepare("INSERT INTO credit_ledger(user_id,delta_seconds,reason,reference) VALUES(?,?,'usage',?)").run(u.id,-debit,s.id); }
    const remaining=u.credit_seconds-debit, billedAt=s.last_billed_at_ms+debit*1000;
    if(remaining<=0){ db.prepare("UPDATE usage_sessions SET last_billed_at_ms=?,ended_at_ms=?,status='exhausted' WHERE id=?").run(billedAt,now,s.id); }
    else db.prepare('UPDATE usage_sessions SET last_billed_at_ms=? WHERE id=?').run(billedAt,s.id);
    return {sessionId:s.id,remainingSeconds:remaining,status:remaining<=0?'exhausted':'active',serverNow:now};
  });
  const credit = db.transaction((userId,seconds,reason,reference) => { const u=db.prepare('SELECT credit_seconds FROM users WHERE id=?').get(userId);if(!u)throw new Error('User not found');const applied=Math.max(-u.credit_seconds,Math.trunc(seconds));db.prepare('UPDATE users SET credit_seconds=credit_seconds+? WHERE id=?').run(applied,userId);db.prepare('INSERT INTO credit_ledger(user_id,delta_seconds,reason,reference) VALUES(?,?,?,?)').run(userId,applied,reason,reference||null); });

  const cleanTranscriptText = (value, max=14000) => String(value || '').replace(/\r/g,'').replace(/\u0000/g,'').trim().slice(0,max);
  const cleanTurn = raw => ({
    question:cleanTranscriptText(raw?.question,4000),
    answer:cleanTranscriptText(raw?.answer,14000),
    askedAt:Number(raw?.askedAt) || Date.now(),
    answeredAt:Number(raw?.answeredAt) || Number(raw?.askedAt) || Date.now()
  });
  const serializeTranscript = rawTurns => {
    const turns=(Array.isArray(rawTurns)?rawTurns:[]).slice(0,120).map(cleanTurn).filter(turn=>turn.question&&turn.answer);
    if(!turns.length)throw new Error('No completed interview questions to save');
    return turns;
  };
  const saveTranscript = db.transaction((userId,startedAt,endedAt,turns) => {
    const id=crypto.randomUUID();
    db.prepare('INSERT INTO interview_transcripts(id,user_id,started_at_ms,ended_at_ms,turn_count,transcript_json) VALUES(?,?,?,?,?,?)')
      .run(id,userId,startedAt,endedAt,turns.length,JSON.stringify(turns));
    db.prepare(`DELETE FROM interview_transcripts
      WHERE user_id=? AND id NOT IN (
        SELECT id FROM interview_transcripts WHERE user_id=? ORDER BY ended_at_ms DESC, created_at DESC LIMIT 3
      )`).run(userId,userId);
    return id;
  });
  const transcriptRows = userId => db.prepare('SELECT id,started_at_ms,ended_at_ms,turn_count,transcript_json,created_at FROM interview_transcripts WHERE user_id=? ORDER BY ended_at_ms DESC,created_at DESC LIMIT 3').all(userId)
    .map(row=>{let turns=[];try{turns=JSON.parse(row.transcript_json)||[]}catch(_){}return {id:row.id,startedAt:row.started_at_ms,endedAt:row.ended_at_ms,turnCount:row.turn_count,createdAt:row.created_at,turns};});

  function pdfSafe(value){
    return String(value??'')
      .replace(/[\u2018\u2019]/g,"'")
      .replace(/[\u201C\u201D]/g,'"')
      .replace(/[\u2013\u2014]/g,'-')
      .replace(/\u2026/g,'...')
      .replace(/\u2022/g,'-')
      .replace(/₹/g,'Rs. ')
      .normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[^\x09\x0A\x0D\x20-\x7E]/g,'?');
  }
  function wrapPdfLine(text,width=92){
    const source=pdfSafe(text).replace(/\t/g,'  ');
    const lines=[];
    for(const paragraph of source.split('\n')){
      const words=paragraph.trim().split(/\s+/).filter(Boolean);
      if(!words.length){lines.push('');continue;}
      let line='';
      for(const word of words){
        if(word.length>width){
          if(line){lines.push(line);line='';}
          for(let i=0;i<word.length;i+=width)lines.push(word.slice(i,i+width));
          continue;
        }
        const candidate=line?`${line} ${word}`:word;
        if(candidate.length>width){lines.push(line);line=word;}else line=candidate;
      }
      if(line)lines.push(line);
    }
    return lines;
  }
  function buildTranscriptPdf(session,user){
    const dateText=new Date(session.endedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'});
    const lines=['TOPPER INTERVIEW TRANSCRIPT',`Account: ${pdfSafe(user.email)}`,`Session: ${pdfSafe(dateText)}`,`Questions: ${session.turnCount}`,''];
    const stamp=ms=>new Date(Number(ms)||Date.now()).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',second:'2-digit'});
    session.turns.forEach((turn,index)=>{
      lines.push(`Q${index+1}  [${stamp(turn.askedAt)}]`);
      lines.push(...wrapPdfLine(turn.question));
      lines.push('');
      lines.push(`Answer  [${stamp(turn.answeredAt)}]`);
      lines.push(...wrapPdfLine(turn.answer));
      lines.push('');
      lines.push('............................................................................................');
      lines.push('');
    });
    const perPage=55,pages=[];
    for(let i=0;i<lines.length;i+=perPage)pages.push(lines.slice(i,i+perPage));
    if(!pages.length)pages.push(['TOPPER INTERVIEW TRANSCRIPT','No transcript content.']);
    const objects=[];
    const add=body=>{objects.push(body);return objects.length;};
    const catalogId=add('');
    const pagesId=add('');
    const fontId=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const pageIds=[];
    const escPdf=t=>pdfSafe(t).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
    for(const pageLines of pages){
      const stream=['BT','/F1 9 Tf','48 800 Td','12 TL'];
      for(const line of pageLines){stream.push(`(${escPdf(line)}) Tj`,'T*');}
      stream.push('ET');
      const content=stream.join('\n');
      const contentId=add(`<< /Length ${Buffer.byteLength(content,'latin1')} >>\nstream\n${content}\nendstream`);
      const pageId=add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
      pageIds.push(pageId);
    }
    objects[catalogId-1]=`<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId-1]=`<< /Type /Pages /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    let pdf='%PDF-1.4\n%Topper\n',offsets=[0];
    objects.forEach((body,i)=>{offsets[i+1]=Buffer.byteLength(pdf,'latin1');pdf+=`${i+1} 0 obj\n${body}\nendobj\n`;});
    const xref=Buffer.byteLength(pdf,'latin1');
    pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
    for(let i=1;i<=objects.length;i++)pdf+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
    pdf+=`trailer\n<< /Size ${objects.length+1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(pdf,'latin1');
  }

  const adminEmail = emailOf(process.env.ADMIN_EMAIL);
const adminPassword = String(process.env.ADMIN_PASSWORD || '');

if (adminEmail && adminPassword) {
  const passwordHash = bcrypt.hashSync(adminPassword, 12);
  const existingAdmin = db.prepare(
    'SELECT id FROM users WHERE email = ?'
  ).get(adminEmail);

  if (existingAdmin) {
    db.prepare(`
      UPDATE users
      SET role = 'admin',
          status = 'active',
          password_hash = ?
      WHERE id = ?
    `).run(passwordHash, existingAdmin.id);
  } else {
    db.prepare(`
      INSERT INTO users(email, password_hash, name, role, status)
      VALUES (?, ?, 'Administrator', 'admin', 'active')
    `).run(adminEmail, passwordHash);
  }
}

  const express=require('express');
  app.use('/portal',express.static(publicDir,{extensions:['html']}));
  app.use('/',express.static(publicDir,{extensions:['html']}));
  app.post('/api/auth/register',(req,res)=>{ try { const email=emailOf(req.body.email), password=String(req.body.password||''); if(!/^\S+@\S+\.\S+$/.test(email)||password.length<8)return res.status(400).json({ok:false,error:'Use a valid email and an 8+ character password'}); const info=db.prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?)').run(email,bcrypt.hashSync(password,12),String(req.body.name||'').trim().slice(0,80)); const u=db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid); res.json({ok:true,token:sign(u),user:publicUser(u)}); }catch(e){res.status(409).json({ok:false,error:'Email is already registered'});} });
  app.post('/api/auth/login',(req,res)=>{ const u=db.prepare('SELECT * FROM users WHERE email=?').get(emailOf(req.body.email)); if(!u||!bcrypt.compareSync(String(req.body.password||''),u.password_hash)||u.status!=='active')return res.status(401).json({ok:false,error:'Invalid email or password'}); res.json({ok:true,token:sign(u),user:publicUser(u)}); });
  app.get('/api/account',auth(),(req,res)=>{
    const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.authUser.id);
    const orders=db.prepare('SELECT provider_order_id,provider_payment_id,amount_paise,credits_seconds,status,created_at,paid_at FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 50').all(u.id);
    const adjustments=db.prepare("SELECT id sort_id,delta_seconds,reason,reference,created_at FROM credit_ledger WHERE user_id=? AND reason!='usage' ORDER BY id DESC LIMIT 100").all(u.id);
    const usage=db.prepare("SELECT MAX(id) sort_id,SUM(delta_seconds) delta_seconds,'usage' reason,reference,MAX(created_at) created_at FROM credit_ledger WHERE user_id=? AND reason='usage' GROUP BY reference ORDER BY sort_id DESC LIMIT 100").all(u.id);
    const ledger=[...adjustments,...usage].sort((a,b)=>b.sort_id-a.sort_id).slice(0,100).map(({sort_id,...row})=>row);
    res.json({ok:true,user:publicUser(u),orders,ledger,plan:{pricePaise:planPaise,creditsSeconds:planSeconds,paymentProvider:'phonepe'}});
  });
  app.post('/api/desktop/launch-token',auth(),(req,res)=>{
    const now=Date.now(), raw=crypto.randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM desktop_launch_tokens WHERE user_id=? AND used_at_ms IS NULL').run(req.authUser.id);
    db.prepare('DELETE FROM desktop_launch_tokens WHERE expires_at_ms<? OR used_at_ms IS NOT NULL').run(now-86400000);
    db.prepare('INSERT INTO desktop_launch_tokens(user_id,token_hash,expires_at_ms,created_at_ms) VALUES(?,?,?,?)').run(req.authUser.id,tokenHash(raw),now+launchTtlMs,now);
    res.set('Cache-Control','no-store').json({ok:true,launchUrl:`topper://launch?token=${encodeURIComponent(raw)}`,expiresIn:Math.round(launchTtlMs/1000),installerUrl});
  });
  const exchangeLaunchToken=db.transaction((raw,deviceId)=>{
    const now=Date.now(), hash=tokenHash(raw);
    const claimed=db.prepare('UPDATE desktop_launch_tokens SET used_at_ms=? WHERE token_hash=? AND used_at_ms IS NULL AND expires_at_ms>?').run(now,hash,now);
    if(claimed.changes!==1)return null;
    const row=db.prepare('SELECT u.* FROM desktop_launch_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=?').get(hash);
    if(!row||row.status!=='active')return null;
    const sessionId=crypto.randomUUID(), expiresAt=now+desktopSessionDays*86400000;
    db.prepare('INSERT INTO desktop_sessions(id,user_id,device_id,created_at_ms,expires_at_ms,last_seen_at_ms) VALUES(?,?,?,?,?,?)').run(sessionId,row.id,String(deviceId||'').slice(0,160),now,expiresAt,now);
    return {user:row,sessionId,expiresAt};
  });
  app.post('/api/desktop/exchange',(req,res)=>{
    const raw=String(req.body?.token||'');
    if(raw.length<32||raw.length>200)return res.status(401).json({ok:false,error:'Launch link is invalid or expired. Please launch Topper again from the portal.'});
    const result=exchangeLaunchToken(raw,req.body?.deviceId);
    if(!result)return res.status(401).json({ok:false,error:'Launch link is invalid or expired. Please launch Topper again from the portal.'});
    res.set('Cache-Control','no-store').json({ok:true,accessToken:desktopSign(result.user,result.sessionId),expiresAt:result.expiresAt,account:publicUser(result.user)});
  });
  const desktopAuth=(req,res,next)=>{try{const raw=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const p=jwt.verify(raw,secret,{issuer:'topper-desktop',audience:'topper-electron'});if(p.type!=='desktop')throw new Error('wrong token');const s=db.prepare('SELECT * FROM desktop_sessions WHERE id=? AND user_id=? AND revoked_at_ms IS NULL AND expires_at_ms>?').get(p.sid,p.sub,Date.now());const u=s&&db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(p.sub);if(!u)throw new Error('inactive session');db.prepare('UPDATE desktop_sessions SET last_seen_at_ms=? WHERE id=?').run(Date.now(),s.id);req.desktopUser=u;req.desktopSession=s;next();}catch(_){res.status(401).json({ok:false,error:'Please launch Topper again from the portal.'});}};
  const desktopUsageAuth=(req,res,next)=>{if(req.headers.authorization)return desktopAuth(req,res,next);if(String(process.env.REQUIRE_DESKTOP_AUTH||'false').toLowerCase()==='true')return res.status(401).json({ok:false,error:'Please update and launch Topper from the portal.'});const email=emailOf(req.body?.email);let u=email?db.prepare("SELECT * FROM users WHERE email=? AND status='active'").get(email):null;if(!u&&req.body?.sessionId)u=db.prepare("SELECT u.* FROM usage_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND u.status='active'").get(String(req.body.sessionId));if(!u)return res.status(401).json({ok:false,error:'Invalid license'});req.desktopUser=u;next();};
  app.get('/api/desktop/account',desktopAuth,(req,res)=>res.set('Cache-Control','no-store').json({ok:true,account:publicUser(req.desktopUser)}));
  app.post('/api/desktop/interview-transcripts',desktopAuth,(req,res)=>{
    try{
      const turns=serializeTranscript(req.body?.turns);
      const endedAt=Math.min(Date.now()+60000,Math.max(1,Number(req.body?.endedAt)||Date.now()));
      const startedAt=Math.max(1,Math.min(endedAt,Number(req.body?.startedAt)||endedAt));
      const transcriptId=saveTranscript(req.desktopUser.id,startedAt,endedAt,turns);
      res.set('Cache-Control','no-store').json({ok:true,transcriptId,retained:Math.min(3,transcriptRows(req.desktopUser.id).length)});
    }catch(e){res.status(400).json({ok:false,error:e.message||'Could not save interview transcript'});}
  });
  app.get('/api/interview-transcripts',auth(),(req,res)=>res.set('Cache-Control','no-store').json({ok:true,sessions:transcriptRows(req.authUser.id)}));
  app.get('/api/interview-transcripts/:id/pdf',auth(),(req,res)=>{
    const row=db.prepare('SELECT id,started_at_ms,ended_at_ms,turn_count,transcript_json FROM interview_transcripts WHERE id=? AND user_id=?').get(String(req.params.id||''),req.authUser.id);
    if(!row)return res.status(404).json({ok:false,error:'Interview transcript not found'});
    let turns=[];try{turns=JSON.parse(row.transcript_json)||[]}catch(_){}
    const session={id:row.id,startedAt:row.started_at_ms,endedAt:row.ended_at_ms,turnCount:row.turn_count,turns};
    const pdf=buildTranscriptPdf(session,req.authUser);
    const day=new Date(session.endedAt).toISOString().slice(0,10);
    res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="Topper-Interview-${day}.pdf"`,'Cache-Control':'no-store','Content-Length':String(pdf.length)});
    res.end(pdf);
  });
  const publicBaseFor = req => {
    const configured=String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/,'');
    if(configured)return configured;
    const proto=String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    return `${proto}://${req.get('host')}`;
  };
  const findPhonePeTransactionId = status => {
    const details=Array.isArray(status?.paymentDetails)?status.paymentDetails:[];
    const completed=details.find(item=>String(item?.state||'').toUpperCase()==='COMPLETED') || details[details.length-1];
    return String(completed?.transactionId || status?.orderId || status?.transactionId || '');
  };
  const applyPhonePeStatus = db.transaction((order,status) => {
    const state=String(status?.state || '').toUpperCase();
    if(state==='COMPLETED'){
      if(Number(status?.amount || 0) && Number(status.amount)!==Number(order.amount_paise)) throw new Error('PhonePe amount mismatch');
      if(order.status!=='paid'){
        const paymentId=findPhonePeTransactionId(status) || `phonepe:${order.provider_order_id}`;
        db.prepare("UPDATE orders SET status='paid',provider_payment_id=?,paid_at=CURRENT_TIMESTAMP WHERE id=?").run(paymentId,order.id);
        credit(order.user_id,order.credits_seconds,'purchase',paymentId);
      }
      return 'paid';
    }
    if(state==='FAILED' || state==='EXPIRED'){
      if(order.status!=='paid')db.prepare('UPDATE orders SET status=? WHERE id=?').run(state.toLowerCase(),order.id);
      return state.toLowerCase();
    }
    return 'pending';
  });
  async function refreshPhonePeOrder(order) {
    const status=await phonePeRequest(`/checkout/v2/order/${encodeURIComponent(order.provider_order_id)}/status`);
    const localStatus=applyPhonePeStatus(order,status);
    return {status,localStatus};
  }

  app.post('/api/payments/order',auth(),async(req,res)=>{
    try{
      if(!phonePeConfigured())throw new Error('PhonePe payments are not configured');
      const merchantOrderId=`topper_${req.authUser.id}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const redirectUrl=`${publicBaseFor(req)}/?phonepeOrder=${encodeURIComponent(merchantOrderId)}`;
      const payload={
        merchantOrderId,
        amount:planPaise,
        expireAfter:1200,
        metaInfo:{udf1:String(req.authUser.id),udf2:String(planSeconds),udf3:'topper_interview_credits'},
        paymentFlow:{type:'PG_CHECKOUT',message:'Topper interview credits',merchantUrls:{redirectUrl}}
      };
      const payment=await phonePeRequest('/checkout/v2/pay',{method:'POST',body:payload});
      const checkoutUrl=String(payment?.redirectUrl || '');
      if(!checkoutUrl)throw new Error('PhonePe did not return a checkout URL');
      db.prepare('INSERT INTO orders(user_id,provider_order_id,amount_paise,credits_seconds) VALUES(?,?,?,?)').run(req.authUser.id,merchantOrderId,planPaise,planSeconds);
      res.json({ok:true,merchantOrderId,checkoutUrl,creditsSeconds:planSeconds,provider:'phonepe'});
    }catch(e){res.status(502).json({ok:false,error:e.message});}
  });

  // Browser completion is never trusted by itself. Server-side status from PhonePe is authoritative.
  app.post('/api/payments/verify',auth(),async(req,res)=>{
    try{
      const merchantOrderId=String(req.body?.merchantOrderId || '').trim();
      const order=db.prepare('SELECT * FROM orders WHERE provider_order_id=? AND user_id=?').get(merchantOrderId,req.authUser.id);
      if(!order)return res.status(404).json({ok:false,error:'Payment order not found'});
      const result=await refreshPhonePeOrder(order);
      const refreshed=db.prepare('SELECT status,provider_payment_id,paid_at FROM orders WHERE id=?').get(order.id);
      res.json({ok:result.localStatus==='paid',status:result.localStatus,order:refreshed});
    }catch(e){res.status(502).json({ok:false,error:e.message});}
  });

  // PhonePe callback authentication is SHA256(username:password), compared in constant time.
  // The callback only triggers an authoritative Order Status lookup before credits are granted.
  app.post('/api/payments/webhook',async(req,res)=>{
    try{
      if(!phonePeWebhookUsername || !phonePeWebhookPassword)return res.status(503).json({ok:false,error:'PhonePe webhook authentication is not configured'});
      const authorization=String(req.headers.authorization || '').trim();
      const expected=crypto.createHash('sha256').update(`${phonePeWebhookUsername}:${phonePeWebhookPassword}`).digest('hex');
      const a=Buffer.from(authorization), b=Buffer.from(expected);
      if(a.length!==b.length || !crypto.timingSafeEqual(a,b))return res.status(401).json({ok:false,error:'Invalid PhonePe callback authorization'});
      const raw=req.rawBody || Buffer.from(JSON.stringify(req.body||{}));
      const eventId=crypto.createHash('sha256').update(raw).digest('hex');
      if(db.prepare('SELECT 1 FROM webhook_events WHERE event_id=?').get(eventId))return res.json({ok:true,duplicate:true});
      const payload=req.body?.payload || req.body?.data || {};
      const merchantOrderId=String(payload.merchantOrderId || '').trim();
      if(merchantOrderId){
        const order=db.prepare('SELECT * FROM orders WHERE provider_order_id=?').get(merchantOrderId);
        if(order)await refreshPhonePeOrder(order);
      }
      db.prepare('INSERT INTO webhook_events(event_id) VALUES(?)').run(eventId);
      res.json({ok:true});
    }catch(e){
      console.error('[PHONEPE webhook]',e.message);
      res.status(502).json({ok:false,error:'PhonePe callback could not be processed'});
    }
  });
  app.post('/api/usage/start',desktopUsageAuth,(req,res)=>{ const device=String(req.body.deviceId||'').slice(0,120), u=req.desktopUser; if(u.credit_seconds<=0)return res.status(402).json({ok:false,error:'No credits remaining',remainingSeconds:0}); const old=db.prepare("SELECT id,device_id,last_billed_at_ms FROM usage_sessions WHERE user_id=? AND status='active'").get(u.id); if(old){const now=Date.now(),fresh=now-old.last_billed_at_ms<15000;if(fresh&&old.device_id!==device)return res.status(409).json({ok:false,error:'This account is already listening on another device'});if(fresh){const state=settle(old.id);return res.json({ok:true,...state});}settle(old.id,old.last_billed_at_ms+15000);db.prepare("UPDATE usage_sessions SET status='abandoned',ended_at_ms=? WHERE id=? AND status='active'").run(now,old.id);} const refreshed=db.prepare('SELECT credit_seconds FROM users WHERE id=?').get(u.id);if(!refreshed||refreshed.credit_seconds<=0)return res.status(402).json({ok:false,error:'No credits remaining',remainingSeconds:0});const id=crypto.randomUUID(),now=Date.now();db.prepare('INSERT INTO usage_sessions(id,user_id,started_at_ms,last_billed_at_ms,device_id) VALUES(?,?,?,?,?)').run(id,u.id,now,now,device);res.json({ok:true,sessionId:id,remainingSeconds:refreshed.credit_seconds,status:'active',serverNow:now}); });
  app.post('/api/usage/heartbeat',desktopUsageAuth,(req,res)=>{const owned=db.prepare('SELECT 1 FROM usage_sessions WHERE id=? AND user_id=?').get(String(req.body.sessionId||''),req.desktopUser.id);if(!owned)return res.status(404).json({ok:false,error:'Usage session is not active'});const state=settle(String(req.body.sessionId||''));if(!state)return res.status(404).json({ok:false,error:'Usage session is not active'});res.status(state.status==='exhausted'?402:200).json({ok:state.status==='active',...state});});
  app.post('/api/usage/stop',desktopUsageAuth,(req,res)=>{const id=String(req.body.sessionId||'');const owned=db.prepare('SELECT 1 FROM usage_sessions WHERE id=? AND user_id=?').get(id,req.desktopUser.id);if(!owned)return res.json({ok:true});const state=settle(id);if(state)db.prepare("UPDATE usage_sessions SET status='stopped',ended_at_ms=? WHERE id=? AND status='active'").run(Date.now(),state.sessionId);res.json({ok:true,...state});});
  app.get('/api/admin/dashboard',auth('admin'),(req,res)=>{const stats=db.prepare("SELECT COUNT(*) users,SUM(CASE WHEN credit_seconds>0 THEN 1 ELSE 0 END) credited,SUM(CASE WHEN credit_seconds=0 THEN 1 ELSE 0 END) pending FROM users WHERE role='user'").get();const active=db.prepare("SELECT COUNT(*) count FROM usage_sessions WHERE status='active'").get().count;const users=db.prepare("SELECT id,email,name,status,credit_seconds,created_at FROM users WHERE role='user' ORDER BY id DESC LIMIT 500").all();res.json({ok:true,stats:{...stats,active},users});});
  app.post('/api/admin/credits',auth('admin'),(req,res)=>{const u=db.prepare('SELECT * FROM users WHERE email=?').get(emailOf(req.body.email));const minutes=Number(req.body.minutes);if(!u||!Number.isFinite(minutes)||minutes===0)return res.status(400).json({ok:false,error:'Valid email and non-zero minutes are required'});credit(u.id,Math.trunc(minutes*60),'admin_adjustment',`admin:${req.authUser.email}`);res.json({ok:true,user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id))});});

  return { isLicensed(email){ const u=db.prepare("SELECT * FROM users WHERE email=? AND status='active'").get(emailOf(email)); return u&&u.credit_seconds>0?{ok:true,user:publicUser(u)}:{ok:false,reason:u?'No credits remaining':'Email not found'}; } };
};
