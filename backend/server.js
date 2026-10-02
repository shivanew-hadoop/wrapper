require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
let WordExtractor = null;
try { WordExtractor = require('word-extractor'); } catch (_) {}

const PORT = Number(process.env.PORT || 8080);
const DEEPGRAM_API_KEY = String(process.env.DEEPGRAM_API_KEY || '').trim();
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const CEREBRAS_API_KEY = String(process.env.CEREBRAS_API_KEY || '').trim();
// Cerebras selection is intentionally pinned to OpenAI GPT-OSS 120B.
// Do not allow an old Railway CEREBRAS_MODEL value to silently route this option to another model.
const CEREBRAS_MODEL = 'gpt-oss-120b';
const CEREBRAS_REASONING_EFFORT = ['low','medium','high'].includes(String(process.env.CEREBRAS_REASONING_EFFORT || 'medium').trim().toLowerCase())
  ? String(process.env.CEREBRAS_REASONING_EFFORT || 'medium').trim().toLowerCase()
  : 'medium';
const CEREBRAS_API_BASE = String(process.env.CEREBRAS_API_BASE || 'https://api.cerebras.ai/v1').trim().replace(/\/+$/, '');
const CEREBRAS_SERVICE_TIER = String(process.env.CEREBRAS_SERVICE_TIER || 'default').trim();
const HYBRID_CEREBRAS_REASONING_EFFORT = String(process.env.HYBRID_CEREBRAS_REASONING_EFFORT || 'medium').trim().toLowerCase();
const HYBRID_SOL_UPGRADE_TIMEOUT_MS = Math.max(4000, Number(process.env.HYBRID_SOL_UPGRADE_TIMEOUT_MS || 18000));
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || 'gpt-5.6-sol').trim();
const OPENAI_TERRA_MODEL = String(process.env.OPENAI_TERRA_MODEL || 'gpt-5.6-terra').trim();
const OPENAI_LUNA_MODEL = String(process.env.OPENAI_LUNA_MODEL || 'gpt-5.6-luna').trim();
const OPENAI_PROFILE_MODEL = String(process.env.OPENAI_PROFILE_MODEL || OPENAI_MODEL).trim();
const OPENAI_VISION_MODEL = String(process.env.OPENAI_VISION_MODEL || OPENAI_MODEL).trim();
// One OpenAI Responses API path for text, profile generation and vision. The surrounding
// RAG/STT/Electron architecture is intentionally unchanged.
const LLM_DEFAULT_MODEL = OPENAI_MODEL;
const LLM_PROFILE_MODEL = OPENAI_PROFILE_MODEL;
const LLM_VISION_EXTRACT_MODEL = OPENAI_VISION_MODEL;
const LLM_ROUTING_ENABLED = false;
const LLM_REASONING_EFFORT = String(process.env.LLM_REASONING_EFFORT || 'low').trim();
const LLM_VERBOSITY = String(process.env.LLM_VERBOSITY || 'medium').trim();
const OPENAI_SERVICE_TIER_RAW = String(process.env.OPENAI_SERVICE_TIER || 'fast').trim().toLowerCase();
const OPENAI_SERVICE_TIER = new Set(['fast','priority','default','auto']).has(OPENAI_SERVICE_TIER_RAW)
  ? OPENAI_SERVICE_TIER_RAW
  : 'fast';
const EMBEDDING_MODEL = String(process.env.EMBEDDING_MODEL || 'text-embedding-3-small').trim();
const EMBEDDING_DIMENSIONS = Math.max(256, Number(process.env.EMBEDDING_DIMENSIONS || 512));
const MAX_CONTEXT_FILE_BYTES = 6 * 1024 * 1024;
const MAX_DOCUMENT_CHARS = 70000;
const MAX_HISTORY_TURNS = Math.max(2, Math.min(5, Number(process.env.MAX_HISTORY_TURNS || 3)));
const TOP_K = Math.max(3, Math.min(6, Number(process.env.RAG_TOP_K || 4)));
const LLM_FIRST_TOKEN_TIMEOUT_MS = Math.max(3000, Number(process.env.LLM_FIRST_TOKEN_TIMEOUT_MS || 5000));
const FAST_LEXICAL_THRESHOLD = Math.max(0.18, Math.min(0.95, Number(process.env.FAST_LEXICAL_THRESHOLD || 0.34)));

const DEEPGRAM_KEEPALIVE_MS = 5000;
const BACKEND_CLIENT_PING_MS = 15000;
const NO_SPEECH_KEEPALIVE_LIMIT_MS = 30 * 60 * 1000;
const SILENCE_PCM_KEEPALIVE_AFTER_MS = 8000;
const MAX_TRANSCRIPTION_SESSION_MS = 135 * 60 * 1000;
const SILENCE_PCM_100MS_16K_MONO = Buffer.alloc(16000 * 2 / 10);
const USERS_FILE = path.join(__dirname, 'users.json');
const DATA_DIR = String(process.env.DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR, { recursive:true });

// Per-process, per-user interview context. Nothing is persisted to disk always.
const interviewSessions = new Map();
const queryEmbeddingCache = new Map();
const retrievalResultCache = new Map();
const RETRIEVAL_RESULT_CACHE_MAX = 300;

if (!DEEPGRAM_API_KEY) console.warn('[BOOT] WARNING: DEEPGRAM_API_KEY missing');
else {
  console.log('[BOOT] DEEPGRAM_API_KEY present: true');
  console.log('[BOOT] DEEPGRAM_API_KEY length:', DEEPGRAM_API_KEY.length);
}
console.log('[BOOT] OPENAI_API_KEY present:', !!OPENAI_API_KEY, '(Sol + embeddings + vision)');
console.log('[BOOT] CEREBRAS_API_KEY present:', !!CEREBRAS_API_KEY, '| model:', CEREBRAS_MODEL);
console.log('[BOOT] LLM provider: OpenAI ->', LLM_DEFAULT_MODEL, '| profile:', LLM_PROFILE_MODEL, '| vision:', LLM_VISION_EXTRACT_MODEL, '| embedding:', EMBEDDING_MODEL, '| dims:', EMBEDDING_DIMENSIONS);
console.log('[BOOT] OpenAI service tier:', OPENAI_SERVICE_TIER, '| reasoning effort:', LLM_REASONING_EFFORT);

const app = express();
const allowedOrigins = new Set(String(process.env.CORS_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean));
app.use(cors({ origin:(origin,cb) => cb(null,!origin || allowedOrigins.size===0 || allowedOrigins.has(origin)) }));
app.use(express.json({ limit: '18mb', verify:(req,_res,buf) => { req.rawBody = Buffer.from(buf); } }));

let commerce = { isLicensed: () => ({ ok: true }) };
try {
  commerce = require('./commerce')({ app, dataDir:DATA_DIR, publicDir:path.join(__dirname, 'portal') });
} catch (_) {
  console.warn('[BOOT] commerce module not found or failed to load. Defaulting to open access.');
}

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (_) { return {}; }
}
function isLicenseValid(email) {
  const paid = commerce.isLicensed(email);
  if (paid.ok) return paid;
  if (String(process.env.LEGACY_LICENSE_FALLBACK || 'true').toLowerCase() !== 'true') return paid;
  const users = loadUsers();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const userKey = Object.keys(users).find(key => String(key).trim().toLowerCase() === normalizedEmail);
  const user = userKey ? users[userKey] : null;
  if (!user) return { ok:false, reason:'Email not found' };
  if (!user.active) return { ok:false, reason:'License inactive' };
  const today = new Date();
  const validTill = new Date(`${user.validTill}T23:59:59`);
  if (Number.isNaN(validTill.getTime()) || validTill < today) return { ok:false, reason:'License expired' };
  return { ok:true, user:{ email:normalizedEmail, name:user.name, plan:user.plan, validTill:user.validTill, active:user.active } };
}
function requireLicensedRequest(req, res) {
  const email = String(req.body?.email || req.query?.email || '').trim().toLowerCase();
  if (!email) { res.status(400).json({ ok:false, error:'email is required' }); return null; }
  const license = isLicenseValid(email);
  if (!license.ok) { res.status(401).json({ ok:false, error:license.reason || 'Invalid license' }); return null; }
  return email;
}
function normalizeText(text) {
  return String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function normalizeStructuredText(text) {
  return String(text||'').replace(/\r/g,'').replace(/[ \t]+$/gm,'').replace(/\n{4,}/g,'\n\n\n').trim();
}
function decodeUpload(file) {
  if (!file?.base64) return null;
  const buffer = Buffer.from(String(file.base64), 'base64');
  if (!buffer.length) throw new Error(`${file.name || 'Uploaded file'} is empty.`);
  if (buffer.length > MAX_CONTEXT_FILE_BYTES) throw new Error(`${file.name || 'Uploaded file'} exceeds 6 MB.`);
  return { buffer, name:String(file.name || ''), type:String(file.type || '') };
}
async function extractDocumentText(file) {
  const decoded = decodeUpload(file);
  if (!decoded) return '';
  const ext = path.extname(decoded.name).toLowerCase();
  const mime = decoded.type.toLowerCase();
  let text = '';

  if (ext === '.pdf' || mime.includes('pdf')) {
    const parsed = await pdfParse(decoded.buffer);
    text = parsed.text || '';
  } else if (ext === '.docx' || mime.includes('wordprocessingml')) {
    const parsed = await mammoth.extractRawText({ buffer:decoded.buffer });
    text = parsed.value || '';
  } else if (ext === '.doc' || mime === 'application/msword') {
    if (!WordExtractor) throw new Error('Legacy .doc support is not installed. Run npm install in backend once.');
    const extractor = new WordExtractor();
    const doc = await extractor.extract(decoded.buffer);
    text = doc.getBody() || '';
  } else if (ext === '.rtf' || mime.includes('rtf')) {
    text = decoded.buffer.toString('latin1')
      .replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\par[d]?\b/g, '\n')
      .replace(/\\tab\b/g, '\t')
      .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
      .replace(/[{}]/g, '');
  } else if (
    ['.txt','.md','.markdown','.csv','.tsv','.json','.xml','.html','.htm','.yaml','.yml','.log'].includes(ext) ||
    mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || !ext
  ) {
    text = decoded.buffer.toString('utf8');
    if (['.html','.htm','.xml'].includes(ext) || mime.includes('html') || mime.includes('xml')) {
      text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    }
  } else {
    const candidate = decoded.buffer.toString('utf8');
    const printable = (candidate.match(/[\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g) || []).length;
    if (candidate.length && printable / candidate.length > 0.82) text = candidate;
    else throw new Error(`Unsupported or binary file type: ${ext || decoded.type || 'unknown'}. Supported common formats include PDF, DOC, DOCX, RTF, TXT, MD, CSV, JSON, HTML, XML and YAML.`);
  }

  text = normalizeText(text).slice(0, MAX_DOCUMENT_CHARS);
  if (text.length < 30) throw new Error(`Could not extract enough text from ${decoded.name || 'document'}.`);
  return text;
}
function guessHeading(line) {
  const s = String(line || '').trim();
  if (!s || s.length > 80) return false;
  if (/^(summary|profile|skills|technical skills|experience|work experience|professional experience|projects?|education|certifications?|responsibilities|requirements|qualifications|preferred|about the role|job description|what you will do|must have|nice to have)\b/i.test(s)) return true;
  if (s.endsWith(':') && s.split(/\s+/).length <= 8) return true;
  if (s.length >= 4 && s === s.toUpperCase() && /[A-Z]/.test(s)) return true;
  return false;
}
function semanticChunks(text, source) {
  const lines = normalizeText(text).split('\n').map(x => x.trim()).filter(Boolean);
  const sections = [];
  let heading = source === 'resume' ? 'Resume' : 'Job Description';
  let buf = [];
  const flushSection = () => { if (buf.length) { sections.push({ heading, text:buf.join('\n') }); buf = []; } };
  for (const line of lines) {
    if (guessHeading(line)) { flushSection(); heading = line.replace(/:$/, ''); }
    else buf.push(line);
  }
  flushSection();
  if (!sections.length) sections.push({ heading, text:normalizeText(text) });

  const chunks = [];
  const target = 1200, overlap = 160;
  for (const section of sections) {
    const body = normalizeText(section.text);
    if (!body) continue;
    if (body.length <= target) { chunks.push({ source, section:section.heading, text:body }); continue; }
    let start = 0;
    while (start < body.length) {
      let end = Math.min(body.length, start + target);
      if (end < body.length) {
        const boundary = Math.max(body.lastIndexOf('. ', end), body.lastIndexOf('\n', end));
        if (boundary > start + 650) end = boundary + 1;
      }
      chunks.push({ source, section:section.heading, text:body.slice(start, end).trim() });
      if (end >= body.length) break;
      start = Math.max(start + 1, end - overlap);
    }
  }
  return chunks.filter(c => c.text.length >= 40).slice(0, 80);
}
function outputText(data) {
  return String(data?.output_text || '').trim() || (data?.output || []).flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('\n').trim();
}
async function openAIJson(url, body) {
  const response = await fetch(url, {
    method:'POST', headers:{'content-type':'application/json', authorization:`Bearer ${OPENAI_API_KEY}`}, body:JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI request failed (${response.status})`);
  return data;
}
function normalizedReasoningEffort(effort) {
  const value=String(effort||'low').trim().toLowerCase();
  return ['none','low','medium','high','xhigh','max'].includes(value) ? value : 'low';
}
function openAIResponseBody({model=LLM_DEFAULT_MODEL,instructions='',input='',effort=LLM_REASONING_EFFORT,maxTokens=420,verbosity=LLM_VERBOSITY,stream=false,responseFormat=null}) {
  const body={
    model,
    service_tier:OPENAI_SERVICE_TIER,
    instructions:String(instructions||''),
    input,
    reasoning:{effort:normalizedReasoningEffort(effort)},
    text:{verbosity:String(verbosity||'medium')},
    stream:!!stream
  };
  if(Number.isFinite(maxTokens)&&maxTokens>0)body.max_output_tokens=maxTokens;
  if(responseFormat)body.response_format=responseFormat;
  return body;
}
async function openAIResponseJson({model=LLM_DEFAULT_MODEL,instructions='',input='',effort=LLM_REASONING_EFFORT,maxTokens=420,verbosity=LLM_VERBOSITY,responseFormat=null}) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing on backend');
  return openAIJson('https://api.openai.com/v1/responses', openAIResponseBody({model,instructions,input,effort,maxTokens,verbosity,stream:false,responseFormat}));
}
function cerebrasOutputText(data) {
  return String(data?.choices?.[0]?.message?.content || '').trim();
}
function cerebrasReasoningEffort(effort=CEREBRAS_REASONING_EFFORT) {
  const value=String(effort||CEREBRAS_REASONING_EFFORT).trim().toLowerCase();
  return ['low','medium','high'].includes(value) ? value : CEREBRAS_REASONING_EFFORT;
}
function cerebrasChatBody({instructions='',input='',maxTokens=420,stream=false,effort=CEREBRAS_REASONING_EFFORT}) {
  const body={
    model:CEREBRAS_MODEL,
    messages:[
      {role:'developer',content:String(instructions||'')},
      {role:'user',content:typeof input==='string'?input:JSON.stringify(input)}
    ],
    reasoning_effort:cerebrasReasoningEffort(effort),
    stream:!!stream
  };
  if(Number.isFinite(maxTokens)&&maxTokens>0)body.max_completion_tokens=maxTokens;
  const serviceTier=String(CEREBRAS_SERVICE_TIER||'default').trim().toLowerCase();
  if(['default','auto','flex','priority'].includes(serviceTier)) body.service_tier=serviceTier;
  return body;
}
async function cerebrasJson({instructions='',input='',maxTokens=420,effort=CEREBRAS_REASONING_EFFORT}) {
  if (!CEREBRAS_API_KEY) throw new Error('CEREBRAS_API_KEY missing on backend');
  const response=await fetch(`${CEREBRAS_API_BASE}/chat/completions`,{
    method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${CEREBRAS_API_KEY}`},
    body:JSON.stringify(cerebrasChatBody({instructions,input,maxTokens,stream:false,effort}))
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data?.error?.message||`Cerebras request failed (${response.status})`);
  return data;
}
async function providerResponseJson({provider='openai',model=LLM_DEFAULT_MODEL,instructions='',input='',effort=LLM_REASONING_EFFORT,maxTokens=420,verbosity=LLM_VERBOSITY,responseFormat=null}) {
  if(provider==='cerebras') return cerebrasJson({instructions,input,maxTokens,effort});
  return openAIResponseJson({model,instructions,input,effort,maxTokens,verbosity,responseFormat});
}
function providerOutputText(provider,data){ return provider==='cerebras' ? cerebrasOutputText(data) : outputText(data); }
async function embedTexts(texts) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing on backend');
  const clean = texts.map(t => String(t || '').slice(0, 12000));
  const data = await openAIJson('https://api.openai.com/v1/embeddings', {
    model:EMBEDDING_MODEL, input:clean, encoding_format:'float', dimensions:EMBEDDING_DIMENSIONS
  });
  return (data.data || []).sort((a,b) => a.index - b.index).map(x => x.embedding);
}
async function embedQuery(text) {
  const key = normalizeText(text).toLowerCase().slice(0, 1200);
  if (queryEmbeddingCache.has(key)) return queryEmbeddingCache.get(key);
  const [embedding] = await embedTexts([key]);
  if (!embedding) throw new Error('Embedding API returned no vector');
  queryEmbeddingCache.set(key, embedding);
  if (queryEmbeddingCache.size > 200) queryEmbeddingCache.delete(queryEmbeddingCache.keys().next().value);
  return embedding;
}
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot=0, aa=0, bb=0;
  for (let i=0;i<a.length;i++) { dot += a[i]*b[i]; aa += a[i]*a[i]; bb += b[i]*b[i]; }
  return aa && bb ? dot / (Math.sqrt(aa) * Math.sqrt(bb)) : 0;
}
const STOP_WORDS = new Set('the a an and or to of in on for with is are was were be been being how what why when where which who do does did can could should would tell explain about me my your our this that these those from as at by it its'.split(' '));
function keywords(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z0-9+#.]{2,}/g)?.filter(x => !STOP_WORDS.has(x)) || []);
}
function keywordScore(querySet, chunkText) {
  if (!querySet.size) return 0;
  const chunkSet = keywords(chunkText);
  let hits = 0;
  for (const w of querySet) if (chunkSet.has(w)) hits++;
  return Math.min(1, hits / Math.max(2, Math.min(6, querySet.size)));
}

function lexicalRank(session, query) {
  const qk = keywords(query);
  return session.chunks.map(chunk => {
    const lexical = keywordScore(qk, `${chunk.section} ${chunk.text}`);
    const sourceBoost = chunk.source === 'resume' ? 0.03 : 0;
    return { ...chunk, score:lexical + sourceBoost, vector:0, lexical };
  }).sort((a,b) => b.score - a.score);
}
function canUseFastLexical(session, query) {
  if (!session?.chunks?.length) return false;
  const ranked = lexicalRank(session, query);
  const top = ranked[0]?.lexical || 0;
  const q = normalizeText(query).toLowerCase();
  const vocab = session.profile?.domainVocabulary || session.profile?.primarySkills || [];
  const exactCanonical = vocab.some(term => {
    const t = String(term || '').trim().toLowerCase();
    return t.length >= 3 && q.includes(t);
  });
  return exactCanonical || top >= FAST_LEXICAL_THRESHOLD;
}
function retrieveChunksLexical(session, query) {
  const ranked = lexicalRank(session, query);
  const selected = ranked.slice(0, TOP_K);
  if (session.chunks.some(c => c.source === 'jd') && !selected.some(c => c.source === 'jd')) {
    const jd = ranked.find(c => c.source === 'jd');
    if (jd && selected.length) selected[selected.length - 1] = jd;
  }
  return selected;
}

function editDistance(a, b) {
  a = String(a || '').toLowerCase(); b = String(b || '').toLowerCase();
  const row = Array.from({length:b.length + 1}, (_,i) => i);
  for (let i=1;i<=a.length;i++) {
    let prev = row[0]; row[0] = i;
    for (let j=1;j<=b.length;j++) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j-1] + 1, prev + (a[i-1] === b[j-1] ? 0 : 1));
      prev = old;
    }
  }
  return row[b.length];
}
function resolveCanonicalQuestion(session, question) {
  const profileVocab = session?.profile?.domainVocabulary || session?.profile?.primarySkills || [];
  const original = String(question || '');
  const replacements = [];
  let working = original;

  const technologyContext=normalizeText(`${(session?.profile?.primarySkills||[]).join(' ')} ${(session?.profile?.domainVocabulary||[]).join(' ')} ${(session?.turns||[]).slice(-3).map(t=>t.question).join(' ')}`).toLowerCase();

  const sqlJoinContext=/\bsql\b/.test(technologyContext) || /\bsql\b/i.test(working);
  if(sqlJoinContext && /\bjoints?\b/i.test(working)){
    working=working.replace(/\bjoints?\b/gi, match=>{
      const to='joins';
      replacements.push({from:match,to,distance:0,kind:'context-phrase'});
      return to;
    });
  }

  const playwrightFixtureContext=/\bplaywright\b/.test(technologyContext) || /\bfixtures?\b/.test(technologyContext);
  const explicitCustomFixtureStt=/\bcustom\s+fixer(?:s)?\b/i.test(working);
  if ((playwrightFixtureContext || explicitCustomFixtureStt) && explicitCustomFixtureStt) {
    working=working.replace(/\bcustom\s+fixer(?:s)?\b/gi, match=>{
      const to=/s\b/i.test(match)?'custom fixtures':'custom fixture';
      replacements.push({from:match,to,distance:0,kind:'context-phrase'});
      return to;
    });
  }
  if (playwrightFixtureContext || explicitCustomFixtureStt) {
    working=working.replace(/\b(?:user\s*name|username)\s+of\s+(custom\s+fixtures?)\b/gi, (match,fixture)=>{
      const to=`use of ${fixture}`;
      replacements.push({from:match,to,distance:0,kind:'context-phrase'});
      return to;
    });
  }
  if (/\bpython\b/.test(technologyContext) || /\b(?:ask|args?)\s+(?:and|&)\s+(?:quarks|kwargs?|k\s*wargs?)\b/i.test(working)) {
    working=working.replace(/\b(?:ask|arks?|args?)\s+(?:and|&)\s+(?:quarks|kwargs?|k\s*wargs?)\b/gi, match=>{
      replacements.push({from:match,to:'*args and **kwargs',distance:0,kind:'context-phrase'});
      return '*args and **kwargs';
    });
  }

  if (!profileVocab.length) return { corrected:working, replacements };
  const corrected = working.replace(/\b[A-Za-z][A-Za-z0-9+#.-]{1,}\b/g, token => {
    const cleanToken = token.toLowerCase().replace(/[^a-z0-9+#]/g, '');
    const techLike = /^[A-Z0-9+#.-]{2,}$/.test(token) || /[+#.]/.test(token) || token.length >= 5;
    if (!techLike) return token;
    let best = null;
    for (const termRaw of profileVocab) {
      const term = String(termRaw || '').trim();
      if (!term || /\s/.test(term)) continue;
      const cleanTerm = term.toLowerCase().replace(/[^a-z0-9+#]/g, '');
      if (cleanTerm.length < 3 || Math.abs(cleanTerm.length-cleanToken.length) > 3) continue;
      const d = editDistance(cleanToken, cleanTerm);
      const maxLen = Math.max(cleanToken.length, cleanTerm.length);
      const limit = maxLen >= 9 ? 3 : maxLen >= 5 ? 2 : 1;
      if (d <= limit && (!best || d < best.d)) best = {term, d};
    }
    if (best && best.term.toLowerCase() !== token.toLowerCase()) {
      replacements.push({from:token, to:best.term, distance:best.d});
      return best.term;
    }
    return token;
  });
  return { corrected, replacements };
}
function expandQuestionWithCanonicalTerms(session, question) {
  const resolved = resolveCanonicalQuestion(session, question);
  return resolved.replacements.length
    ? `${resolved.corrected}\nCanonical STT corrections already applied: ${resolved.replacements.map(r => `${r.from}->${r.to}`).join(', ')}`
    : resolved.corrected;
}
function retrieveChunks(session, queryEmbedding, query) {
  const qk = keywords(query);
  const ranked = session.chunks.map(chunk => {
    const vector = cosine(queryEmbedding, chunk.embedding);
    const lexical = keywordScore(qk, `${chunk.section} ${chunk.text}`);
    const sourceBoost = chunk.source === 'resume' ? 0.02 : 0;
    return { ...chunk, score:(0.75 * vector) + (0.23 * lexical) + sourceBoost, vector, lexical };
  }).sort((a,b) => b.score - a.score);
  const selected = ranked.slice(0, TOP_K);
  if (session.chunks.some(c => c.source === 'jd') && !selected.some(c => c.source === 'jd')) {
    const jd = ranked.find(c => c.source === 'jd');
    if (jd) selected[selected.length - 1] = jd;
  }
  return selected;
}
function inferYearsExperienceFromResume(resumeText) {
  const text=normalizeText(resumeText);
  if(!text)return null;

  const explicitPatterns=[
    /\b(\d{1,2}(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:overall\s+|total\s+|professional\s+|industry\s+)?experience\b/gi,
    /\b(?:total|overall|professional|industry)\s+experience\s*[:\-–—]?\s*(\d{1,2}(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\b/gi,
    /^(?:total\s+)?experience\s*[:\-–—]?\s*(\d{1,2}(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\s*$/gim
  ];
  const explicit=[];
  for(const pattern of explicitPatterns){
    for(const match of text.matchAll(pattern)){
      const value=Number(match[1]);
      if(Number.isFinite(value)&&value>=0&&value<=60)explicit.push(value);
    }
  }
  if(explicit.length)return Math.max(...explicit);

  const monthNames='Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Sept(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
  const dateToken=`(?:(?:${monthNames})[\\s,./-]*\\d{4}|(?:0?[1-9]|1[0-2])[/-]\\d{4}|(?:19|20)\\d{2})`;
  const endToken=`(?:${dateToken}|Present|Current|Till\\s+Date|To\\s+Date|Now|Ongoing)`;
  const rangeRe=new RegExp(`(${dateToken})\\s*(?:-|–|—|to|through|till|until)\\s*(${endToken})`,'gi');
  const monthMap={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  const current=new Date();
  const currentMonth=(current.getUTCFullYear()*12)+current.getUTCMonth();
  const parsePoint=(value,isEnd=false)=>{
    const raw=String(value||'').trim();
    if(/^(?:present|current|till\s+date|to\s+date|now|ongoing)$/i.test(raw))return currentMonth;
    let m=raw.match(/^(0?[1-9]|1[0-2])[/-]((?:19|20)\d{2})$/);
    if(m)return (Number(m[2])*12)+(Number(m[1])-1);
    m=raw.match(new RegExp(`^(${monthNames})[\\s,./-]*((?:19|20)\\d{2})$`,'i'));
    if(m)return (Number(m[2])*12)+(monthMap[m[1].slice(0,3).toLowerCase()]??(isEnd?11:0));
    m=raw.match(/^((?:19|20)\d{2})$/);
    if(m)return (Number(m[1])*12)+(isEnd?11:0);
    return null;
  };

  const lines=text.split('\n');
  const workRanges=[];
  const fallbackRanges=[];
  let section='';
  for(let lineIndex=0;lineIndex<lines.length;lineIndex++){
    const line=lines[lineIndex].trim();
    if(!line)continue;
    const heading=line.toLowerCase().replace(/[:\-–—]+$/,'').trim();
    if(/^(?:education|academic|academics|certifications?|training|courses?|qualifications?)$/.test(heading))section='nonwork';
    else if(/^(?:professional\s+)?(?:experience|work\s+experience|employment|career\s+history|project\s+experience|projects?|client\s+projects?)$/.test(heading))section='work';

    rangeRe.lastIndex=0;
    for(const match of line.matchAll(rangeRe)){
      const startMonth=parsePoint(match[1],false),endMonth=parsePoint(match[2],true);
      if(!Number.isFinite(startMonth)||!Number.isFinite(endMonth)||endMonth<startMonth)continue;
      if(endMonth-startMonth>60*12)continue;
      const around=lines.slice(Math.max(0,lineIndex-2),Math.min(lines.length,lineIndex+2)).join(' ');
      const workHint=/\b(?:project|client|company|employer|experience|employment|work|engineer|developer|architect|consultant|analyst|tester|sdet|lead|manager|specialist|administrator|intern|associate|role|position)\b/i.test(around);
      const nonWorkHint=/\b(?:education|university|college|school|bachelor|master(?:'s)?|degree|gpa|academic|certification|certificate|course|training)\b/i.test(around);
      const item={start:startMonth,end:endMonth};
      if(section==='nonwork')continue;
      if(section==='work'||workHint)workRanges.push(item);
      else if(!nonWorkHint)fallbackRanges.push(item);
    }
  }
  const ranges=workRanges.length?workRanges:fallbackRanges;
  if(!ranges.length)return null;
  const earliest=Math.min(...ranges.map(item=>item.start));
  const latest=Math.max(...ranges.map(item=>item.end));
  if(!Number.isFinite(earliest)||!Number.isFinite(latest)||latest<earliest)return null;
  const years=(latest-earliest+1)/12;
  if(years<0||years>60)return null;
  const rounded=Math.round(years*10)/10;
  return Math.abs(rounded-Math.round(rounded))<0.05?Math.round(rounded):rounded;
}
function normalizeRoleTitle(value) {
  let text=String(value||'')
    .replace(/^\s*(?:job\s+title|current\s+role|role|title|designation|position|job\s+description\s+for|opening\s+for|opportunity\s+for)\s*[:\-–—]?\s*/i,'')
    .replace(/\s+(?:at|with)\s+[A-Z][\w&.,' -]{2,}$/,'')
    .replace(/\s+[|•·]\s+.*$/,'')
    .replace(/\s+\/\s+.*$/,'')
    .replace(/\s{2,}/g,' ')
    .replace(/^[-–—:,;\s]+|[-–—:,;\s]+$/g,'')
    .trim();
  text=text.split(/\s+(?:responsible\s+for|who\s+will|to\s+join|to\s+work|with\s+experience\s+in|having\s+experience\s+in|for\s+our\s+team)\b/i)[0].trim();
  const words=text.split(/\s+/).filter(Boolean);
  if(words.length>9)text=words.slice(0,9).join(' ');
  return text.slice(0,100);
}
function explicitRolePattern() {
  return /\b(?:(?:senior|sr\.?|lead|principal|staff|associate|junior|jr\.?|technical|solution|solutions|cloud|azure|aws|java|python|\.net|dotnet|full[- ]?stack|backend|front[- ]?end|data|analytics|business\s+intelligence|bi|power\s*bi|devops|sre|site\s+reliability|qa|quality\s+assurance|test|automation|machine\s+learning|ml|ai|react|angular|software|application|systems?|platform)\s+){0,5}(?:engineer|developer|architect|tester|analyst|consultant|lead|manager|specialist|administrator)\b|\b(?:sdet|software\s+engineer|software\s+developer|solution\s+architect|solutions\s+architect|data\s+engineer|data\s+scientist|devops\s+engineer|qa\s+engineer|automation\s+engineer|test\s+engineer|technical\s+lead|team\s+lead|business\s+analyst|data\s+analyst)\b/i;
}
function compactRoleCandidate(value) {
  const candidate=normalizeRoleTitle(value);
  if(!candidate)return '';
  const direct=candidate.match(explicitRolePattern());
  if(direct)return normalizeRoleTitle(direct[0]);
  const words=candidate.split(/\s+/).filter(Boolean);
  const hasRoleNoun=/\b(engineer|developer|architect|tester|analyst|consultant|lead|manager|specialist|administrator|sdet)\b/i.test(candidate);
  if(hasRoleNoun&&words.length<=9&&!/[.!?;]/.test(candidate))return candidate;
  return '';
}
function extractExplicitRoleFromResume(documentText) {
  const text=normalizeText(documentText);
  if(!text)return '';
  const lines=text.split('\n').map(line=>line.trim()).filter(Boolean);
  const labelled=/\b(?:current\s+)?(?:role|job\s+title|title|designation|position)\s*[:\-–—]\s*(.+)$/i;
  for(const line of lines.slice(0,220)){
    const label=line.match(labelled);
    if(!label)continue;
    const candidate=compactRoleCandidate(label[1]);
    if(candidate)return candidate;
  }
  for(const line of lines.slice(0,35)){
    if(/\b(?:summary|profile|objective|responsibilit|skills?|technolog|expertise|experience\s+in|worked\s+with|proficient|knowledge)\b/i.test(line))continue;
    const stripped=line.replace(/\s+[|•·]\s+.*$/,'').trim();
    const words=stripped.split(/\s+/).filter(Boolean);
    if(words.length<1||words.length>9||/[.!?;]/.test(stripped))continue;
    const candidate=compactRoleCandidate(stripped);
    if(!candidate)continue;
    const comparable=value=>normalizeText(value).toLowerCase().replace(/[^a-z0-9+#.]+/g,' ').trim();
    const rawComparable=comparable(stripped),candidateComparable=comparable(candidate);
    if(rawComparable===candidateComparable||rawComparable.startsWith(`${candidateComparable} `)||rawComparable.endsWith(` ${candidateComparable}`))return candidate;
  }
  return '';
}
function extractExplicitRoleFromJD(documentText) {
  const text=normalizeText(documentText);
  if(!text)return '';
  const lines=text.split('\n').map(line=>line.trim()).filter(Boolean);
  const labelled=[
    /\b(?:job\s+title|role|title|position|designation)\s*[:\-–—]\s*(.+)$/i,
    /\bjob\s+description\s+for\s*[:\-–—]?\s*(.+)$/i,
    /\b(?:opening|opportunity)\s+for\s+(?:an?\s+)?(.+)$/i,
    /\b(?:we\s+are\s+(?:looking|hiring|seeking)\s+for|looking\s+for|seeking)\s+(?:an?\s+)?(.+?)\s*(?:to\s+join|with\s+|who\s+|$)/i
  ];
  for(const line of lines.slice(0,180)){
    for(const pattern of labelled){
      const match=line.match(pattern);
      if(!match)continue;
      const candidate=compactRoleCandidate(match[1]);
      if(candidate)return candidate;
    }
  }
  for(const line of lines.slice(0,45)){
    if(/\b(?:responsibilit|requirement|qualification|experience|must|should|will|work with|collaborat|develop|design|implement|build|maintain|skills?)\b/i.test(line))continue;
    const stripped=line.replace(/\s+[|•·]\s+.*$/,'').trim();
    const words=stripped.split(/\s+/).filter(Boolean);
    if(words.length<1||words.length>9||/[.!?;]/.test(stripped))continue;
    const candidate=compactRoleCandidate(stripped);
    if(!candidate)continue;
    const comparable=value=>normalizeText(value).toLowerCase().replace(/[^a-z0-9+#.]+/g,' ').trim();
    const rawComparable=comparable(stripped),candidateComparable=comparable(candidate);
    if(rawComparable===candidateComparable||rawComparable.startsWith(`${candidateComparable} `)||rawComparable.endsWith(` ${candidateComparable}`))return candidate;
  }
  return '';
}
function extractExplicitRoleFromDocument(documentText) {
  return extractExplicitRoleFromResume(documentText);
}
function inferRoleFromSkills(resumeText,jdText) {
  const resume=normalizeText(resumeText).toLowerCase();
  const jd=normalizeText(jdText).toLowerCase();
  const combined=`${resume} ${resume} ${jd}`;
  const rules=[
    ['QA Automation Engineer',[/\bselenium\b/g,/\bplaywright\b/g,/\bcypress\b/g,/\btestng\b/g,/\bjunit\b/g,/\bcucumber\b/g,/\bapi testing\b/g,/\bautomation testing\b/g]],
    ['Data Engineer',[/\bdatabricks\b/g,/\bapache spark\b|\bspark\b/g,/\bdata factory\b|\badf\b/g,/\betl\b/g,/\bdelta lake\b/g,/\bdata pipeline/g,/\bsnowflake\b/g]],
    ['DevOps Engineer',[/\bkubernetes\b/g,/\bterraform\b/g,/\bjenkins\b/g,/\bansible\b/g,/\bci\/cd\b|\bcicd\b/g,/\bhelm\b/g,/\bdevops\b/g]],
    ['Machine Learning Engineer',[/\bmachine learning\b/g,/\bmlflow\b/g,/\bpytorch\b/g,/\btensorflow\b/g,/\bscikit[- ]learn\b/g,/\bllm\b/g]],
    ['Power BI Developer',[/\bpower\s*bi\b/g,/\bdax\b/g,/\bpower query\b/g,/\btabular model\b/g]],
    ['Frontend Developer',[/\breact\b/g,/\bangular\b/g,/\bvue\b/g,/\bhtml\b/g,/\bcss\b/g,/\bfrontend\b|\bfront-end\b/g]],
    ['Java Developer',[/\bjava\b/g,/\bspring boot\b/g,/\bspring\b/g,/\bhibernate\b/g,/\bmaven\b/g,/\bgradle\b/g]],
    ['.NET Developer',[/\bc#\b/g,/\b\.net\b|\bdotnet\b/g,/\basp\.net\b/g,/\bentity framework\b/g]],
    ['Python Developer',[/\bpython\b/g,/\bdjango\b/g,/\bfastapi\b/g,/\bflask\b/g]],
    ['Cloud Engineer',[/\baws\b/g,/\bazure\b/g,/\bgcp\b|\bgoogle cloud\b/g,/\bcloudformation\b/g]]
  ];
  let best='',bestScore=0;
  for(const [title,patterns] of rules){
    let score=0;
    for(const pattern of patterns)score+=(combined.match(pattern)||[]).length;
    if(score>bestScore){bestScore=score;best=title;}
  }
  const frontend=(combined.match(/\b(?:react|angular|vue)\b/g)||[]).length;
  const backend=(combined.match(/\b(?:spring boot|spring|node(?:\.js)?|express|django|fastapi|asp\.net)\b/g)||[]).length;
  if(frontend>=2&&backend>=2)return 'Full Stack Developer';
  return bestScore>=2?best:'';
}
function inferRoleFromJDEvidence(jdText) {
  const text=normalizeText(jdText);
  if(!text)return '';
  const q=text.toLowerCase();
  const count=pattern=>(q.match(pattern)||[]).length;
  const exact=[
    ['AI/ML Architect', /\b(?:ai\s*[/&-]?\s*ml|artificial intelligence(?:\s+and\s+machine learning)?)\s+architect\b/g],
    ['Machine Learning Architect', /\bmachine learning architect\b/g],
    ['Azure Solution Architect', /\b(?:azure\s+(?:solution|solutions|cloud)\s+architect|solution\s+architect\s+[-–—:,]?\s*azure)\b/g],
    ['AWS Solution Architect', /\b(?:aws\s+(?:solution|solutions|cloud)\s+architect|solution\s+architect\s+[-–—:,]?\s*aws)\b/g],
    ['Solution Architect', /\bsolutions? architect\b/g],
    ['Data Architect', /\bdata architect\b/g],
    ['Data Analyst', /\bdata analyst\b/g],
    ['Business Analyst', /\bbusiness analyst\b/g],
    ['Data Engineer', /\bdata engineer\b/g],
    ['Data Scientist', /\bdata scientist\b/g],
    ['Machine Learning Engineer', /\bmachine learning engineer\b/g],
    ['AI/ML Engineer', /\b(?:ai\s*[/&-]?\s*ml|ai|artificial intelligence)\s+engineer\b/g],
    ['Full Stack Developer', /\bfull[- ]?stack (?:developer|engineer)\b/g],
    ['Backend Developer', /\bback[- ]?end (?:developer|engineer)\b/g],
    ['Frontend Developer', /\bfront[- ]?end (?:developer|engineer)\b/g],
    ['Java Developer', /\bjava developer\b/g],
    ['.NET Developer', /\b(?:\.net|dotnet) developer\b/g],
    ['Python Developer', /\bpython developer\b/g],
    ['Power BI Developer', /\bpower\s*bi developer\b/g],
    ['DevOps Engineer', /\bdevops engineer\b/g],
    ['QA Automation Engineer', /\b(?:qa automation|automation test|test automation) engineer\b/g],
    ['Software Engineer', /\bsoftware engineer\b/g],
    ['Software Developer', /\bsoftware developer\b/g]
  ];
  let exactBest='',exactScore=0;
  for(const [title,pattern] of exact){
    const score=count(pattern);
    if(score>exactScore){exactScore=score;exactBest=title;}
  }
  if(exactScore>0)return exactBest;

  const roleCounts={architect:count(/\barchitect\b/g),analyst:count(/\banalyst\b/g),developer:count(/\bdeveloper\b/g),engineer:count(/\bengineer\b/g),scientist:count(/\bscientist\b/g),tester:count(/\btester\b/g),consultant:count(/\bconsultant\b/g),administrator:count(/\badministrator\b/g)};
  const family=Object.entries(roleCounts).sort((a,b)=>b[1]-a[1])[0];
  const familyName=family&&family[1]>0?family[0]:'';
  const ai=count(/\b(?:artificial intelligence|machine learning|generative ai|genai|llm|large language model|deep learning|mlops|ai|ml)\b/g);
  const data=count(/\b(?:data|analytics?|sql|warehouse|lakehouse|etl|databricks|snowflake|spark)\b/g);
  const azure=count(/\b(?:azure|microsoft azure|azure data factory|adf)\b/g);
  const aws=count(/\b(?:aws|amazon web services)\b/g);
  const devops=count(/\b(?:devops|kubernetes|terraform|jenkins|ansible|ci\/?cd|helm)\b/g);
  const qa=count(/\b(?:selenium|playwright|cypress|testng|cucumber|automation testing|test automation|qa)\b/g);
  const java=count(/\b(?:java|spring boot|spring|hibernate)\b/g);
  const dotnet=count(/\b(?:\.net|dotnet|asp\.net|c#|entity framework)\b/g);
  const python=count(/\b(?:python|django|fastapi|flask)\b/g);
  const powerbi=count(/\b(?:power\s*bi|dax|power query)\b/g);
  const frontend=count(/\b(?:react|angular|vue|frontend|front-end)\b/g);
  const backend=count(/\b(?:spring boot|node\.js|nodejs|express|django|fastapi|asp\.net|backend|back-end)\b/g);

  if(familyName==='architect'){
    if(ai>=2)return 'AI/ML Architect';
    if(data>=3)return 'Data Architect';
    if(azure>=1)return 'Azure Solution Architect';
    if(aws>=1)return 'AWS Solution Architect';
    return 'Solution Architect';
  }
  if(familyName==='analyst')return (data>=2||powerbi>=1)?'Data Analyst':'Business Analyst';
  if(familyName==='scientist')return 'Data Scientist';
  if(familyName==='tester')return qa>=1?'QA Automation Engineer':'QA Engineer';
  if(familyName==='administrator')return azure>=1?'Azure Administrator':(aws>=1?'Cloud Administrator':'System Administrator');
  if(familyName==='developer'){
    if(ai>=3)return 'AI/ML Developer';
    if(powerbi>=2)return 'Power BI Developer';
    if(frontend>=2&&backend>=2)return 'Full Stack Developer';
    if(java>=2)return 'Java Developer';
    if(dotnet>=2)return '.NET Developer';
    if(python>=2)return 'Python Developer';
    if(frontend>=2)return 'Frontend Developer';
    if(backend>=2)return 'Backend Developer';
    return 'Software Developer';
  }
  if(familyName==='engineer'){
    if(ai>=3)return 'AI/ML Engineer';
    if(devops>=2)return 'DevOps Engineer';
    if(qa>=2)return 'QA Automation Engineer';
    if(data>=4)return 'Data Engineer';
    if(azure>=2||aws>=2)return 'Cloud Engineer';
    return 'Software Engineer';
  }
  if(familyName==='consultant')return azure>=1?'Azure Consultant':(data>=2?'Data Consultant':'Technical Consultant');
  return inferRoleFromSkills('',text);
}

function inferTargetRoleFromDocuments(resumeText,jdText) {
  const resumeRole=extractExplicitRoleFromResume(resumeText);
  if(resumeRole)return resumeRole;
  const jdRole=extractExplicitRoleFromJD(jdText);
  if(jdRole)return jdRole;
  if(normalizeText(jdText))return inferRoleFromJDEvidence(jdText)||inferRoleFromSkills('',jdText);
  return inferRoleFromSkills(resumeText,'');
}
function fallbackProfile(resumeText, jdText, yearsExperience, role) {
  const inferredYears=Number.isFinite(yearsExperience)?yearsExperience:inferYearsExperienceFromResume(resumeText);
  const inferredRole=role||inferTargetRoleFromDocuments(resumeText,jdText);
  const prefix=[Number.isFinite(inferredYears)?`${inferredYears} years of experience`:'',inferredRole?`role: ${inferredRole}`:''].filter(Boolean).join('; ');
  return {
    candidateSummary:`${prefix ? `${prefix}. ` : ''}${resumeText.slice(0, 2200)}`.trim(),
    jdSummary:jdText?jdText.slice(0, 1600):'',
    primarySkills:Array.from(keywords(resumeText)).slice(0, 30),
    domainVocabulary:Array.from(keywords(`${resumeText} ${jdText||''}`)).slice(0,60),
    targetRole:inferredRole, yearsExperience:inferredYears
  };
}
async function generateStructuredProfile(resumeText, jdText, yearsExperience, role) {
  const fallback = fallbackProfile(resumeText, jdText, yearsExperience, role);
  const suppliedYears=Number.isFinite(yearsExperience)?yearsExperience:null;
  const deterministicYears=suppliedYears===null?inferYearsExperienceFromResume(resumeText):suppliedYears;
  const explicitResumeRole=role?'':extractExplicitRoleFromResume(resumeText);
  const explicitJdRole=(role||explicitResumeRole)?'':extractExplicitRoleFromJD(jdText);
  const inferredJdRole=(!role&&!explicitResumeRole&&!explicitJdRole&&normalizeText(jdText))?(inferRoleFromJDEvidence(jdText)||inferRoleFromSkills('',jdText)):'';
  const inferredResumeRole=(!role&&!explicitResumeRole&&!explicitJdRole&&!normalizeText(jdText))?inferRoleFromSkills(resumeText,''):'';
  const deterministicRole=role||explicitResumeRole||explicitJdRole||inferredJdRole||inferredResumeRole;
  try {
    const data = await openAIResponseJson({
      model:LLM_PROFILE_MODEL,
      instructions:'Create a compact interview-grounding profile. Return JSON only, no markdown. Never invent project facts. Respect the deterministic resume/JD role and experience extraction supplied in the prompt; use model inference only to fill genuinely unresolved profile fields.',
      input:`Years of experience supplied by user: ${suppliedYears===null?'not supplied':suppliedYears}
Deterministic resume timeline years: ${Number.isFinite(deterministicYears)?deterministicYears:'not resolved'}
Target role supplied by user: ${role || 'not supplied'}
Explicit role found in CV: ${explicitResumeRole || 'not found'}
Explicit role found in JD: ${explicitJdRole || 'not found'}
JD-based role fallback: ${inferredJdRole || 'not resolved'}
Resume-based role fallback (only when no JD exists): ${inferredResumeRole || 'not resolved'}

RESUME:
${resumeText.slice(0, 30000)}

JOB DESCRIPTION:
${jdText ? jdText.slice(0, 24000) : 'Not provided. Use resume-only grounding.'}

Return JSON with keys candidateSummary (max 1800 chars), jdSummary (max 1200 chars; empty string when no JD), primarySkills (array max 25), projectHighlights (array max 8), domainVocabulary (array max 60 of exact technology/product/framework/domain terms appearing in the resume or JD, preserving canonical spelling such as LangGraph, LangChain, Kubernetes), targetRole, yearsExperience. For yearsExperience, use a supplied value when present; otherwise prefer the deterministic resume timeline value above and only infer from resume dates if it was unresolved. For targetRole, use this exact priority: supplied role; explicit CV role/title; explicit JD job title/role/position/job-description-for title; if the JD exists but has no explicit title, infer one concise canonical job title from the JD responsibilities/requirements; only when there is no useful JD, infer from the resume. targetRole must be a job title only (normally 2-6 words, maximum 9), never a sentence, summary, requirement, company description, or slash-separated list. Do not replace an explicit CV title with a JD title.`,
      effort:'low', maxTokens:900, responseFormat:{type:'json_object'}
    });
    const raw = outputText(data);
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    const parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
    const rawParsedYears=parsed.yearsExperience;
    const parsedYears=(rawParsedYears===null||rawParsedYears===undefined||String(rawParsedYears).trim()==='')?NaN:Number(rawParsedYears);
    const resolvedYears=Number.isFinite(suppliedYears)?suppliedYears:(Number.isFinite(deterministicYears)?deterministicYears:(Number.isFinite(parsedYears)&&parsedYears>=0&&parsedYears<=60?parsedYears:fallback.yearsExperience));
    const parsedRole=compactRoleCandidate(parsed.targetRole || '') || normalizeRoleTitle(parsed.targetRole || '');
    const resolvedRole=normalizeRoleTitle(deterministicRole||parsedRole||fallback.targetRole||'Software Engineer');
    return {
      candidateSummary:normalizeText(parsed.candidateSummary || fallback.candidateSummary).slice(0, 2200),
      jdSummary:normalizeText(parsed.jdSummary || fallback.jdSummary).slice(0, 1600),
      primarySkills:Array.isArray(parsed.primarySkills) ? parsed.primarySkills.slice(0,25) : fallback.primarySkills,
      projectHighlights:Array.isArray(parsed.projectHighlights) ? parsed.projectHighlights.slice(0,8) : [],
      domainVocabulary:Array.isArray(parsed.domainVocabulary) ? parsed.domainVocabulary.map(String).slice(0,60) : fallback.primarySkills,
      targetRole:resolvedRole,
      yearsExperience:resolvedYears,
    };
  } catch (err) {
    console.warn('[RAG] Structured profile fallback:', err.message);
    return {
      ...fallback,
      targetRole:normalizeRoleTitle(deterministicRole||fallback.targetRole||'Software Engineer')
    };
  }
}
function isContextualFollowup(question) {
  if(parseMultiQuestionIntent(question))return false;
  const q = normalizeText(question).toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  if (!q) return false;
  if (/\b(it|that|this|those|these|them|earlier|previous|above|same|same thing|one example|another example|more detail|what about|how about|show code|give code|alternative code|alternative solution|alternative approach|convert it|rewrite it|same in|do it in|instead|another one|other way|dry run|time complexity|space complexity|edge cases?|optimi[sz]e|without|avoid|do not use|don't use|not using|using only|different way|different approach|another way)\b/.test(q)) return true;
  if (/^(?:in|using)\s+(?:java|python|c#|c\+\+|javascript|typescript|go|golang|rust|kotlin|swift)\??$/.test(q)) return true;
  if (/\b(explain|walk through|why did you|why have you|modify|change|fix)\b.*\b(code|logic|line|function|method|class|solution|algorithm|loop|map|array|string)\b/.test(q)) return true;
  if (/^(what|who|why|when|where|which)\s+(is|are|was|were|do|does|did|can|could|should|would)\b/.test(q)) return false;
  if (/^(explain|define|describe|compare|differentiate|tell me about|difference between)\b/.test(q)) return false;
  return words.length <= 3;
}
function isInterviewLogisticsQuestion(value) {
  const q=normalizeText(value).toLowerCase().replace(/[?.!,;:]+/g,' ').replace(/\s+/g,' ').trim();
  if(!q)return true;
  const patterns=[
    /\byou(?:'re| are)\b.{0,25}\b(?:able to )?(?:hear|see) (?:me|us)\b/,
    /\b(?:for (?:the )?sake of clarification|just for clarification)\b/,
    /^\s*(?:can|could|would) you just(?: okay)?\s*$/,
    /\b(?:can|could|would|will|do|are) you\b.{0,35}\b(?:hear|see) me\b/,
    /\b(?:are|can|could) you\b.{0,25}\b(?:able to )?(?:hear|see) (?:me|us)\b/,
    /\b(?:turn|switch) (?:on|off)\b.{0,20}\b(?:camera|video|mic|microphone)\b/,
    /\b(?:camera|video|mic|microphone)\b.{0,20}\b(?:on|off|working)\b/,
    /\b(?:show|display|hold up)\b.{0,25}\b(?:id|identity card|identification|passport|license)\b/,
    /\b(?:blurred|blurry|not clear|camera clarity|video clarity)\b/,
    /\b(?:take|move|go|come)\b.{0,18}\b(?:back|closer|forward)\b.{0,12}\b(?:step|little|bit)?\b/,
    /\b(?:hold on|wait a moment|one moment|just a moment)\b/,
    /\b(?:can|could|shall|should) (?:you|we)\b.{0,18}\bstart (?:now|the interview|the call)\b/,
    /\b(?:ready to start|shall we start|can we start)\b/,
    /\b(?:mute|unmute|share (?:your )?screen|screen share|join the call|rejoin|connection|network issue)\b/,
    /\b(?:are|were) you (?:still )?(?:typing|done typing|done)\b/,
    /\b(?:can|could|would|will) you\b.{0,30}\b(?:maximize|minimize|resize)\b.{0,20}\b(?:window|screen)\b/,
    /\b(?:maximize|minimize|resize) (?:the |your )?(?:window|screen)\b/,
    /\b(?:can|could|do) you (?:please )?(?:see|view) (?:my|the) screen\b/,
    /\b(?:do|can) you see (?:my|the) screen\b/,
    /\b(?:i(?:'m| am)|we(?:'re| are)) (?:sharing|stopping|starting) (?:my |the )?screen\b/,
    /\b(?:done|finished) (?:with )?(?:sharing|typing)\b/,
    /\b(?:had|have|ate) (?:my |the )?(?:breakfast|lunch|dinner)\b/
  ];
  return patterns.some(pattern=>pattern.test(q));
}
function isInterviewerHandoff(value) {
  const q=normalizeText(value).toLowerCase();
  return /\b(?:do you have|any|have any) questions? (?:for me|for us|about (?:the )?(?:team|role|position|company|project))\b/.test(q)
    || /\b(?:ask|questions?)\b.{0,35}\b(?:me|interviewer)\b/.test(q)&&/\b(?:before we|wrap|end|stop|move ahead)\b/.test(q);
}
function isWeakConversationFragment(value) {
  const q=normalizeText(value).toLowerCase().replace(/[?.!,;:]+/g,' ').replace(/\s+/g,' ').trim();
  if(!q)return true;
  if(isInterviewLogisticsQuestion(q))return true;
  return /^(?:okay|ok|yes|yeah|right|correct|fine|good|great|awesome|got it|thank you|thanks|mhmm|hmm|hello|sorry)(?:\s+.*)?$/.test(q)
    || /^(?:can you )?(?:please )?(?:come again|repeat that|say that again)$/.test(q)
    || /^(?:are we|are you|do you|can you|could you|would you)\s+(?:used|using|done|okay|fine|ready)(?:\s+here)?$/.test(q);
}
function technicalIntentScore(value) {
  const q=normalizeText(value).toLowerCase();
  if(!q||isWeakConversationFragment(q))return -100;
  let score=0;
  if(/\b(?:code|script|function|method|class|loop|set|list|array|data ?frame|csv|xls|xlsx|source|target|rows?|shape|duplicate|unique|records?|sql|api|database|table|file|return code|error code|status code|insert|update|etl|test|automation|java|python|c#|javascript|typescript|snowflake|azure|aws|react|angular|ims|idms)\b/.test(q))score+=5;
  if(/\b(?:what|why|how|which|find|print|read|count|explain|describe|compare|implement|write|show|use|approach)\b/.test(q))score+=2;
  if(q.split(/\s+/).length>=5)score+=1;
  return score;
}
function latestSubstantiveIntent(requests) {
  if(!Array.isArray(requests)||!requests.length)return '';
  for(let i=requests.length-1;i>=0;i--){
    if(technicalIntentScore(requests[i])>=5)return requests[i];
  }
  for(let i=requests.length-1;i>=0;i--){
    if(!isWeakConversationFragment(requests[i]))return requests[i];
  }
  return '';
}
function stripNonSemanticSpeechFillers(value) {
  return normalizeText(value)
    .replace(/\b(?:m+h+m+|h+m+|u+h+|u+m+|a+h+|e+h+|h+a+h+a+(?:h+a+)*|ha(?:ha){1,})\b/gi,' ')
    .replace(/\s+([?.!,;:])/g,'$1')
    .replace(/([?.!,;:])(?:\s*[?.!,;:])+/g,'$1')
    .replace(/\s{2,}/g,' ')
    .trim();
}
function collapseQuestionSpeechNoise(value) {
  return stripNonSemanticSpeechFillers(value)
    .replace(/\b(what|why|how|can|could|would|do|did|are|is|okay|yeah|so)\s+\1\b/gi,'$1')
    .replace(/^(?:(?:hi|hello|thanks?|thank you|okay|alright|right|yeah|yes|fine)[,.:;]?\s+)+/i,'')
    .trim();
}

function cleanIntentLead(value) {
  let text=collapseQuestionSpeechNoise(value)
    .replace(/^(?:(?:okay|alright|right|well|so|and|then|now|you know|basically|actually|yeah|yes)[,.:;]?\s+)+/i,'')
    .replace(/\s+([?.!,;:])/g,'$1')
    .trim();
  if(text&&!/[?.!]$/.test(text))text+='?';
  return text;
}
function extractMultipleQuestionIntents(rawQuestion) {
  const raw=normalizeText(rawQuestion);
  if(!raw)return [];
  const normalized=raw.replace(/\s+/g,' ').trim();
  const starter=/\b(?:have you|do you|did you|can you|could you|would you|will you|are you|were you|what|why|how|when|where|which|who|describe|explain|define|compare|tell me|walk me through|brief(?: me)?(?: about)?|write|implement|find|solve|design|draw|create|show|debug|fix|calculate|return|print)\b/i;
  const pieces=normalized.split(/(?<=[.?!])\s+/);
  const requests=[];
  for(const piece of pieces){
    let clean=collapseQuestionSpeechNoise(piece).replace(/^(?:and|also|then|next|second(?:ly)?|one more thing)[,.:;]?\s+/i,'').trim();
    if(!clean)continue;
    const match=clean.match(starter);
    if(match&&Number.isFinite(match.index))clean=clean.slice(match.index);
    else if(!/[?]$/.test(clean))continue;
    clean=cleanIntentLead(clean);
    if(!clean||isInterviewLogisticsQuestion(clean))continue;
    const key=clean.toLowerCase().replace(/[^a-z0-9+#.]+/g,' ').trim();
    if(requests.some(item=>item.key===key))continue;
    requests.push({text:clean,key});
  }
  return requests.map(item=>item.text).slice(0,4);
}
function questionTerms(value) {
  const stop=new Set(['what','which','why','how','when','where','who','is','are','was','were','do','does','did','can','could','would','should','will','you','your','we','our','i','a','an','the','and','or','to','of','in','on','for','with','this','that','it','these','those','have','has','had','tell','me','explain','describe','please','then','also']);
  return new Set((normalizeText(value).toLowerCase().match(/[a-z0-9+#.]+/g)||[]).filter(word=>word.length>2&&!stop.has(word)));
}
function multiQuestionsRelated(parts) {
  if(!Array.isArray(parts)||parts.length<2)return false;
  for(let i=1;i<parts.length;i++){
    if(/^\s*(?:and\s+)?(?:how|why|where|when|what)\b.*\b(?:it|that|this|same|those|these)\b/i.test(parts[i]))return true;
    if(/^\s*(?:and\s+)?(?:why|how|example|where|when)\??\s*$/i.test(parts[i]))return true;
  }
  const base=questionTerms(parts[0]);
  return parts.slice(1).some(part=>[...questionTerms(part)].some(term=>base.has(term)));
}
function parseMultiQuestionIntent(value) {
  const text=String(value||'');
  const match=text.match(/^MULTI_QUESTION:\s*(RELATED|DISTINCT)\s*\n([\s\S]+)$/i);
  if(!match)return null;
  const parts=[...match[2].matchAll(/^Question\s+\d+:\s*(.+)$/gmi)].map(item=>item[1].trim()).filter(Boolean);
  return parts.length>=2?{related:match[1].toUpperCase()==='RELATED',parts}:null;
}
function reframeQuestionIntent(rawQuestion) {
  const raw=normalizeText(rawQuestion);
  if(!raw)return '';
  if(isInterviewerHandoff(raw))return 'INTERVIEWER_HANDOFF: The interviewer is asking whether I have questions for them.';
  const requests=extractMultipleQuestionIntents(raw).filter(item=>!isWeakConversationFragment(item));
  const conversationalTranscript=raw.length>650 || requests.length>4;
  if(requests.length>=2&&!conversationalTranscript){
    const relation=multiQuestionsRelated(requests)?'RELATED':'DISTINCT';
    return `MULTI_QUESTION: ${relation}\n${requests.map((item,index)=>`Question ${index+1}: ${item}`).join('\n')}`.slice(0,3000);
  }
  let candidate=conversationalTranscript?latestSubstantiveIntent(requests):(requests[0]||'');
  if(!candidate){
    const cleaned=cleanIntentLead(raw);
    candidate=isInterviewLogisticsQuestion(cleaned)?'':cleaned;
  }
  if(!candidate)return '';
  if(/\b(?:that|it|this|these|those|them)\b/i.test(candidate)){
    const plainCandidate=candidate.replace(/[?!.]+$/,'');
    const candidatePos=raw.toLowerCase().lastIndexOf(plainCandidate.toLowerCase());
    const before=candidatePos>0?raw.slice(0,candidatePos):raw;
    const references=[
      ...before.matchAll(/\b((?:agile|scrum|waterfall)\s+methodolog(?:y|ies))\b/gi),
      ...before.matchAll(/\b([A-Za-z0-9+#./-]+(?:\s+(?:and\s+)?[A-Za-z0-9+#./-]+){0,4}\s+(?:integration|framework|platform|technology|module|process|approach))\b/gi)
    ];
    const reference=references.sort((a,b)=>(a.index||0)-(b.index||0)).at(-1)?.[1];
    if(reference)candidate=candidate.replace(/\b(?:that|it|this|these|those|them)\b/i,reference);
  }
  return candidate.slice(0,2000);
}
function isCodeTurn(turn) {
  if(!turn)return false;
  return turn.responseType==='code'||turn.responseType==='snippet'||isCodingQuestion(turn.question)||/\b(?:Logic:|Complete code:|Code snippet:)\b|\b(?:class|function|def|public static|return)\b/i.test(turn.answer||'');
}
function resolveFollowupIntent(session, question) {
  const turns=session?.turns||[];
  const immediate=turns[turns.length-1];
  if(!immediate||!isContextualFollowup(question))return {isFollowup:false,resolvedQuestion:question,previous:null};
  const codeReference=isCodingFollowupQuestion(question)||/\b(?:alternative|same|previous|earlier|above)\s+(?:code|solution|implementation)|\b(?:convert|rewrite)\s+(?:it|that)\b/i.test(normalizeText(question));
  const previous=codeReference?[...turns].reverse().find(isCodeTurn)||immediate:immediate;
  const referenceRule=codeReference
    ? 'Use the nearest recent coding turn as the inherited task. Return the requested code/alternative, not explanation alone.'
    : 'Resolve pronouns and references such as those, them, these, that, this and it from the immediately previous interviewer request/answer. Rewrite the current intent internally as a complete standalone interviewer question using that antecedent before answering. Preserve the newest action word (for example explain, troubleshoot, automate, compare, where, how) so the previous answer supplies context but never replaces the current request. If that context supplies the antecedent, do not ask the interviewer to name it again.';
  return {
    isFollowup:true,
    previous,
    resolvedQuestion:`${referenceRule}\nPrevious interviewer request: ${previous.question}\nPrevious candidate answer/context: ${String(previous.answer||'').slice(0,5000)}\nCurrent follow-up/modifier: ${question}`
  };
}
function wantsExpandedAnswer(prompt) {
  return /\b(elaborate|expand|in[- ]depth|detailed(?:ly)?|deep dive|step[- ]by[- ]step|end[- ]to[- ]end)\b/i.test(String(prompt || ''));
}
function rejectLowConfidenceInput(prompt) {
  const clean = normalizeText(prompt);
  const words = clean.toLowerCase().match(/[a-z0-9+#.]+/g) || [];
  if (clean.length < 2 || !/[a-z0-9]/i.test(clean)) return 'I’m not sure what you’re asking. Please rephrase the question.';
  if (words.length >= 4 && new Set(words).size <= Math.max(1, Math.floor(words.length / 4))) return 'I’m not sure what you’re asking. Please rephrase the question.';
  if (/\b(tell|write|make|sing)\b.{0,20}\b(joke|poem|song|story)\b/i.test(clean) || /\b(weather|horoscope|lottery numbers?)\b/i.test(clean)) return 'That doesn’t appear relevant to this interview. Please ask an interview-related question.';
  return '';
}
function isDiagramQuestion(prompt) {
  return /\b(flow\s*chart|flow\s*diagram|architecture\s*(?:flow|diagram)|sequence\s*diagram|data\s*flow|component\s*diagram|block\s*diagram|draw\s+(?:the|a|an)?\s*(?:flow|architecture|diagram)|diagram\s+(?:for|of|showing)|draw\.io|drawio|notepad\s+diagram)\b/i.test(String(prompt||''));
}
function looksLikeJavaScriptCode(prompt) {
  const q=String(prompt||'');
  if(!q.trim())return false;
  const signals=[
    /\bfetch\s*\(/,
    /\.then\s*\(/,
    /\.catch\s*\(/,
    /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/,
    /=>/,
    /\basync\s+(?:function\s+)?[A-Za-z_$]?[\w$]*\s*\(?/,
    /\bawait\s+[A-Za-z_$]/,
    /\b(?:JSON\.(?:parse|stringify)|console\.(?:log|error|warn))\s*\(/,
    /\bset[A-Z][A-Za-z0-9_$]*\s*\(/
  ];
  const hits=signals.reduce((count,pattern)=>count+(pattern.test(q)?1:0),0);
  return hits>=2 || (/\bfetch\s*\(/.test(q)&&/\.(?:then|catch)\s*\(/.test(q));
}
function detectCodeLanguageHint(prompt, previous=null) {
  const q=String(prompt||'');
  const prior=`${previous?.question||''}\n${previous?.answer||''}`;
  const combined=`${q}\n${prior}`;
  if(looksLikeJavaScriptCode(q)||/\b(?:javascript|node(?:\.js)?|js)\b/i.test(combined))return 'JavaScript';
  if(/\btypescript\b|\binterface\s+\w+\s*\{|:\s*(?:string|number|boolean)\b/i.test(combined))return 'TypeScript';
  if(/\bpython\b|\bdef\s+\w+\s*\(|\bprint\s*\(/i.test(combined))return 'Python';
  if(/\bjava\b|\bpublic\s+(?:static\s+)?(?:class|void)|System\.out\.println/i.test(combined))return 'Java';
  if(/\bc#\b|\busing\s+System\b|Console\.WriteLine/i.test(combined))return 'C#';
  if(/\bc\+\+\b|#include\s*</i.test(combined))return 'C++';
  if(/\bgo(?:lang)?\b|\bfunc\s+\w+\s*\(/i.test(combined))return 'Go';
  if(/\bsql\b|\bselect\s+.+\bfrom\b/i.test(combined))return 'SQL';
  return '';
}
function isCodingQuestion(prompt) {
  const q=normalizeText(prompt);
  if(!q)return false;
  const explicitRequest=/\b(?:write|provide|show|give|implement|complete|create|debug|fix|compile|solve)\b.{0,45}\b(?:code|program|function|method|class|algorithm|solution|implementation)\b|\b(?:code|program|function|method|algorithm|solution)\b.{0,35}\b(?:write|implement|debug|fix|complete|create)\b/i.test(q);
  const snippetRequest=/\b(?:show|give|provide|write)?\s*(?:me\s+)?(?:a\s+)?(?:small\s+|simple\s+)?(?:code\s+)?(?:example|snippet)\b.{0,45}\b(?:java|python|c#|c\+\+|javascript|typescript|go|golang|kotlin|sql|shell|bash)\b|\b(?:java|python|c#|c\+\+|javascript|typescript|go|golang|kotlin|sql|shell|bash)\b.{0,45}\b(?:example|snippet)\b/i.test(q);
  const experienceQuestion=/\b(?:have you|do you have|did you|experience (?:with|in)|worked (?:with|on)|used (?:it|that|this|these|those)?\s*(?:in|on)?\s*(?:a|any|past|previous|production)|which project|tell me about your experience)\b/i.test(q);
  if(experienceQuestion&&!explicitRequest&&!snippetRequest)return false;
  if(explicitRequest||snippetRequest||looksLikeJavaScriptCode(prompt)||/```|\b(?:leetcode|hackerrank)\b/i.test(q))return true;
  if(/\b(?:public|private|protected)\s+(?:static\s+)?(?:class|interface|void|int|string)|\bdef\s+\w+\s*\(|\bfunction\s+\w+\s*\(|\b(?:console\.log|system\.out\.println)\s*\(/i.test(q))return true;
  return /\b(?:find|return|print|calculate|check|remove|reverse|sort|search|merge|validate|count|implement|solve)\b.{0,65}\b(?:string|character|char|array|list|linked list|tree|graph|number|integer|duplicate|non[- ]?repeating|unique|palindrome|anagram|substring|subarray)\b/i.test(q)
    || /\bgiven\b.{0,55}\b(?:string|array|list|tree|graph|number|integer)\b.{0,100}\b(?:find|return|print|calculate|remove|reverse|sort|search|merge|count)\b/i.test(q)
    || /\b(?:first|last)\s+(?:non[- ]?)?(?:duplicate|repeating|unique)\s+(?:character|char|element)\b/i.test(q);
}
function isImplementationSnippetQuestion(prompt) {
  const q=normalizeText(prompt).toLowerCase();
  if(!q)return false;
  return /\b(?:broken|dead)\s+links?\b/.test(q)
    && /\b(?:how|find|check|identify|validate|verify|detect|handle|test)\b/.test(q);
}
function isVersionQuestion(prompt) {
  const q=normalizeText(prompt).toLowerCase();
  return /\b(?:what|which)\s+(?:is|was|are|were)?\s*(?:the\s+)?(?:current\s+|used\s+|project\s+)?version\b/.test(q)
    || /\b(?:what|which)\s+version\b/.test(q)
    || /\bversion\s+(?:did|do|are|were|was|is)\s+(?:you|we)\s+(?:use|using)\b/.test(q)
    || /\b(?:react|angular|java|python|spring|spring boot|selenium|playwright|node(?:\.js)?|typescript|javascript|git|github|kubernetes|docker)\s+version\b/.test(q);
}
function isCodeConstraintFollowup(question) {
  const q=normalizeText(question).toLowerCase();
  if(!q)return false;
  return /\b(?:without|avoid|do not use|don't use|not using|using only|instead of|another way|different way|different approach)\b/.test(q)
    || /^(?:no[, ]+)?(?:stringbuilder|streams?|hashmap|map|recursion|loop|loops|built[- ]?in|library|libraries|sort|sorting)\b/.test(q);
}
function isCodingFollowupQuestion(question) {
  const q=normalizeText(question);
  if(!q)return false;
  if(/\b(?:have you|do you have|experience (?:with|in)|worked (?:with|on)|which project|tell me about your experience)\b/i.test(q))return false;
  return /\b(?:this|that|above|previous|earlier|same|alternative|another)\s+(?:code|program|function|method|class|algorithm|solution|line|loop|condition)\b/i.test(q)
    || /\b(?:alternative|another|different|other)\s+(?:solution|implementation|approach|way)\b/i.test(q)
    || /\b(?:explain|change|modify|update|fix|debug|continue|rewrite|convert|optimi[sz]e|dry run)\b.{0,55}\b(?:code|program|function|method|class|algorithm|solution|line|loop|condition|hashmap|map|array|string)\b/i.test(q)
    || /\b(?:why|how)\b.{0,55}\b(?:line|loop|condition|function|method|hashmap|map|array|stack|queue|recursion|time complexity|space complexity)\b/i.test(q)
    || /\b(?:what|which)\b.{0,55}\b(?:line|loop|condition|function|method)\b/i.test(q)
    || /^(?:in|using)\s+(?:java|python|c#|c\+\+|javascript|typescript|go|golang|rust|kotlin|swift)\??$/i.test(q)
    || /\b(?:time|space) complexity\b|\bedge cases?\b/i.test(q)
    || isCodeConstraintFollowup(q);
}
function classifyResponseType(question,followupInfo=null,inputSource='') {
  const previous=followupInfo?.previous;
  const multi=parseMultiQuestionIntent(question);
  if(multi){
    const types=multi.parts.map(part=>isDiagramQuestion(part)?'diagram':(isCodingQuestion(part)?'code':(isImplementationSnippetQuestion(part)?'snippet':'spoken')));
    if(types.every(type=>type==='code'))return 'code';
    if(types.every(type=>type==='diagram'))return 'diagram';
    if(types.every(type=>type==='snippet'))return 'snippet';
    return 'multi';
  }
  const previousCoding=!!previous&&(previous.responseType==='code'||isCodingQuestion(previous.question)||/```|\b(class|function|def|public static|return)\b/i.test(previous.answer||''));
  if(/screen-capture-diagram/i.test(inputSource))return 'diagram';
  if(/screen-capture-code/i.test(inputSource))return 'code';
  if (isDiagramQuestion(question)) return 'diagram';
  if (isCodingQuestion(question)||(previousCoding&&(isCodingFollowupQuestion(question)||isCodeConstraintFollowup(question)))) return 'code';
  if (isImplementationSnippetQuestion(question)) return 'snippet';
  return 'spoken';
}
function spokenAnswerShape(question) {
  if(parseMultiQuestionIntent(question))return 'MULTI';
  const q=normalizeText(question).toLowerCase();
  if(!q)return 'DIRECT';
  if(q.startsWith('interviewer_handoff:'))return 'INTERVIEWER_HANDOFF';
  if(isVersionQuestion(q))return 'VERSION';
  if(/\b(difference|different|compare|versus|\bvs\b|same or different)\b/i.test(q))return 'COMPARISON';
  if(/\b(advantage|advantages|feature|features|benefit|benefits|types|ways)\b/i.test(q))return 'FEATURES';
  if(/\b(out of memory|oom|production issue|performance issue|debug|troubleshoot|failing|failure|not working|latency issue|slow|incident)\b/i.test(q))return 'TROUBLESHOOTING';
  if(/\b(have you|did you|what did you|what exactly you did|your current|current engagement|recently|experience with|worked on|implemented|used in your project|in your project|tell me about your)\b/i.test(q))return 'EXPERIENCE';
  if(/\b(how do you|how did you|how would you|walk me through|flow|framework|mechanism|architecture|design|end[- ]to[- ]end|bring .* data|ingest|pipeline|implement it)\b/i.test(q))return 'IMPLEMENTATION_FLOW';
  if(/\b(what is|what are|why|when|where|which)\b/i.test(q))return 'CONCEPT';
  return 'DIRECT';
}
function exampleGuidance(question, followupInfo=null) {
  const q=normalizeText(question).toLowerCase();
  const shape=spokenAnswerShape(question);
  const explicit=/\b(example|examples|for example|scenario|use case|real[- ]?time|real[- ]?world|where did you use|how did you use|what did you implement|what exactly you did|implemented in your project|used in your project|in your project)\b/i.test(q);
  const projectApplication=/\b(used|implemented|applied|handled|handling|business logic|additional logic|project|production|current engagement|worked on)\b/i.test(q);
  const narrowCorrection=/^(?:no[,. ]+|correct|right|but|okay|so)?\s*(?:is that|does that|will that|can that|are you saying|do you mean|why\??$\vert{}how\??$)/i.test(q)
    || /\b(checkpoint only|insert(?:s)? versus update(?:s)?|identify insert|identify update)\b/i.test(q);
  const alreadyConcreteFlow=shape==='IMPLEMENTATION_FLOW' && /\b(how (?:are|do|did|would)|load(?:ed|ing)?|process(?:ed|ing)?|flow|pipeline|from .{0,30} to)\b/i.test(q);

  if(explicit) return 'INCLUDE_ONE: The interviewer explicitly asks for, or strongly implies, a practical example. Include exactly one concise example after the direct explanation. For candidate/project-specific examples, use only facts supported by RETRIEVED EVIDENCE; never invent project details.';
  if(narrowCorrection) return 'OMIT_UNLESS_NEEDED: This is primarily a correction/clarification. Do not add a separate example when the mechanism itself answers the question; add one only if it resolves otherwise-remaining ambiguity.';
  if(projectApplication && ['EXPERIENCE','CONCEPT','DIRECT','FEATURES'].includes(shape)) return 'INCLUDE_IF_GROUNDED_AND_USEFUL: Prefer one short concrete project/production example when it makes the answer easier to explain. Use only RETRIEVED EVIDENCE for personal/project facts. Skip the example if the evidence is insufficient or the preceding sentence is already concrete enough.';
  if(alreadyConcreteFlow) return 'OPTIONAL_NON_REDUNDANT: The answer is already an implementation/process flow. Add one short example only when it demonstrates a decision, transformation, or business outcome not already obvious from the flow; otherwise omit it.';
  if(shape==='CONCEPT') return 'OPTIONAL_FOR_CLARITY: Add one concise example only when the concept is materially easier to understand through application. Do not force examples for narrow definitions or facts.';
  return 'OPTIONAL_NON_REDUNDANT: Use one concise example only when it materially improves the answer. Never add an example merely to fill space, and never invent candidate-specific facts.';
}

function isNarrowSqlExampleRequest(question) {
  const q=normalizeText(question).toLowerCase();
  if(!/\b(?:sql|join|inner join|left join|right join|full join|query|select)\b/.test(q))return false;
  const asksExample=/\b(?:sample|example|simple|small)\b/.test(q) || /\b(?:write|show|give|provide)\b.{0,35}\b(?:query|sql|join|code)\b/.test(q);
  const asksScaffolding=/\b(?:create table|schema|ddl|insert (?:sample )?(?:data|rows|records)|stored procedure|procedure|database setup|full script|end[- ]to[- ]end)\b/.test(q);
  return asksExample&&!asksScaffolding;
}

function responseMode(question, followupInfo=null, inputSource='') {
  const type=classifyResponseType(question,followupInfo,inputSource);
  const codingFollowup=type==='code'&&!!followupInfo?.previous&&isCodingFollowupQuestion(question);
  if(type==='multi') return 'MULTI_QUESTION_REQUIRED: Cover every detected interviewer question in the same response and in the same order. If the questions are related, combine them naturally into one connected answer while explicitly satisfying both. If they are distinct, answer the first briefly at a useful high level, then transition immediately to the second and answer it directly. Never discard the first question just because the second is newer. If any sub-question asks for code, include the requested working code for that sub-question rather than explanation only.';
  if(type==='code'&&isNarrowSqlExampleRequest(question)) return 'MINIMAL_SQL_EXAMPLE: Give one direct sentence, then "Complete code:" with only the SQL statement needed to answer the request. Do NOT create tables, insert rows, define schemas/constraints, add setup/cleanup SQL, or build a full script unless explicitly requested. Finish with one tiny "Sample input:" and matching "Sample output:" so the join/query is easy to explain.';
  if (type==='code'&&codingFollowup) return 'CODING_REQUIRED_FOLLOW_UP: Answer the current follow-up directly in 1-3 short sentences. Then write "Logic:" with the simple approach in 1-2 concise lines, followed by "Complete code:" and the entire previous working solution, updated only when the follow-up requests a change. Include concise inline comments for every meaningful logical step so coding can continue without losing context. When a complete runnable program is printed, finish with one small "Sample input:" and matching "Sample output:" example.';
  if (type==='code') return 'CODING_REQUIRED: Start with "Logic:" and explain the simple approach in 1-2 concise lines. Then write "Complete code:" and provide one complete working solution in the requested or context-supported language. Include concise inline comments for every meaningful logical step. When a complete runnable program is printed, finish with one small "Sample input:" and matching "Sample output:" example.';
  if (type==='snippet') return 'EXPLANATION_WITH_CODE_SNIPPET: Answer the question directly in 2-4 concise sentences, then write "Code snippet:" and give the smallest practical snippet that demonstrates how to implement it in the requested or context-supported language/framework. Do not force a full standalone program or sample input/output unless the interviewer asks for it.';
  if (type==='diagram') return 'DRAWABLE_DIAGRAM_REQUIRED: Give a one-line overview, then a detailed monospaced Unicode box-drawing flow that can be copied into Notepad or redrawn in draw.io. Use boxes made with ┌ ─ ┐ │ └ ┘, directional arrows, branch labels, data/control direction, external systems and failure/return paths where relevant. Follow the diagram with only the essential explanation.';
  return `SPOKEN_INTERVIEW_EXPLAINED${String(inputSource).startsWith('screen-capture')?' (screen-captured input; apply exactly the same quality and format rules as typed input)':''}`;
}
function answerTokenBudget(question, hasImage=false,responseType='') {
  const q = String(question || '');
  if (responseType==='code'||isCodingQuestion(q)) return null;
  if (responseType==='multi') return /\b(?:code|program|function|method|implement|write)\b/i.test(q)?null:1800;
  if (responseType==='snippet'||isImplementationSnippetQuestion(q)) return 1600;
  if (responseType==='diagram'||isDiagramQuestion(q)) return 3000;
  if (hasImage || /\b(design|architecture|system design)\b/i.test(q)) return 1800;
  if (/\b(introduce yourself|tell me about yourself|self[- ]introduction)\b/i.test(q)) return 1000;
  if (wantsExpandedAnswer(q)) return 1400;
  if (/\b(what is|what are|difference|compare|why|how|explain|describe|experience|implemented|troubleshoot|debug|flow|pipeline|framework)\b/i.test(q)) return 1000;
  return 800;
}

function multiQuestionGuidance(intentQuestion) {
  const multi=parseMultiQuestionIntent(intentQuestion);
  if(!multi)return 'SINGLE_QUESTION';
  return multi.related
    ? `RELATED_MULTI_QUESTION: The interviewer asked ${multi.parts.length} related questions in one prompt. Give one coherent human-style answer that covers each requested point. Do not silently answer only the last question.`
    : `DISTINCT_MULTI_QUESTION: The interviewer asked ${multi.parts.length} different questions in one prompt. Answer the first at a concise useful high level, then answer the next question directly in the same response. Preserve the original order and do not skip any question.`;
}
function buildPrompt(session, question, retrieved, followupInfo=null, correctedQuestion=question, inputSource='',intentQuestion=correctedQuestion, regenerate=false) {
  const profile = session.profile || {};
  const info = followupInfo || resolveFollowupIntent(session, question);
  const userInstructions=normalizeStructuredText(session.userInstructions||'').slice(0,5000);
  const codeLanguage=detectCodeLanguageHint(intentQuestion,info.previous);
  const history = info.isFollowup
    ? session.turns.slice(-MAX_HISTORY_TURNS).map((t,i) => `Turn ${i+1}\nInterviewer: ${t.question}\nCandidate: ${t.answer}`).join('\n\n')
    : '';
  const evidence = retrieved.map((c,i) => {
    const sourceName = c.source === 'resume' ? 'Resume' : (c.source === 'jd' ? 'JD' : String(c.source || 'Source'));
    const sourceId = `${c.source === 'resume' ? 'R' : (c.source === 'jd' ? 'J' : 'S')}${i+1}`;
    return `[${sourceId}] ${sourceName} · ${c.section}\n${c.text.slice(0, 900)}`;
  }).join('\n\n');
  const followup = info.isFollowup
    ? `YES. Treat the current words as a continuation/modifier of the immediately previous interviewer request. Resolved intent:\n${info.resolvedQuestion}`
    : 'NO';
  const sameQuestionAnswers=regenerate?session.turns
    .filter(turn=>normalizeText(turn.question).toLowerCase()===normalizeText(intentQuestion).toLowerCase())
    .slice(-3):[];
  const priorAnswersForRegenerate=sameQuestionAnswers.length?sameQuestionAnswers:session.turns.slice(-1);
  const reanswer=regenerate
    ? `YES. Re-answer the same interviewer request with a materially different, independently useful approach while preserving all factual grounding and explicit constraints. Correct any weakness in the earlier answers. Do not mention that this is a retry or re-answer. For coding, use a different valid implementation/structure when practical without violating the requested constraints. Recent answers to avoid merely repeating:
${priorAnswersForRegenerate.map((turn,index)=>`Earlier answer ${index+1}:${String(turn?.answer||'').slice(0,3500)}`).join('\n\n')}`
    : 'NO';
  return `CANDIDATE PROFILE\nYears: ${Number.isFinite(session.yearsExperience)?session.yearsExperience:'Not specified'}\nTarget role: ${session.role || profile.targetRole || 'Not specified'}\n${profile.candidateSummary || ''}\nPrimary skills: ${(profile.primarySkills || []).join(', ')}\nCanonical resume/JD vocabulary: ${(profile.domainVocabulary || profile.primarySkills || []).join(', ')}\n\nJOB ALIGNMENT\n${profile.jdSummary || 'No job description supplied; use resume-only grounding.'}\n\nRETRIEVED EVIDENCE\n${evidence || 'No prepared evidence matched.'}\n\nRECENT INTERVIEW CONTEXT\n${history || 'Not supplied because the current question is standalone.'}\n\nCONTEXTUAL FOLLOW-UP\n${followup}\n\nRE-ANSWER REQUEST\n${reanswer}\n\nUSER INSTRUCTIONS FOR THIS INTERVIEW SESSION\n${userInstructions || 'No additional user instructions.'}\nApply these instructions to every answer in this prepared session when they are compatible with factual grounding and the mandatory coding/diagram contracts. Treat requests such as STAR format, very short answers, explanatory style, behavioral-answer style, or experience-first wording as persistent presentation preferences.\n\nINPUT SOURCE\n${inputSource||'system-audio-or-typed'}\n\nCODE LANGUAGE HINT\n${codeLanguage || 'No explicit language detected; preserve the language requested or inherited from the referenced coding turn.'}\n\nMULTI-QUESTION POLICY\n${multiQuestionGuidance(intentQuestion)}\n\nRESPONSE MODE\n${responseMode(intentQuestion,info,inputSource)}\n\nSPOKEN ANSWER SHAPE\n${spokenAnswerShape(intentQuestion)}\n\nEXAMPLE POLICY\n${exampleGuidance(intentQuestion,info)}\n\nREFRAMED CURRENT INTENT (this alone controls answer type and requested output)\n${intentQuestion}\n\nRAW CURRENT TRANSCRIPT (context only; incidental words such as code, coding or module do not control the format)\n${correctedQuestion}\n\nDEPTH\n${wantsExpandedAnswer(intentQuestion) ? 'Expanded answer requested.' : 'Default: direct interview answer with concise practical elaboration.'}`;
}
const COPILOT_INSTRUCTIONS = `You are the candidate in a live senior/lead engineer interview. Return one directly usable answer. Normal answers must be immediately speakable; coding and diagram questions must use the exact practical formats below. Never mention AI, ChatGPT, copilot, prompts, retrieval, transcription correction, evidence matching, or how you inferred the question. Never say "based on my CV/JD", "the resume confirms", "not listed", or similar meta commentary.

GROUNDING — INTERNAL ONLY:
- Treat RETRIEVED EVIDENCE as the only source of truth for candidate-specific experience, project ownership, employers, dates, metrics, tools actually used, responsibilities, certifications, and other resume/JD-specific facts. Do not invent or upgrade a personal claim from general model knowledge.
- Use resume/JD evidence silently to make candidate-specific answers accurate. NEVER print source tags, citations, evidence IDs, resume headings, JD headings, or labels such as "Resume · ..." / "JD · ..." in the visible answer.
- General technical knowledge may supplement the explanation, but it must not be rewritten as a personal claim unless the supplied resume evidence supports it.
- If a question asks about the candidate's own experience and the retrieved evidence does not support the requested fact, do not fabricate first-person experience. State the production-experience boundary once, then immediately give a strong practical implementation/POC-level answer with the same technical depth you would use if discussing the technology: architecture, key steps, failure handling, security/observability where relevant, and how you would validate it. Never stop after saying you have not used it.

INTERNAL ANALYSIS DISCIPLINE — FINAL ANSWER ONLY:
- Analyze the current question carefully before answering, but never output internal reasoning, chain-of-thought, <thinking> tags, scratch work, hidden analysis, or a step-by-step account of how the answer was derived. Return only the final interview-ready answer.
- First determine the exact scope and intent of the CURRENT question. Then decide what resume/JD evidence, prior context, and general technical knowledge are actually relevant to that scope.
- Prefer technically accurate, complete, mature explanations over high-level generic statements. Do not add architecture, tools, metrics, implementation details, or examples merely to sound detailed; every included detail must help answer the current question.
- Follow EXAMPLE POLICY independently for each current question. Examples are adaptive, not mandatory on every answer: include one when the interviewer asks for one or when a concrete application materially clarifies an experience/concept; omit it when the mechanism/flow is already concrete or a narrow clarification is better answered directly.
- When an example describes my project, production work, employer, implementation, data, metric, tool, or responsibility, every personal detail must be supported by RETRIEVED EVIDENCE. If evidence does not support a real project example, do not manufacture one; use a generic technical example only when the question is conceptual and EXAMPLE POLICY allows it.
- Normally use at most one example and integrate it naturally with a short lead-in such as "For example, ...". Do not create a separate Example section unless the interviewer explicitly asks for examples or multiple examples.
- For standard finite concepts, silently check completeness before responding so the first answer includes the important supported set without requiring repeated follow-up questions.
- For experience questions, silently verify personal claims against retrieved Resume evidence before phrasing them in first person. Grounding remains invisible in the final answer.

QUESTION INTENT IS AUTHORITATIVE — FOR EVERY MODEL:
- Parse and answer the current interviewer question independently first. RECENT INTERVIEW CONTEXT is non-authoritative background unless CONTEXTUAL FOLLOW-UP explicitly says YES.
- Never narrow a new standalone question to the technology/topic from the previous turn.
- Use previous turns only for explicit pronouns/modifiers/continuations such as "that", "same", "why?", "show code for it", or when CONTEXTUAL FOLLOW-UP says YES.
- A coding constraint/modifier such as "without StringBuilder", "do not use streams", "another way", or "using only loops" inherits the immediately previous coding task. It MUST remain a coding answer and include the complete updated code, not explanation alone.
- Prefer the exact noun/domain in the current question over nouns appearing only in history.

CONCEPT COMPLETENESS:
- For a finite, standard concept/list explicitly requested by the interviewer, give the complete commonly supported set in the first answer when it is practical, not a partial list that requires repeated follow-ups.
- Keep completeness proportional: name the complete set, explain each item briefly, and do not add unrelated framework trivia.

UNDERSTAND THE INTERVIEWER, NOT THE RAW TRANSCRIPT:
The input is noisy live speech. Remove repetitions, fillers and false starts. Infer the final intended technical question from the complete current utterance plus recent interview turns. Silently repair phonetic technology names from the canonical Resume/JD vocabulary and surrounding topic.

Use REFRAMED CURRENT INTENT as the authoritative current question and RESPONSE MODE as the authoritative output format. RAW CURRENT TRANSCRIPT is context only.

INTERVIEW DELIVERY CALIBRATION:
- Produce the answer the candidate can speak directly to the interviewer, not a compressed notes summary.
- For experience, role, day-to-day, tools, challenges and project questions, prefer 3-5 short connected paragraphs rather than a terse bullet checklist.
- Make the answer role-aware. Lead with the strongest Resume-supported experience that overlaps the target role.
- Visual emphasis is allowed only through **double-asterisk emphasis** around a small number of important technologies, responsibilities, controls or decision words.
- Natural explanation rule: prefer a small connected explanation over a compressed checklist. For a concept, normally state the idea, explain the runtime/working behavior, then add one practical usage or implication when it adds real value.`;

// --- API ENDPOINTS ---

app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.post('/api/session/start', async (req, res) => {
  try {
    const email = requireLicensedRequest(req, res);
    if (!email) return;

    const { resume, jd, role, yearsExperience, userInstructions } = req.body;
    let resumeText = '';
    let jdText = '';

    if (typeof resume === 'string' && resume.length > 0 && !resume.startsWith('data:')) {
      resumeText = normalizeText(resume).slice(0, MAX_DOCUMENT_CHARS);
    } else if (resume?.base64) {
      resumeText = await extractDocumentText(resume);
    }

    if (typeof jd === 'string' && jd.length > 0 && !jd.startsWith('data:')) {
      jdText = normalizeText(jd).slice(0, MAX_DOCUMENT_CHARS);
    } else if (jd?.base64) {
      jdText = await extractDocumentText(jd);
    }

    if (!resumeText && !jdText) {
      return res.status(400).json({ ok: false, error: 'Please provide at least a resume or job description.' });
    }

    const numericYears = Number.isFinite(Number(yearsExperience)) ? Number(yearsExperience) : null;
    const profile = await generateStructuredProfile(resumeText, jdText, numericYears, role);

    const resumeChunks = semanticChunks(resumeText, 'resume');
    const jdChunks = semanticChunks(jdText, 'jd');
    const chunks = [...resumeChunks, ...jdChunks];

    if (OPENAI_API_KEY && chunks.length > 0) {
      try {
        const textsToEmbed = chunks.map(c => `${c.section}: ${c.text}`);
        const embeddings = await embedTexts(textsToEmbed);
        chunks.forEach((chunk, idx) => {
          chunk.embedding = embeddings[idx] || null;
        });
      } catch (embErr) {
        console.warn('[RAG] Embedding batch failed during session initialization:', embErr.message);
      }
    }

    const sessionData = {
      email,
      profile,
      chunks,
      turns: [],
      userInstructions: String(userInstructions || '').trim(),
      yearsExperience: profile.yearsExperience,
      role: profile.targetRole,
      createdAt: Date.now()
    };

    interviewSessions.set(email, sessionData);

    res.json({
      ok: true,
      profile,
      chunkCount: chunks.length,
      message: 'Interview session created successfully.'
    });
  } catch (err) {
    console.error('[API /session/start error]', err);
    res.status(500).json({ ok: false, error: err.message || 'Failed to initialize session' });
  }
});

app.post('/api/session/instructions', (req, res) => {
  const email = requireLicensedRequest(req, res);
  if (!email) return;
  const session = interviewSessions.get(email);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

  session.userInstructions = String(req.body.userInstructions || '').trim();
  res.json({ ok: true, userInstructions: session.userInstructions });
});

app.get('/api/session/turns', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ ok: false, error: 'Email required' });
  const session = interviewSessions.get(email);
  res.json({ ok: true, turns: session ? session.turns : [] });
});

app.post('/api/session/clear', (req, res) => {
  const email = requireLicensedRequest(req, res);
  if (!email) return;
  const session = interviewSessions.get(email);
  if (session) session.turns = [];
  res.json({ ok: true, message: 'Turns cleared' });
});

app.post('/api/query', async (req, res) => {
  try {
    const email = requireLicensedRequest(req, res);
    if (!email) return;

    const session = interviewSessions.get(email);
    if (!session) return res.status(404).json({ ok: false, error: 'Interview session not found. Please initialize session first.' });

    const rawQuestion = String(req.body.question || '').trim();
    const provider = String(req.body.provider || 'openai').trim().toLowerCase();
    const model = String(req.body.model || LLM_DEFAULT_MODEL).trim();
    const regenerate = !!req.body.regenerate;
    const inputSource = String(req.body.inputSource || 'typed').trim();

    const lowConfError = rejectLowConfidenceInput(rawQuestion);
    if (lowConfError) {
      return res.json({ ok: true, answer: lowConfError, responseType: 'spoken' });
    }

    if (isInterviewLogisticsQuestion(rawQuestion)) {
      return res.json({ ok: true, answer: 'I hear you clearly and I am ready to continue.', responseType: 'spoken' });
    }

    const intentQuestion = reframeQuestionIntent(rawQuestion) || rawQuestion;
    const followupInfo = resolveFollowupIntent(session, intentQuestion);
    const correctedInfo = resolveCanonicalQuestion(session, intentQuestion);
    const correctedQuestion = correctedInfo.corrected;

    let retrieved = [];
    if (session.chunks && session.chunks.length > 0) {
      if (canUseFastLexical(session, correctedQuestion)) {
        retrieved = retrieveChunksLexical(session, correctedQuestion);
      } else if (OPENAI_API_KEY) {
        try {
          const queryVector = await embedQuery(correctedQuestion);
          retrieved = retrieveChunks(session, queryVector, correctedQuestion);
        } catch (_) {
          retrieved = retrieveChunksLexical(session, correctedQuestion);
        }
      } else {
        retrieved = retrieveChunksLexical(session, correctedQuestion);
      }
    }

    const promptText = buildPrompt(session, rawQuestion, retrieved, followupInfo, correctedQuestion, inputSource, intentQuestion, regenerate);
    const responseType = classifyResponseType(intentQuestion, followupInfo, inputSource);
    const maxTokens = answerTokenBudget(intentQuestion, false, responseType);

    const result = await providerResponseJson({
      provider,
      model,
      instructions: COPILOT_INSTRUCTIONS,
      input: promptText,
      effort: provider === 'cerebras' ? CEREBRAS_REASONING_EFFORT : LLM_REASONING_EFFORT,
      maxTokens: maxTokens || 1200,
      verbosity: LLM_VERBOSITY
    });

    const answer = providerOutputText(provider, result);

    session.turns.push({
      question: rawQuestion,
      intentQuestion,
      answer,
      responseType,
      timestamp: Date.now()
    });
    if (session.turns.length > MAX_HISTORY_TURNS * 2) {
      session.turns = session.turns.slice(-MAX_HISTORY_TURNS * 2);
    }

    res.json({
      ok: true,
      answer,
      responseType,
      intentQuestion,
      retrievedCount: retrieved.length
    });
  } catch (err) {
    console.error('[API /query error]', err);
    res.status(500).json({ ok: false, error: err.message || 'Query processing failed' });
  }
});

app.post('/api/vision', async (req, res) => {
  try {
    const email = requireLicensedRequest(req, res);
    if (!email) return;

    const { imageBase64, prompt } = req.body;
    if (!imageBase64) return res.status(400).json({ ok: false, error: 'imageBase64 required' });

    const instructions = 'Extract and analyze technical details, diagrams, or code from the provided image for an interview context. Be precise and structured.';
    const inputData = [
      { type: 'input_text', text: String(prompt || 'Extract code or diagram structure from image') },
      { type: 'input_image', image_url: `data:image/png;base64,${imageBase64}` }
    ];

    const data = await openAIJson('https://api.openai.com/v1/responses', {
      model: LLM_VISION_EXTRACT_MODEL,
      service_tier: OPENAI_SERVICE_TIER,
      instructions,
      input: inputData,
      max_output_tokens: 1500
    });

    const answer = outputText(data);
    res.json({ ok: true, answer });
  } catch (err) {
    console.error('[API /vision error]', err);
    res.status(500).json({ ok: false, error: err.message || 'Vision extraction failed' });
  }
});

// --- SERVER & WEBSOCKET SETUP ---

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.replace(/^.*?\?/, ''));
  const email = String(urlParams.get('email') || '').trim().toLowerCase();

  let deepgramWs = null;

  if (DEEPGRAM_API_KEY) {
    const dgUrl = 'wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&punctuate=true&interim_results=true&endpointing=300';
    try {
      deepgramWs = new WebSocket(dgUrl, {
        headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }
      });

      deepgramWs.on('open', () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'stt_connected' }));
        }
      });

      deepgramWs.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString('utf8'));
          const transcript = parsed?.channel?.alternatives?.[0]?.transcript || '';
          const isFinal = !!parsed?.is_final;
          if (transcript.trim() && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'transcript', text: transcript, isFinal }));
          }
        } catch (_) {}
      });

      deepgramWs.on('error', (err) => {
        console.warn('[Deepgram WS error]', err.message);
      });
    } catch (e) {
      console.warn('[Deepgram init error]', e.message);
    }
  }

  ws.on('message', (msg) => {
    if (Buffer.isBuffer(msg) || msg instanceof ArrayBuffer) {
      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.send(msg);
      }
    } else {
      try {
        const payload = JSON.parse(msg.toString('utf8'));
        if (payload.type === 'ping' && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (_) {}
    }
  });

  ws.on('close', () => {
    if (deepgramWs) {
      try { deepgramWs.close(); } catch (_) {}
    }
  });
});

server.listen(PORT, () => {
  console.log(`[SERVER] Ready and listening on port ${PORT}`);
});