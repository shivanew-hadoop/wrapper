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
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || 'gpt-5.6-sol').trim();
const OPENAI_PROFILE_MODEL = String(process.env.OPENAI_PROFILE_MODEL || OPENAI_MODEL).trim();
const OPENAI_VISION_MODEL = String(process.env.OPENAI_VISION_MODEL || OPENAI_MODEL).trim();
const CEREBRAS_API_KEY = String(process.env.CEREBRAS_API_KEY || '').trim();
const CEREBRAS_MODEL = String(process.env.CEREBRAS_MODEL || 'gpt-oss-120b').trim();
const CEREBRAS_API_BASE = String(process.env.CEREBRAS_API_BASE || 'https://api.cerebras.ai/v1').trim().replace(/\/$/, '');
const CEREBRAS_SERVICE_TIER = String(process.env.CEREBRAS_SERVICE_TIER || 'default').trim().toLowerCase();
// One OpenAI Responses API path for text, profile generation and vision. The surrounding
// RAG/STT/Electron architecture is intentionally unchanged.
const LLM_DEFAULT_MODEL = OPENAI_MODEL;
const LLM_PROFILE_MODEL = OPENAI_PROFILE_MODEL;
const LLM_VISION_EXTRACT_MODEL = OPENAI_VISION_MODEL;
const LLM_ROUTING_ENABLED = String(process.env.LLM_ROUTING_ENABLED || 'true').toLowerCase() !== 'false';
const LLM_ROUTER_SOL_THRESHOLD = Math.max(3, Math.min(12, Number(process.env.LLM_ROUTER_SOL_THRESHOLD || 5)));
const LLM_ROUTER_MIN_SIMPLE_CONFIDENCE = Math.max(0.5, Math.min(0.98, Number(process.env.LLM_ROUTER_MIN_SIMPLE_CONFIDENCE || 0.78)));
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

if (!DEEPGRAM_API_KEY) console.warn('[BOOT] WARNING: DEEPGRAM_API_KEY missing');
else {
  console.log('[BOOT] DEEPGRAM_API_KEY present: true');
  console.log('[BOOT] DEEPGRAM_API_KEY length:', DEEPGRAM_API_KEY.length);
}
console.log('[BOOT] OPENAI_API_KEY present:', !!OPENAI_API_KEY, '(text + embeddings + vision)');
console.log('[BOOT] LLM provider: OpenAI ->', LLM_DEFAULT_MODEL, '| profile:', LLM_PROFILE_MODEL, '| vision:', LLM_VISION_EXTRACT_MODEL, '| embedding:', EMBEDDING_MODEL, '| dims:', EMBEDDING_DIMENSIONS);
console.log('[BOOT] OpenAI service tier:', OPENAI_SERVICE_TIER, '| reasoning effort:', LLM_REASONING_EFFORT);
console.log('[BOOT] Hybrid routing:', LLM_ROUTING_ENABLED, '| Cerebras:', CEREBRAS_MODEL, '| configured:', !!CEREBRAS_API_KEY, '| Sol threshold:', LLM_ROUTER_SOL_THRESHOLD);

const app = express();
const allowedOrigins = new Set(String(process.env.CORS_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean));
app.use(cors({ origin:(origin,cb) => cb(null,!origin || allowedOrigins.size===0 || allowedOrigins.has(origin)) }));
app.use(express.json({ limit: '18mb', verify:(req,_res,buf) => { req.rawBody = Buffer.from(buf); } }));
const commerce = require('./commerce')({ app, dataDir:DATA_DIR, publicDir:path.join(__dirname, 'portal') });

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
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
  const email = String(req.body?.email || '').trim().toLowerCase();
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
    // Lightweight RTF text extraction suitable for resumes/JDs; strips control words and decodes escaped bytes.
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
    // Last-resort fallback for unknown text-like files. Binary files are rejected rather than producing garbage context.
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
function openAIResponseBody({model=LLM_DEFAULT_MODEL,instructions='',input='',effort=LLM_REASONING_EFFORT,maxTokens=420,verbosity=LLM_VERBOSITY,stream=false}) {
  return {
    model,
    service_tier:OPENAI_SERVICE_TIER,
    instructions:String(instructions||''),
    input,
    reasoning:{effort:normalizedReasoningEffort(effort)},
    text:{verbosity:String(verbosity||'medium')},
    max_output_tokens:maxTokens,
    stream:!!stream
  };
}
async function openAIResponseJson({model=LLM_DEFAULT_MODEL,instructions='',input='',effort=LLM_REASONING_EFFORT,maxTokens=420,verbosity=LLM_VERBOSITY}) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing on backend');
  return openAIJson('https://api.openai.com/v1/responses', openAIResponseBody({model,instructions,input,effort,maxTokens,verbosity,stream:false}));
}
function cerebrasMessages(instructions, input) {
  const messages=[];
  if (instructions) messages.push({role:'system',content:String(instructions)});
  messages.push({role:'user',content:typeof input==='string'?input:JSON.stringify(input)});
  return messages;
}
function cerebrasOutputText(data) { return String(data?.choices?.[0]?.message?.content || '').trim(); }
async function cerebrasJson({model=CEREBRAS_MODEL,instructions='',input='',effort='low',maxTokens=420,responseFormat=null}) {
  if (!CEREBRAS_API_KEY) throw new Error('CEREBRAS_API_KEY missing on backend');
  const body={model,messages:cerebrasMessages(instructions,input),reasoning_effort:['low','medium','high'].includes(String(effort))?String(effort):'low',reasoning_format:'hidden',max_completion_tokens:maxTokens,stream:false};
  if (CEREBRAS_SERVICE_TIER && ['default','auto','flex','priority'].includes(CEREBRAS_SERVICE_TIER)) body.service_tier=CEREBRAS_SERVICE_TIER;
  if (responseFormat) body.response_format=responseFormat;
  const response=await fetch(`${CEREBRAS_API_BASE}/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${CEREBRAS_API_KEY}`},body:JSON.stringify(body)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data?.error?.message || `Cerebras request failed (${response.status})`);
  return data;
}
async function routedJson({route,instructions,input,maxTokens,verbosity=LLM_VERBOSITY}) {
  if (route.provider==='cerebras') {
    const data=await cerebrasJson({model:route.model,instructions,input,effort:route.effort,maxTokens});
    return {data,answer:cerebrasOutputText(data),serviceTier:String(data?.service_tier_used||data?.service_tier||CEREBRAS_SERVICE_TIER)};
  }
  const data=await openAIResponseJson({model:route.model,instructions,input,effort:route.effort,maxTokens,verbosity});
  return {data,answer:outputText(data),serviceTier:String(data?.service_tier||OPENAI_SERVICE_TIER)};
}
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
  const vocab = session?.profile?.domainVocabulary || session?.profile?.primarySkills || [];
  const original = String(question || '');
  if (!vocab.length) return { corrected:original, replacements:[] };
  const replacements = [];
  const corrected = original.replace(/\b[A-Za-z][A-Za-z0-9+#.-]{1,}\b/g, token => {
    const cleanToken = token.toLowerCase().replace(/[^a-z0-9+#]/g, '');
    // Bias correction toward acronym/technology-looking STT tokens. Ordinary prose is left untouched.
    const techLike = /^[A-Z0-9+#.-]{2,}$/.test(token) || /[+#.]/.test(token) || token.length >= 5;
    if (!techLike) return token;
    let best = null;
    for (const termRaw of vocab) {
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
function fallbackProfile(resumeText, jdText, yearsExperience, role) {
  return {
    candidateSummary:`${yearsExperience} years of experience${role ? `; target role: ${role}` : ''}. ${resumeText.slice(0, 2200)}`,
    jdSummary:jdText.slice(0, 1600),
    primarySkills:Array.from(keywords(resumeText)).slice(0, 30),
    domainVocabulary:Array.from(keywords(`${resumeText} ${jdText}`)).slice(0,60),
    targetRole:role || '', yearsExperience
  };
}
async function generateStructuredProfile(resumeText, jdText, yearsExperience, role) {
  const fallback = fallbackProfile(resumeText, jdText, yearsExperience, role);
  try {
    const data = await openAIResponseJson({
      model:LLM_PROFILE_MODEL,
      instructions:'Create a compact interview-grounding profile. Return JSON only, no markdown. Never invent facts absent from the resume/JD.',
      input:`Years of experience: ${yearsExperience}
Target role: ${role || 'not specified'}

RESUME:
${resumeText.slice(0, 30000)}

JOB DESCRIPTION:
${jdText.slice(0, 24000)}

Return JSON with keys candidateSummary (max 1800 chars), jdSummary (max 1200 chars), primarySkills (array max 25), projectHighlights (array max 8), domainVocabulary (array max 60 of exact technology/product/framework/domain terms appearing in the resume or JD, preserving canonical spelling such as LangGraph, LangChain, Kubernetes), targetRole, yearsExperience.`,
      effort:'low', maxTokens:900, responseFormat:{type:'json_object'}
    });
    const raw = outputText(data);
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    const parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
    return {
      candidateSummary:normalizeText(parsed.candidateSummary || fallback.candidateSummary).slice(0, 2200),
      jdSummary:normalizeText(parsed.jdSummary || fallback.jdSummary).slice(0, 1600),
      primarySkills:Array.isArray(parsed.primarySkills) ? parsed.primarySkills.slice(0,25) : fallback.primarySkills,
      projectHighlights:Array.isArray(parsed.projectHighlights) ? parsed.projectHighlights.slice(0,8) : [],
      domainVocabulary:Array.isArray(parsed.domainVocabulary) ? parsed.domainVocabulary.map(String).slice(0,60) : fallback.primarySkills,
      targetRole:String(parsed.targetRole || role || ''),
      yearsExperience:Number(parsed.yearsExperience ?? yearsExperience),
    };
  } catch (err) {
    console.warn('[RAG] Structured profile fallback:', err.message);
    return fallback;
  }
}
function isContextualFollowup(question) {
  const q = normalizeText(question).toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  if (!q) return false;
  // Explicit references/modifiers are continuations even when they contain a technology name.
  if (/\b(it|that|this|those|these|earlier|above|same|one example|another example|more detail|what about|how about|show code|give code|convert it|rewrite it|same in|do it in|instead|another one|dry run|time complexity|space complexity|edge cases?|optimi[sz]e)\b/.test(q)) return true;
  if (/^(?:in|using)\s+(?:java|python|c#|c\+\+|javascript|typescript|go|golang|rust|kotlin|swift)\??$/.test(q)) return true;
  if (/\b(explain|walk through|why did you|why have you|modify|change|fix)\b.*\b(code|logic|line|function|method|class|solution|algorithm|loop|map|array|string)\b/.test(q)) return true;
  // A clear standalone topic question should not be attached to the prior turn just because it is short.
  if (/^(what|who|why|when|where|which)\s+(is|are|was|were|do|does|did|can|could|should|would)\b/.test(q)) return false;
  if (/^(explain|define|describe|compare|differentiate|tell me about|difference between)\b/.test(q)) return false;
  // Very short fragments such as "why?", "how?", "example?" normally depend on the previous turn.
  return words.length <= 3;
}
function cleanIntentLead(value) {
  let text=normalizeText(value)
    .replace(/^(?:(?:okay|alright|right|well|so|and|then|now|you know|basically|actually)[,.:;]?\s+)+/i,'')
    .replace(/\s+([?.!,;:])/g,'$1')
    .trim();
  if(text&&!/[?.!]$/.test(text))text+='?';
  return text;
}
function reframeQuestionIntent(rawQuestion) {
  const raw=normalizeText(rawQuestion);
  if(!raw)return '';

  // Select the last complete interviewer request locally. This avoids a second
  // LLM/classifier request and prevents incidental earlier words from deciding
  // the answer format.
  const starter=/\b(?:have you|do you|did you|can you|could you|would you|will you|are you|were you|what|why|how|when|where|which|who|describe|explain|define|compare|tell me|walk me through|write|implement|find|solve|design|draw|create|show|debug|fix|calculate|return|print)\b/gi;
  let candidate='';
  const lastQuestionMark=raw.lastIndexOf('?');
  if(lastQuestionMark>=0){
    const priorBoundary=Math.max(raw.lastIndexOf('?',lastQuestionMark-1),raw.lastIndexOf('.',lastQuestionMark-1),raw.lastIndexOf('!',lastQuestionMark-1));
    const segment=raw.slice(priorBoundary+1,lastQuestionMark+1);
    const first=segment.match(starter);
    candidate=first?segment.slice(segment.toLowerCase().indexOf(first[0].toLowerCase())):segment;
  } else {
    const pieces=raw.split(/(?<=[.!])\s+/).map(part=>part.trim()).filter(Boolean);
    const lastRequest=[...pieces].reverse().find(part=>{starter.lastIndex=0;return starter.test(part);})||raw;
    starter.lastIndex=0;
    const matches=Array.from(lastRequest.matchAll(starter)).filter((match,index,all)=>{
      if(!/^(?:have|do|did|can|could|would|will|are|were) you$/i.test(match[0]))return true;
      const prior=all.filter(item=>(item.index||0)<(match.index||0)).at(-1);
      return !prior||!/^(?:what|why|how|when|where|which|who)$/i.test(prior[0]);
    });
    const chosen=matches[matches.length-1];
    candidate=chosen?lastRequest.slice(chosen.index):lastRequest;
  }
  candidate=cleanIntentLead(candidate);

  // Resolve a common final-question pronoun from the same utterance. The raw
  // transcript is still supplied to the answer model as context, never as the
  // response-format signal.
  if(/\b(?:that|it)\b/i.test(candidate)){
    const before=raw.slice(0,Math.max(0,raw.toLowerCase().lastIndexOf(candidate.toLowerCase())));
    const references=[
      ...before.matchAll(/\b((?:agile|scrum|waterfall)\s+methodolog(?:y|ies))\b/gi),
      ...before.matchAll(/\b([A-Za-z0-9+#./-]+(?:\s+(?:and\s+)?[A-Za-z0-9+#./-]+){0,4}\s+(?:integration|framework|platform|technology|module|process|approach))\b/gi)
    ];
    const reference=references.sort((a,b)=>(a.index||0)-(b.index||0)).at(-1)?.[1];
    if(reference)candidate=candidate.replace(/\b(?:that|it)\b/i,reference);
  }
  return candidate.slice(0,2000);
}
function resolveFollowupIntent(session, question) {
  const previous = session?.turns?.[session.turns.length - 1];
  if (!previous || !isContextualFollowup(question)) return { isFollowup:false, resolvedQuestion:question, previous:null };
  return {
    isFollowup:true,
    previous,
    resolvedQuestion:`Previous interviewer request: ${previous.question}\nCurrent follow-up/modifier: ${question}`
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
function isCodingQuestion(prompt) {
  const q=normalizeText(prompt);
  if(!q)return false;
  const explicitRequest=/\b(?:write|provide|show|give|implement|complete|create|debug|fix|compile|solve)\b.{0,45}\b(?:code|program|function|method|class|algorithm|solution|implementation)\b|\b(?:code|program|function|method|algorithm|solution)\b.{0,35}\b(?:write|implement|debug|fix|complete|create)\b/i.test(q);
  const experienceQuestion=/\b(?:have you|do you have|did you|experience (?:with|in)|worked (?:with|on)|used (?:it|that|this|these|those)?\s*(?:in|on)?\s*(?:a|any|past|previous|production)|which project|tell me about your experience)\b/i.test(q);
  // Mentioning "code", "coding" or a "module" in an experience question is
  // not a request to manufacture a program.
  if(experienceQuestion&&!explicitRequest)return false;
  if(explicitRequest||/```|\b(?:leetcode|hackerrank)\b/i.test(q))return true;
  if(/\b(?:public|private|protected)\s+(?:static\s+)?(?:class|interface|void|int|string)|\bdef\s+\w+\s*\(|\bfunction\s+\w+\s*\(|\b(?:console\.log|system\.out\.println)\s*\(/i.test(q))return true;
  return /\b(?:find|return|print|calculate|check|remove|reverse|sort|search|merge|validate|count|implement|solve)\b.{0,65}\b(?:string|character|char|array|list|linked list|tree|graph|number|integer|duplicate|non[- ]?repeating|unique|palindrome|anagram|substring|subarray)\b/i.test(q)
    || /\bgiven\b.{0,55}\b(?:string|array|list|tree|graph|number|integer)\b.{0,100}\b(?:find|return|print|calculate|remove|reverse|sort|search|merge|count)\b/i.test(q)
    || /\b(?:first|last)\s+(?:non[- ]?)?(?:duplicate|repeating|unique)\s+(?:character|char|element)\b/i.test(q);
}
function isCodingFollowupQuestion(question) {
  const q=normalizeText(question);
  if(!q)return false;
  if(/\b(?:have you|do you have|experience (?:with|in)|worked (?:with|on)|which project|tell me about your experience)\b/i.test(q))return false;
  return /\b(?:this|that|above|previous|earlier|same)\s+(?:code|program|function|method|class|algorithm|solution|line|loop|condition)\b/i.test(q)
    || /\b(?:explain|change|modify|update|fix|debug|continue|rewrite|convert|optimi[sz]e|dry run)\b.{0,55}\b(?:code|program|function|method|class|algorithm|solution|line|loop|condition|hashmap|map|array|string)\b/i.test(q)
    || /\b(?:why|how)\b.{0,55}\b(?:line|loop|condition|function|method|hashmap|map|array|stack|queue|recursion|time complexity|space complexity)\b/i.test(q)
    || /\b(?:what|which)\b.{0,55}\b(?:line|loop|condition|function|method)\b/i.test(q)
    || /^(?:in|using)\s+(?:java|python|c#|c\+\+|javascript|typescript|go|golang|rust|kotlin|swift)\??$/i.test(q)
    || /\b(?:time|space) complexity\b|\bedge cases?\b/i.test(q);
}
function classifyResponseType(question,followupInfo=null,inputSource='') {
  const previous=followupInfo?.previous;
  const previousCoding=!!previous&&(previous.responseType==='code'||isCodingQuestion(previous.question)||/```|\b(class|function|def|public static|return)\b/i.test(previous.answer||''));
  if(/screen-capture-diagram/i.test(inputSource))return 'diagram';
  if(/screen-capture-code/i.test(inputSource))return 'code';
  if (isDiagramQuestion(question)) return 'diagram';
  if (isCodingQuestion(question)||(previousCoding&&isCodingFollowupQuestion(question))) return 'code';
  return 'spoken';
}
function spokenAnswerShape(question) {
  const q=normalizeText(question).toLowerCase();
  if(!q)return 'DIRECT';
  if(/\b(difference|different|compare|versus|\bvs\b|same or different)\b/i.test(q))return 'COMPARISON';
  if(/\b(advantage|advantages|feature|features|benefit|benefits|types|ways)\b/i.test(q))return 'FEATURES';
  if(/\b(out of memory|oom|production issue|performance issue|debug|troubleshoot|failing|failure|not working|latency issue|slow|incident)\b/i.test(q))return 'TROUBLESHOOTING';
  if(/\b(have you|did you|what did you|what exactly you did|your current|current engagement|recently|experience with|worked on|implemented|used in your project|in your project|tell me about your)\b/i.test(q))return 'EXPERIENCE';
  if(/\b(how do you|how did you|how would you|walk me through|flow|framework|mechanism|architecture|design|end[- ]to[- ]end|bring .* data|ingest|pipeline|implement it)\b/i.test(q))return 'IMPLEMENTATION_FLOW';
  if(/\b(what is|what are|why|when|where|which)\b/i.test(q))return 'CONCEPT';
  return 'DIRECT';
}
function responseMode(question, followupInfo=null, inputSource='') {
  const type=classifyResponseType(question,followupInfo,inputSource);
  const codingFollowup=type==='code'&&!!followupInfo?.previous&&isCodingFollowupQuestion(question);
  if (type==='code'&&codingFollowup) return 'CODING_REQUIRED_FOLLOW_UP: Answer the current follow-up directly in 1-3 short sentences. Then write "Logic:" with the simple approach in 1-2 concise lines, followed by "Complete code:" and the entire previous working solution, updated only when the follow-up requests a change. Include concise inline comments for every meaningful logical step so coding can continue without losing context.';
  if (type==='code') return 'CODING_REQUIRED: Start with "Logic:" and explain the simple approach in 1-2 concise lines. Then write "Complete code:" and provide one complete working solution in the requested or context-supported language. Include concise inline comments for every meaningful logical step.';
  if (type==='diagram') return 'DRAWABLE_DIAGRAM_REQUIRED: Give a one-line overview, then a detailed monospaced Unicode box-drawing flow that can be copied into Notepad or redrawn in draw.io. Use boxes made with ┌ ─ ┐ │ └ ┘, directional arrows, branch labels, data/control direction, external systems and failure/return paths where relevant. Follow the diagram with only the essential explanation.';
  return `SPOKEN_INTERVIEW_EXPLAINED${String(inputSource).startsWith('screen-capture')?' (screen-captured input; apply exactly the same quality and format rules as typed input)':''}`;
}
function answerTokenBudget(question, hasImage=false,responseType='') {
  const q = String(question || '');
  if (responseType==='code'||responseType==='diagram'||isCodingQuestion(q)||isDiagramQuestion(q)) return 1800;
  if (hasImage || /\b(design|architecture|system design)\b/i.test(q)) return 1000;
  if (/\b(introduce yourself|tell me about yourself|self[- ]introduction)\b/i.test(q)) return 450;
  if (wantsExpandedAnswer(q)) return 600;
  // Keep ordinary interview answers compact. The model still has enough room for
  // a direct answer plus a few useful bullets, while avoiding page-sized responses.
  return 300;
}

function buildPrompt(session, question, retrieved, followupInfo=null, correctedQuestion=question, inputSource='',intentQuestion=correctedQuestion) {
  const profile = session.profile || {};
  const history = session.turns.slice(-MAX_HISTORY_TURNS).map((t,i) => `Turn ${i+1}\nInterviewer: ${t.question}\nCandidate: ${t.answer}`).join('\n\n');
  const evidence = retrieved.map((c,i) => `[${i+1}] ${c.source.toUpperCase()} · ${c.section}\n${c.text.slice(0, 900)}`).join('\n\n');
  const info = followupInfo || resolveFollowupIntent(session, question);
  const followup = info.isFollowup
    ? `YES. Treat the current words as a continuation/modifier of the immediately previous interviewer request. Resolved intent:\n${info.resolvedQuestion}`
    : 'NO';
  return `CANDIDATE PROFILE\nYears: ${session.yearsExperience}\nTarget role: ${session.role || profile.targetRole || 'Not specified'}\n${profile.candidateSummary || ''}\nPrimary skills: ${(profile.primarySkills || []).join(', ')}\nCanonical resume/JD vocabulary: ${(profile.domainVocabulary || profile.primarySkills || []).join(', ')}\n\nJOB ALIGNMENT\n${profile.jdSummary || ''}\n\nRETRIEVED EVIDENCE\n${evidence || 'No prepared evidence matched.'}\n\nRECENT INTERVIEW CONTEXT\n${history || 'No previous turns.'}\n\nCONTEXTUAL FOLLOW-UP\n${followup}\n\nINPUT SOURCE\n${inputSource||'system-audio-or-typed'}\n\nRESPONSE MODE\n${responseMode(intentQuestion,info,inputSource)}\n\nSPOKEN ANSWER SHAPE\n${spokenAnswerShape(intentQuestion)}\n\nREFRAMED CURRENT INTENT (this alone controls answer type and requested output)\n${intentQuestion}\n\nRAW CURRENT TRANSCRIPT (context only; incidental words such as code, coding or module do not control the format)\n${correctedQuestion}\n\nDEPTH\n${wantsExpandedAnswer(intentQuestion) ? 'Expanded answer requested.' : 'Default: direct interview answer with concise practical elaboration.'}`;
}
const COPILOT_INSTRUCTIONS = `You are the candidate in a live senior/lead engineer interview. Return one directly usable answer. Normal answers must be immediately speakable; coding and diagram questions must use the exact practical formats below. Never mention AI, ChatGPT, copilot, prompts, retrieval, resume, CV, JD, transcription correction, evidence matching, or how you inferred the question. Never say "based on my CV/JD", "the resume confirms", "not listed", or similar meta commentary.

UNDERSTAND THE INTERVIEWER, NOT THE RAW TRANSCRIPT:
The input is noisy live speech. Remove repetitions, fillers and false starts such as "okay", "basically", "you know", duplicated words and incomplete lead-ins. Infer the final intended technical question from the complete current utterance plus recent interview turns. Silently repair phonetic technology names from the canonical Resume/JD vocabulary and surrounding topic. Never say "you mean", "not X", "I assume", or ask for confirmation when one interpretation is clearly supported by context.

Use REFRAMED CURRENT INTENT as the authoritative current question and RESPONSE MODE as the authoritative output format. RAW CURRENT TRANSCRIPT is context only. The mere presence of words such as code, coding, development, DevOps, program, class, module, Java or Python never makes an experience, behavioral, conceptual or project question a coding task. Do not carry a prior coding format into a new topic. Continue in coding format only when the current intent explicitly requests implementation/code or clearly asks about the immediately previous code.

Treat adjacent/continued interviewer fragments as one intent only when they are clearly related. If the current fragment completes the prior question, answer the combined question. If one captured utterance contains two or more unrelated questions/topics, treat the LAST complete question as the intentional current request and ignore the earlier unrelated question(s). Combine multiple questions only when the interviewer explicitly asks to answer both/all of them or they are clearly parts of one request. Pronouns/modifiers such as "it", "that", "this", "those", "same", "using Java", "give one example", "give me two", "the second one", "what about security", and "how does that flow work" inherit the immediately preceding topic. Preserve explicit constraints exactly: requested count, language, format, scenario, flow, comparison, code contract, or output.

ANSWER PRIORITY AND SHAPE:
1. Answer exactly the last complete interviewer intent. The first sentence must contain the answer I can say immediately. Do not start with acknowledgement, restatement, a dictionary definition, or generic background.
2. SPOKEN ANSWER SHAPE is authoritative for normal spoken answers:
   - DIRECT / CONCEPT: 1 direct sentence, then at most 1 short supporting paragraph. If a definition is necessary, keep it to one sentence and immediately explain the production meaning or usage.
   - FEATURES: 1 direct sentence, blank line, then 3-5 short hyphen bullets. Each bullet must state the feature and the practical reason it matters.
   - COMPARISON: 1-line distinction, blank line, then 2-4 labelled hyphen bullets. Compare the decision/use case, not just definitions.
   - EXPERIENCE: 1 direct first-person sentence, then 2-4 short production-focused sentences or bullets covering what I owned, the tools actually used, how the flow worked, and the practical outcome. Never manufacture a named technology just because the JD asks for it.
   - IMPLEMENTATION_FLOW: 1 direct architecture/implementation choice, blank line, then 3-6 ordered hyphen bullets showing source -> processing -> controls -> target/consumer. Use concrete production mechanics such as retries, idempotency, DQ, RBAC, orchestration or monitoring only when relevant.
   - TROUBLESHOOTING: immediate production action first, blank line, then 3-5 ordered hyphen bullets covering evidence collection, isolation, fix, and validation. Do not guess one root cause without evidence.
3. Readability is mandatory. Never emit one dense wall of text for a multi-point answer. Put each bullet on its own line and put one blank line before a bullet block. For non-bulleted answers longer than three sentences, use short paragraphs of 1-2 sentences each.
4. Prefer implementation reality over textbook theory. Explain what runs, where it runs, what data moves, what control is applied, and why the choice is made. Avoid generic phrases such as "it improves scalability", "it is robust", or "it provides seamless integration" unless you name the concrete mechanism that makes that true.
5. Match length to the question. Narrow factual/correction/follow-up: 1-3 sentences. Normal experience/concept/implementation: roughly 20-40 seconds of speech. End-to-end or explicitly detailed flow: roughly 40-60 seconds. Do not fill the token budget merely because it is available.
6. Strictly answer the boundary asked. Do not volunteer adjacent technologies, security controls, observability, framework variants, or architecture patterns unless they directly answer the current question.
7. Preserve concrete values/examples from the interviewer. If the interviewer gives a number, SLA, source system, failure point, or requested count, use that exact constraint in the answer.
8. Sound like a senior engineer speaking naturally: clear, practical, first-person where factual, and immediately speakable. Use complete sentences, not keyword chains. Avoid bookish definitions and sales-style wording.
9. Do not repeat a stock answer across questions. Adapt to the current intent, actual Resume evidence, JD priorities, years of experience, target role and recent interview context without exposing those sources.
10. Prefer current production approaches; use legacy approaches only when asked or when the supplied experience specifically requires them.

FACTUAL OWNERSHIP / RESUME GROUNDING — NON-NEGOTIABLE:
- Resume evidence is the only authority for claims that I personally used, built, implemented, owned, deployed, migrated, optimized or operated something. JD content describes the target role; it is NOT evidence that I did it.
- Never convert a JD requirement into past experience. Never invent a client use case, metric, architecture, Cortex implementation, fraud use case, contract analytics implementation, vector store, Streamlit dashboard, Snowpipe pipeline, or any other project detail unless Resume evidence supports it.
- When Resume evidence supports the surrounding platform but not the exact named feature, answer maturely: state the boundary once, then connect the closest real production work and explain how I would implement the requested feature. Example pattern: "My recent Snowflake work was on governed AI/platform integration rather than a production Cortex Analyst implementation specifically. I owned <supported work>. For Cortex Analyst, I would extend that foundation by <practical implementation>." Do not sound defensive and do not mention the Resume/JD.
- If the technology is completely unsupported by Resume evidence, say once: "I haven't used <technology> in production." Then give 3-5 practical implementation points showing how I would approach it. Do not pretend production ownership.
- If supported, prefer strong ownership language such as "I built", "I implemented", "I owned", "I handled", or "I used" and tie it to the actual project context and production mechanics.
- Never invent numerical improvements or latency reductions unless the supplied Resume evidence contains that metric.

SELF INTRODUCTION:
If asked for self-introduction/introduction/about yourself, produce one natural approximately 2-minute spoken introduction using the candidate's actual experience, strongest role-relevant projects/skills, production ownership and current target direction. Do not say it is aligned to the Resume/JD and do not list every skill. It must sound spoken, not like a profile summary.

SCENARIO / SECURITY / ARCHITECTURE QUESTIONS:
Only when the interviewer gives a TRUE hypothetical scenario/problem that requires design choices (for example: 'suppose...', 'design...', 'how would you handle this situation...'), start with 1-2 short, useful clarification questions I can ask before the solution. Do NOT treat an experience question ('what challenges did you face?'), a security/architecture topic by itself, a narrow follow-up, a challenge/correction, or a direct 'why' question as scenario-based. For those, answer immediately. For a true scenario, format the opening exactly for easy reading: start the first clarification with 'Can you please clarify on ' followed by the single most important clarification question. If a second clarification is genuinely useful, start it with 'Kindly confirm on ' followed by the confirmation question. Do not say 'I would clarify', 'I would ask', 'before I proceed', or similar narration. After those 1-2 questions, continue directly with the concise implementation solution using the best reasonable assumptions and relevant prior context.
Answer the boundary actually asked. Trace the real request/token/data flow point-to-point where relevant. If asked for N scenarios, give exactly N. Mention technologies such as MCP, direct API, OBO, managed identity, client credentials, RBAC, Key Vault, queues, caches, etc. only when they directly explain the requested scenario or are supported by context. Give the implementation choice and operational reason, not a textbook definition.

CODING QUESTIONS:
When RESPONSE MODE says CODING_REQUIRED, code is mandatory even if the question came from screen capture and even if the interviewer did not literally say "code". Start with "Logic:" and give the simple approach in 1-2 concise lines. Then write "Complete code:" and provide one complete working end-to-end solution. Add concise inline comments to every meaningful logical step so I can explain it line by line. Preserve the requested language, visible method/class signatures, input/output contract and constraints. Never return explanation alone for an algorithmic problem. For a coding follow-up, place the requested explanation/change first and then repeat the complete earlier code, updated when required, so the candidate can continue from the full solution. A language-only follow-up preserves the previous task exactly and rewrites the complete solution in that language. For a visible error/edit, identify the exact failing block and still provide the complete corrected program when enough context is available. Mention complexity and edge cases briefly after code when useful.

FLOW / ARCHITECTURE DIAGRAM QUESTIONS:
When RESPONSE MODE says DRAWABLE_DIAGRAM_REQUIRED, a diagram is mandatory. Give one short overview line, then provide a detailed monospaced Unicode box-drawing diagram designed to be copied into Notepad or redrawn in draw.io. Build real boxes with ┌ ─ ┐ │ └ ┘, use a vertical layout where possible, and include arrows with direction, numbered steps, labelled decision branches, request/data paths, external dependencies, storage and error/return paths relevant to the question. Do not use a one-line arrow sentence or bracket-only placeholders such as [Component]. Do not substitute a prose-only architecture explanation. After the diagram, add only the concise explanation needed to present the flow.

FORMAT:
Return plain text only. Do not use Markdown bold/italic markers, decorative emphasis or colour-oriented formatting. Make the answer visually readable in the existing plain-text overlay: one direct opening sentence/paragraph, then a blank line before bullets when bullets are useful. Use hyphen bullets only; keep them short and normally limit them to 3-5. For comparison/difference questions, prefer paired bullets such as "- OAuth 2.0: ..." and "- JWT: ...", followed by one short practical conclusion when useful. For a narrow fact or yes/no follow-up, stay with 1-3 sentences and no bullets. For small coding questions, do not create a page of explanation: give Logic in 1-2 lines, Complete code with the smallest complete runnable solution, and at most 1-2 lines after it for complexity/edge cases. The minimal labels "Logic:", "Complete code:" and "Flow diagram:" are required only for their matching response modes. Fenced code blocks are allowed when needed to preserve runnable code. Do not give competing solutions unless explicitly asked. Avoid generic transitions such as 'First', 'Second', 'Finally' unless sequence itself matters. Prefer concrete production nouns, exact roles/operations and the reason they were used. If the request is unclear, corrupted, unrelated to an interview, or cannot be answered reliably from the question and supplied context, say that briefly and ask for a clearer interview question; never invent missing facts. The final output must be accurate, question-specific and sufficiently explained for the candidate to speak without mentally expanding keywords. Before returning, remove only content that is repetitive, generic, or outside the exact question; do not remove the short implementation explanation that makes the answer interview-ready.

INTERVIEW ANSWER SHAPE CALIBRATION:
Interviewer: "How did you secure integrations?" Candidate shape: Start with one direct first-person answer, then explain the 2-4 relevant controls as complete sentences—for example authentication, transport protection, credential storage and authorization—only when supported by context. Do not return a comma-separated technology list.
Interviewer: "Data is not coming on the landing page. How do you debug it?" Candidate shape: Give the starting check, then walk through the practical troubleshooting sequence (client/API response, data source/data page, logs/tracer, UI mapping/access) in concise complete sentences.
Interviewer: "What happens when a user opens a case?" Candidate shape: Explain the runtime flow in order from client request to API/data retrieval, server-side access/business-rule evaluation, client rendering and action submission. Keep it conversational and technically specific.

INTERVIEW PRESENTATION CALIBRATION:
- Narrow factual question: answer directly in 1-3 sentences. Example shape: "Integer division by zero throws ArithmeticException at runtime. If the divisor is the literal 0 in a constant expression, Java can reject it at compile time."
- Feature/advantage question: one direct sentence, then 3-5 short bullets with the feature and why it matters.
- Difference/comparison question: one-line distinction first, then 2-4 compact labelled bullets. Do not write a long essay.
- Experience/project question: speak in first person only when supported by retrieved resume evidence; give what I used, where/how I used it, and the practical result in 2-4 concise sentences.
- Troubleshooting/scenario question: give the immediate production action first, then 3-5 ordered hyphen bullets covering diagnosis, evidence, fix, and validation. Do not guess a single root cause without evidence.
- Small code request: smallest complete working code that answers the request; avoid framework scaffolding unless the interviewer asked for it.
- If the interviewer mispronounces a technical term, silently infer it from context and answer the intended term without calling out the transcription error.

CALIBRATION EXAMPLES:
Interviewer: "Do you need Contributor at runtime?" Candidate: "No. Runtime only needs the least-privileged data-plane role required for reads. Contributor is needed only for deployment or management operations that change resources."
Interviewer: "Have you used ToolX in production?" Candidate: "I haven't used ToolX in production. I understand its core pattern and would validate it first with a small POC covering integration, failure handling, security, and observability."
Interviewer: "You mentioned code in your DevOps project. Have you used Agile methodology?" Candidate format: normal concise spoken experience answer; never Logic/Complete code.
Interviewer: "Find the first non-repeating character in a string." Candidate format: Logic plus complete runnable code with inline comments.
After a coding turn, interviewer: "Do you have experience with Xpedition and Capital integration?" Candidate format: normal concise spoken experience answer; never repeat the earlier code.
Interviewer: "asdf asdf asdf" Candidate: "I’m not sure what you’re asking. Please rephrase the question."`
function strictModeInstructions(responseType) {
  if(responseType==='code')return 'NON-NEGOTIABLE OUTPUT CONTRACT: This is a coding response. Explanation without a complete compilable/runnable solution is invalid. Output Logic:, then Complete code:, then the full code with meaningful inline comments. For a follow-up, include the entire previous solution again after the explanation.';
  if(responseType==='diagram')return 'NON-NEGOTIABLE OUTPUT CONTRACT: This is a diagram response. A prose chain on one line is invalid. Output Flow diagram:, then a multi-line Notepad-friendly Unicode diagram containing at least three real boxes made with ┌ ─ ┐ │ └ ┘ and connected by directional arrows. Include relevant labelled branches and supporting components.';
  return '';
}
function removeExactRepeatedOutput(value) {
  const text=normalizeStructuredText(value);
  if(text.length<100)return text;
  const needle=text.slice(0,Math.min(90,Math.floor(text.length/3))).trim();
  const second=needle.length>=35?text.indexOf(needle,needle.length):-1;
  if(second>0){
    const firstHalf=text.slice(0,second).trim();
    const secondHalf=text.slice(second).trim();
    if(normalizeText(firstHalf)===normalizeText(secondHalf))return firstHalf;
  }
  return text;
}
function hasCompleteCode(answer) {
  const text=String(answer||'');
  const lines=text.split('\n').filter(line=>line.trim()).length;
  const executable=/```|\b(class|interface|function|def|public static|static void|return|for\s*\(|while\s*\(|if\s*\(|console\.log|System\.out)\b/i.test(text);
  const commented=/\/\/|\/\*|^\s*#(?!#)/m.test(text);
  return lines>=8&&executable&&commented;
}
function hasDrawableDiagram(answer) {
  const text=String(answer||'');
  const tops=(text.match(/^\s*┌[─-]{3,}┐\s*$/gm)||[]).length;
  const bottoms=(text.match(/^\s*└[─-]{3,}┘\s*$/gm)||[]).length;
  const connectors=(text.match(/[↓↑→←↔]|(?:--?>)|(?:\n\s*[│|]\s*\n)/g)||[]).length;
  return Math.min(tops,bottoms)>=3&&connectors>=2;
}
function wrapDiagramLabel(value,maxWidth=48) {
  const words=normalizeText(value).replace(/^\[[\s]*|[\s]*\]$/g,'').split(/\s+/).filter(Boolean);
  const lines=[];
  let line='';
  for(const word of words){
    if(!line){line=word.slice(0,maxWidth);continue;}
    if(`${line} ${word}`.length<=maxWidth)line+=` ${word}`;
    else {lines.push(line);line=word.slice(0,maxWidth);}
  }
  if(line)lines.push(line);
  return lines.length?lines:['Step'];
}
function renderDiagramBox(label) {
  const lines=wrapDiagramLabel(label);
  const width=Math.max(24,Math.min(48,Math.max(...lines.map(line=>line.length))));
  const fitted=[];
  for(const line of lines){
    if(line.length<=width)fitted.push(line);
    else for(let start=0;start<line.length;start+=width)fitted.push(line.slice(start,start+width));
  }
  const finalWidth=Math.max(24,...fitted.map(line=>line.length));
  const rule='─'.repeat(finalWidth+2);
  return [`┌${rule}┐`,...fitted.map(line=>`│ ${line.padEnd(finalWidth)} │`),`└${rule}┘`].join('\n');
}
function makeDrawableDiagram(answer) {
  const clean=removeExactRepeatedOutput(answer);
  if(hasDrawableDiagram(clean))return clean;
  const segments=clean.split(/\n|(?<=[.!?])\s+/).map(item=>item.trim()).filter(Boolean);
  const chain=segments.sort((a,b)=>(b.match(/→|--?>/g)||[]).length-(a.match(/→|--?>/g)||[]).length)[0]||'';
  let chainText=chain.includes(':')?chain.slice(chain.indexOf(':')+1):chain;
  const parts=chainText.split(/\s*(?:→|--?>)\s*/).map(item=>item.replace(/^[,;:\s]+|[.;:\s]+$/g,'').trim()).filter(Boolean);
  if(parts.length<3)return clean;
  const diagram=parts.map((item,index)=>`${index?'             ↓\n':''}${renderDiagramBox(item)}`).join('\n');
  const foundation=segments.find(item=>/\b(master[- ]data foundation|below that|supporting components?)\b/i.test(item));
  const foundationBoxes=foundation?foundation.replace(/^.*?:\s*/,'').replace(/[.]$/,'').split(/\s*,\s*|\s+and\s+/i).map(item=>item.trim()).filter(Boolean).map(renderDiagramBox).join('\n       ↓ supports\n'):'';
  return `Flow diagram:\n\n${diagram}${foundationBoxes?`\n\nSupporting foundation:\n${foundationBoxes}\n       ↓ supports the complete flow`:''}`;
}
function formatSpokenAnswer(value) {
  let text=removeExactRepeatedOutput(value);
  if(!text)return text;
  // Recover list formatting when a provider emits bullets inline.
  text=text.replace(/\s+(?=-\s+(?:[A-Z0-9@]|First\b|Next\b|Then\b|Finally\b))/g,'\n');
  text=text.replace(/\s+(?=\d+[.)]\s+[A-Z])/g,'\n');
  const lines=text.split('\n').map(line=>line.replace(/[ \t]+$/,'').trimEnd());
  let firstBullet=lines.findIndex(line=>/^\s*(?:-|\d+[.)])\s+/.test(line));
  if(firstBullet>0 && lines[firstBullet-1].trim()!=='')lines.splice(firstBullet,0,'');
  text=lines.join('\n').replace(/\n{3,}/g,'\n\n').trim();
  // If a longer spoken answer still arrives as one paragraph, make it readable
  // without changing wording: group complete sentences into short paragraphs.
  if(!text.includes('\n') && text.length>360){
    const sentences=text.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);
    if(sentences.length>=4){
      const paras=[];
      for(let i=0;i<sentences.length;i+=2)paras.push(sentences.slice(i,i+2).join(' '));
      text=paras.join('\n\n');
    }
  }
  return text;
}
async function ensureModeConformance({answer,responseType,prompt,model,effort}) {
  let clean=removeExactRepeatedOutput(answer);
  if(responseType==='diagram'){
    clean=makeDrawableDiagram(clean);
    if(hasDrawableDiagram(clean))return {answer:clean,repaired:clean!==answer};
  } else if(responseType==='code'&&hasCompleteCode(clean))return {answer:clean,repaired:clean!==answer};
  else if(responseType==='spoken'){const formatted=formatSpokenAnswer(clean);return {answer:formatted,repaired:formatted!==answer};}

  try {
    const correction=await openAIResponseJson({
      model,
      instructions:`${COPILOT_INSTRUCTIONS}

${strictModeInstructions(responseType)}`,
      input:`Produce the required final answer now. The earlier output violated the mandatory ${responseType} format. Do not discuss the violation.

ORIGINAL REQUEST AND CONTEXT:
${typeof prompt==='string'?prompt:JSON.stringify(prompt)}

INCOMPLETE OUTPUT TO REPLACE:
${clean}`,
      effort,maxTokens:1800
    });
    clean=removeExactRepeatedOutput(outputText(correction));
    if(responseType==='diagram')clean=makeDrawableDiagram(clean);
    return {answer:clean,repaired:true};
  } catch(err) {
    console.warn(`[LLM format] ${responseType} correction failed:`,err.message);
    return {answer:clean,repaired:clean!==answer};
  }
}
function selectAnswerRoute(question, prepared=null, options={}) {
  // Conservative, zero-network classifier: ambiguity goes to Sol. This avoids adding a classifier API call/TTFT.
  const q=normalizeText(prepared?.intentQuestion || question || '').toLowerCase();
  const responseType=String(prepared?.responseType || 'spoken');
  if (!LLM_ROUTING_ENABLED || !CEREBRAS_API_KEY) return {provider:'openai',model:LLM_DEFAULT_MODEL,effort:LLM_REASONING_EFFORT,tier:'openai-sol-fast',reason:!LLM_ROUTING_ENABLED?'routing-disabled':'cerebras-unavailable',score:99,confidence:1};
  if (options.hasImage) return {provider:'openai',model:LLM_DEFAULT_MODEL,effort:LLM_REASONING_EFFORT,tier:'openai-sol-fast',reason:'vision-or-screen',score:99,confidence:1};

  let score=0; const reasons=[];
  const hit=(re,pts,label)=>{if(re.test(q)){score+=pts;reasons.push(label);}};
  if (responseType==='code' || responseType==='diagram') { score+=12; reasons.push(responseType); }
  hit(/\b(design|architect|architecture|system design|high level design|low level design|hld|lld|scalab|trade[- ]?off|distributed|microservice|event[- ]driven)\b/i,6,'architecture');
  hit(/\b(debug|fix|error|exception|failing|failure|root cause|troubleshoot|optimi[sz]e|performance issue|memory leak|race condition|deadlock)\b/i,6,'debug-analysis');
  hit(/\b(scenario|suppose|imagine|what would you do|how would you handle|production issue|incident|migration|strategy|approach|end[- ]to[- ]end)\b/i,5,'scenario');
  hit(/\b(implement|write (?:a |the )?code|algorithm|data structure|complexity|sql query|query to|program|function|class|api design)\b/i,6,'implementation');
  hit(/\b(my|your) (?:project|experience|resume|cv|role|team|application|system)\b|\baccording to (?:my|the) (?:resume|jd|job description)\b/i,5,'candidate-grounded');
  hit(/\b(compare|versus|\bvs\b|difference between).*(?:and|vs|versus)\b/i,2,'comparison');
  hit(/\b(why|how)\b.*\b(?:internally|under the hood|in production|at scale)\b/i,4,'deep-explanation');
  if (prepared?.followupInfo?.isFollowup) { score+=5; reasons.push('follow-up'); }
  if ((prepared?.retrieved||[]).some(c=>Number(c.score||0)>=0.42)) { score+=2; reasons.push('strong-rag-context'); }
  if (q.length>420) { score+=3; reasons.push('long-query'); } else if (q.length>260) { score+=2; reasons.push('medium-query'); }
  if ((q.match(/\?/g)||[]).length>1) { score+=2; reasons.push('multi-part'); }

  // Only clearly self-contained interview questions qualify for the fast/cheap path.
  let simple=0;
  if (/^(what is|what are|define|explain|tell me about|difference between|what do you mean by|when do you use|why do we use|how does|how do)\b/i.test(q)) simple+=2;
  if (q.length<=180) simple+=1;
  if (score===0) simple+=1;
  const confidence=Math.min(0.97,0.55+(simple*0.11)-(Math.min(score,8)*0.035));
  const useSol=score>=LLM_ROUTER_SOL_THRESHOLD || confidence<LLM_ROUTER_MIN_SIMPLE_CONFIDENCE;
  return useSol
    ? {provider:'openai',model:LLM_DEFAULT_MODEL,effort:LLM_REASONING_EFFORT,tier:'openai-sol-fast',reason:reasons.join('+')||'quality-conservative',score,confidence}
    : {provider:'cerebras',model:CEREBRAS_MODEL,effort:'low',tier:'cerebras-fast',reason:'simple-self-contained',score,confidence};
}
function addTurn(session, question, answer, retrieved=[],responseType='spoken') {
  session.turns.push({ question:normalizeStructuredText(question).slice(0,4000), answer:normalizeStructuredText(answer).slice(0,14000), responseType, retrieved:retrieved.slice(0, TOP_K).map(c => ({source:c.source, section:c.section, text:c.text, score:c.score})), at:Date.now() });
  if (session.turns.length > MAX_HISTORY_TURNS) session.turns = session.turns.slice(-MAX_HISTORY_TURNS);
}
async function prepareQuestion(email, question, {inputSource=''}={}) {
  const startedAt = Date.now();
  const session = interviewSessions.get(email);
  let retrieved = [];
  let embeddingMs = 0, retrievalMs = 0;
  let retrievalMode = 'none';
  const canonical = session ? resolveCanonicalQuestion(session, question) : { corrected:question, replacements:[] };
  const correctedQuestion = canonical.corrected || question;
  const intentQuestion=reframeQuestionIntent(correctedQuestion)||correctedQuestion;
  const rejection = rejectLowConfidenceInput(intentQuestion);
  const followupInfo = session ? resolveFollowupIntent(session, intentQuestion) : { isFollowup:false, resolvedQuestion:intentQuestion, previous:null };
  const responseType=classifyResponseType(intentQuestion,followupInfo,inputSource);

  if (!rejection && session?.chunks?.length) {
    const previous = followupInfo.previous;
    const retrievalBase = followupInfo.isFollowup ? followupInfo.resolvedQuestion : intentQuestion;
    const retrievalQuery = expandQuestionWithCanonicalTerms(session, retrievalBase);

    if (followupInfo.isFollowup && previous?.retrieved?.length) {
      // Reuse prior evidence for modifier/pronoun follow-ups. This preserves topic continuity and removes an embedding network hop.
      retrieved = previous.retrieved.map(c => ({...c}));
      retrievalMode = 'history-reuse';
    } else if (canUseFastLexical(session, retrievalQuery)) {
      const r0 = Date.now();
      retrieved = retrieveChunksLexical(session, retrievalQuery);
      retrievalMs = Date.now() - r0;
      retrievalMode = 'lexical-fast';
    } else {
      const e0 = Date.now();
      const vector = await embedQuery(retrievalQuery);
      embeddingMs = Date.now() - e0;
      const r0 = Date.now();
      retrieved = retrieveChunks(session, vector, retrievalQuery);
      retrievalMs = Date.now() - r0;
      retrievalMode = 'vector-hybrid';
    }
  }
  const prompt = session ? buildPrompt(session, question, retrieved, followupInfo, correctedQuestion,inputSource,intentQuestion) : `INPUT SOURCE\n${inputSource||'system-audio-or-typed'}\n\nRESPONSE MODE\n${responseMode(intentQuestion,followupInfo,inputSource)}\n\nREFRAMED CURRENT INTENT\n${intentQuestion}\n\nRAW CURRENT TRANSCRIPT (context only)\n${correctedQuestion}\n\nDEPTH\n${wantsExpandedAnswer(intentQuestion) ? 'Expanded answer requested.' : 'Default: direct interview answer with concise practical elaboration.'}`;
  return { session, prompt, retrieved, rejection, followupInfo, responseType, correctedQuestion, intentQuestion, canonicalReplacements:canonical.replacements, latency:{ startedAt, embeddingMs, retrievalMs, retrievalMode, promptReadyMs:Date.now()-startedAt } };
}
app.get('/', (_req, res) => res.json({ ok:true, service:'Topper Backend', stt:'/stt', llm:'/ask', llmStream:'/ask/stream', prepare:'/prepare-context', llmProvider:'hybrid', llmModel:LLM_DEFAULT_MODEL, openaiServiceTier:OPENAI_SERVICE_TIER, reasoningEffort:LLM_REASONING_EFFORT, visionProvider:'openai', llmRouting:{enabled:LLM_ROUTING_ENABLED,mode:'cerebras-simple-sol-complex',simpleModel:CEREBRAS_MODEL,qualityModel:LLM_DEFAULT_MODEL,solThreshold:LLM_ROUTER_SOL_THRESHOLD}, embeddingModel:EMBEDDING_MODEL }));
app.get('/health', (_req, res) => res.json({ ok:true, llmProvider:'hybrid', llmModel:LLM_DEFAULT_MODEL, openaiConfigured:!!OPENAI_API_KEY, cerebrasConfigured:!!CEREBRAS_API_KEY, cerebrasModel:CEREBRAS_MODEL, routingEnabled:LLM_ROUTING_ENABLED, openaiServiceTier:OPENAI_SERVICE_TIER, reasoningEffort:LLM_REASONING_EFFORT }));

app.post('/validate-license', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ ok:false, reason:'email required' });
  const result = isLicenseValid(email);
  return res.status(result.ok ? 200 : 401).json(result);
});

app.post('/prepare-context', async (req, res) => {
  const email = requireLicensedRequest(req, res); if (!email) return;
  if (!OPENAI_API_KEY) return res.status(500).json({ ok:false, error:'OPENAI_API_KEY missing on backend' });
  if (!OPENAI_API_KEY) return res.status(500).json({ ok:false, error:'OPENAI_API_KEY missing on backend' });
  const yearsExperience = Number(req.body.yearsExperience);
  const role = normalizeText(req.body.role || '').slice(0,160);
  if (!Number.isFinite(yearsExperience) || yearsExperience < 0 || yearsExperience > 60) return res.status(400).json({ ok:false, error:'Valid yearsExperience is required' });
  if (!req.body.resume) return res.status(400).json({ ok:false, error:'Resume is required' });
  const t0 = Date.now();
  try {
    const [resumeText, jdFileText] = await Promise.all([extractDocumentText(req.body.resume), extractDocumentText(req.body.jd)]);
    const jdText = normalizeText(`${jdFileText}\n${String(req.body.jdText || '')}`).slice(0, MAX_DOCUMENT_CHARS);
    if (jdText.length < 30) return res.status(400).json({ ok:false, error:'Job description is required' });
    const parseMs = Date.now() - t0;

    const summaryStart = Date.now();
    const profile = await generateStructuredProfile(resumeText, jdText, yearsExperience, role);
    const summaryMs = Date.now() - summaryStart;

    const chunks = [...semanticChunks(resumeText, 'resume'), ...semanticChunks(jdText, 'jd')];
    const embeddingStart = Date.now();
    const vectors = await embedTexts(chunks.map(c => `${c.source}: ${c.section}\n${c.text}`));
    if (vectors.length !== chunks.length) throw new Error('Embedding count did not match document chunks');
    chunks.forEach((c,i) => { c.embedding = vectors[i]; });
    const embeddingMs = Date.now() - embeddingStart;

    interviewSessions.set(email, {
      email, yearsExperience, role, profile, chunks, turns:[], preparedAt:Date.now(),
      stats:{ resumeChars:resumeText.length, jdChars:jdText.length, chunkCount:chunks.length, parseMs, summaryMs, embeddingMs }
    });
    console.log(`[RAG] Prepared ${email}: ${chunks.length} chunks in ${Date.now()-t0}ms`);
    return res.json({ ok:true, chunkCount:chunks.length, profile:{ yearsExperience, targetRole:profile.targetRole || role, primarySkills:(profile.primarySkills || []).slice(0,12) }, latency:{ parseMs, summaryMs, embeddingMs, totalMs:Date.now()-t0 } });
  } catch (err) {
    console.error('[RAG] Prepare error:', err.message);
    return res.status(500).json({ ok:false, error:err.message || 'Context preparation failed' });
  }
});

app.post('/context-status', (req, res) => {
  const email = requireLicensedRequest(req, res); if (!email) return;
  const session = interviewSessions.get(email);
  res.json({ ok:true, prepared:!!session, stats:session?.stats || null, preparedAt:session?.preparedAt || null });
});

app.post('/ask', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const text = normalizeStructuredText(req.body.text || '');
  if (!email || !text) return res.status(400).json({ ok:false, error:'email and text are required' });
  const license = isLicenseValid(email); if (!license.ok) return res.status(401).json({ ok:false, error:license.reason || 'Invalid license' });
  if (!OPENAI_API_KEY) return res.status(500).json({ ok:false, error:'OPENAI_API_KEY missing on backend' });
  if (text.length > 12000) return res.status(400).json({ ok:false, error:'Transcript input too long' });
  try {
    const prepared = await prepareQuestion(email, text);
    if (prepared.rejection) return res.json({ ok:true, answer:prepared.rejection, model:'local-guard', modelTier:'local', contextPrepared:!!prepared.session, retrieved:[], latency:{...prepared.latency, llmMs:0, totalMs:Date.now()-prepared.latency.startedAt} });
    const route = selectAnswerRoute(text, prepared);
    const llmStart = Date.now();
    let routed;
    try {
      routed=await routedJson({route,instructions:`${COPILOT_INSTRUCTIONS}

${strictModeInstructions(prepared.responseType)}`,input:prepared.prompt,maxTokens:answerTokenBudget(text,false,prepared.responseType)});
    } catch (primaryErr) {
      if (route.provider!=='cerebras') throw primaryErr;
      console.warn('[LLM router] Cerebras failed; falling back to Sol:',primaryErr.message);
      route.provider='openai'; route.model=LLM_DEFAULT_MODEL; route.effort=LLM_REASONING_EFFORT; route.tier='openai-sol-fast-fallback'; route.reason+=':cerebras-fallback';
      routed=await routedJson({route,instructions:`${COPILOT_INSTRUCTIONS}

${strictModeInstructions(prepared.responseType)}`,input:prepared.prompt,maxTokens:answerTokenBudget(text,false,prepared.responseType)});
    }
    const data=routed.data;
    let answer=routed.answer;
    answer=(await ensureModeConformance({answer,responseType:prepared.responseType,prompt:prepared.prompt,model:LLM_DEFAULT_MODEL,effort:LLM_REASONING_EFFORT})).answer;
    if (prepared.session && answer) addTurn(prepared.session,prepared.intentQuestion||text,answer,prepared.retrieved,prepared.responseType);
    const latency = { embeddingMs:prepared.latency.embeddingMs, retrievalMs:prepared.latency.retrievalMs, retrievalMode:prepared.latency.retrievalMode, promptReadyMs:prepared.latency.promptReadyMs, llmMs:Date.now()-llmStart, totalMs:Date.now()-prepared.latency.startedAt };
    const providerServiceTier=String(routed?.serviceTier||data?.service_tier||OPENAI_SERVICE_TIER);
    console.log(`[LLM] ${email} model=${route.model} modelTier=${route.tier} serviceTier=${providerServiceTier} total=${latency.totalMs}ms embed=${latency.embeddingMs}ms retrieve=${latency.retrievalMs}ms mode=${prepared.latency.retrievalMode} llm=${latency.llmMs}ms`);
    return res.json({ ok:true, answer, model:route.model, modelTier:route.tier, serviceTier:providerServiceTier, contextPrepared:!!prepared.session, retrieved:prepared.retrieved.map(c => ({source:c.source, section:c.section, score:Number(c.score.toFixed(3))})), latency });
  } catch (err) {
    console.error('[LLM] Request error:', err.message);
    return res.status(502).json({ ok:false, error:err.message || 'LLM request failed' });
  }
});


function buildCaptureContext(session) {
  if (!session) return '';
  const profile = session.profile || {};
  const recent = (session.turns || []).slice(-2).map((t,i) => `Recent Q${i+1}: ${t.question}\nRecent A${i+1}: ${t.answer}`).join('\n');
  const skills = Array.isArray(profile.primarySkills) ? profile.primarySkills.slice(0,18).join(', ') : '';
  return normalizeText(`Candidate role: ${profile.targetRole || session.role || ''}\nYears experience: ${session.yearsExperience}\nPrimary skills: ${skills}\n${recent}`);
}

function buildVisionInput(text, imageDataUrl, session, captureSource='') {
  const context = buildCaptureContext(session);
  const instruction = normalizeText(`${text || 'Analyze and solve the captured screen.'}\n\nCAPTURE CONTEXT\n${captureSource ? `Window: ${captureSource}\n` : ''}${context ? `${context}\n` : ''}Rules for screen tasks:\n- Read the screenshot directly; do not ask me to transcribe visible code or question text.\n- Identify the last complete question intent before choosing an answer format.\n- A mention of code, coding, development, DevOps, a programming language or a module inside an experience/conceptual question does not make it a coding task.\n- For genuine coding problems, always start with Logic (1-2 lines), then provide complete runnable code in the language visible in the screenshot unless another language is requested. Never return explanation alone.\n- Preserve method/class signatures shown in the screenshot when they are part of the problem contract.\n- Cover edge cases and complexity briefly when relevant.\n- Add concise inline comments to meaningful code statements so the solution can be explained in an interview.\n- For flowchart, architecture-flow or diagram requests, provide a detailed drawable Unicode box flow using ┌ ─ ┐ │ └ ┘, arrows, branches and data direction; never return prose alone.\n- If the screenshot contains an error, diagnose the actual failing line/behavior and provide the corrected code.\n- Keep the answer practical, concise, and directly usable.`);
  return [{ role:'user', content:[
    { type:'input_text', text:instruction },
    { type:'input_image', image_url:imageDataUrl, detail:'high' }
  ] }];
}

app.post('/extract-screen-text', async (req, res) => {
  const startedAt = Date.now();
  const email = String(req.body.email || '').trim().toLowerCase();
  const imageDataUrl = String(req.body.imageDataUrl || '').trim();
  if (!email || !/^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(imageDataUrl)) return res.status(400).json({ok:false,error:'email and screen image are required'});
  const license = isLicenseValid(email); if (!license.ok) return res.status(401).json({ok:false,error:license.reason || 'Invalid license'});
  if (!OPENAI_API_KEY) return res.status(500).json({ok:false,error:'OPENAI_API_KEY missing on backend'});
  const session = interviewSessions.get(email);
  const recent = (session?.turns || []).slice(-3).map(t => `Q: ${t.question}\nA: ${t.answer}`).join('\n');
  const extractionRules = `Extract the useful visible content from this screenshot so it can be used as the next interview prompt. The FIRST line must be exactly one of TASK_TYPE: CODING, TASK_TYPE: DIAGRAM, or TASK_TYPE: OTHER. After that first line return only the extracted/normalized prompt text, no analysis and no markdown fences.\n- First identify the last complete question intent; earlier conversational lead-ins do not control TASK_TYPE.\n- Use CODING only for an actual request to write, implement, complete, debug, analyze or run code, or solve an algorithm/data-structure programming task.\n- A question about experience, projects, Agile, DevOps, integrations or concepts is OTHER even when its transcript mentions code, coding, development, a programming language, class or module.\n- Use DIAGRAM for flowchart, architecture-flow, sequence, component, block or draw.io-style requests.\n- Preserve code exactly enough to solve it, including identifiers, method/class signatures, error text and visible line numbers when present.\n- Preserve explicit constraints and requested output.\n- Ignore Topper UI text, browser chrome, taskbar, notifications and unrelated navigation.\n- If this is a continuation of earlier captured content, keep only what is visible now; the desktop app will append multiple captures.\n- Do not answer the content. Extract it only.\nRecent interview context for disambiguation only:\n${recent}`;
  try {
    const r = await fetch('https://api.openai.com/v1/responses', {method:'POST', headers:{'authorization':`Bearer ${OPENAI_API_KEY}`,'content-type':'application/json'}, body:JSON.stringify({model:LLM_VISION_EXTRACT_MODEL, service_tier:OPENAI_SERVICE_TIER, instructions:extractionRules, input:[{role:'user',content:[{type:'input_text',text:'Extract the screen content.'},{type:'input_image',image_url:imageDataUrl,detail:'high'}]}], reasoning:{effort:'none'}, text:{verbosity:'low'}, max_output_tokens:1600})});
    const data = await r.json().catch(()=>({}));
    if (!r.ok) return res.status(r.status).json({ok:false,error:data?.error?.message || `Vision extraction failed (${r.status})`});
    const raw=outputText(data).trim();
    const typeMatch=raw.match(/^TASK_TYPE:\s*(CODING|DIAGRAM|OTHER)\s*\n?/i);
    const taskType=String(typeMatch?.[1]||'OTHER').toLowerCase();
    const text=raw.replace(/^TASK_TYPE:\s*(?:CODING|DIAGRAM|OTHER)\s*\n?/i,'').trim();
    return res.json({ok:true,text,taskType,captureMs:Date.now()-startedAt});
  } catch (err) { return res.status(502).json({ok:false,error:err.message || 'Vision extraction failed'}); }
});

app.post('/ask/stream', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const text = normalizeStructuredText(req.body.text || '');
  const inputSource=normalizeText(req.body.inputSource||'').slice(0,40);
  const imageDataUrl = String(req.body.imageDataUrl || '').trim();
  const captureSource = normalizeText(req.body.captureSource || '').slice(0,300);
  const hasImage = /^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(imageDataUrl);
  if (!email || (!text && !hasImage)) return res.status(400).json({ ok:false, error:'email and text or image are required' });
  const license = isLicenseValid(email); if (!license.ok) return res.status(401).json({ ok:false, error:license.reason || 'Invalid license' });
  if (!OPENAI_API_KEY) return res.status(500).json({ ok:false, error:'OPENAI_API_KEY missing on backend' });
  if (text.length > 12000) return res.status(400).json({ ok:false, error:'Transcript input too long' });

  let prepared;
  try {
    if (hasImage) {
      const startedAt = Date.now();
      const session = interviewSessions.get(email);
      const intentQuestion=reframeQuestionIntent(text)||text;
      prepared = {
        session,
        intentQuestion,
        responseType:classifyResponseType(intentQuestion,session?resolveFollowupIntent(session,intentQuestion):null,inputSource),
        prompt:buildVisionInput(text, imageDataUrl, session, captureSource),
        retrieved:[],
        latency:{ startedAt, embeddingMs:0, retrievalMs:0, retrievalMode:'vision-direct', promptReadyMs:Date.now()-startedAt }
      };
    } else {
      prepared = await prepareQuestion(email,text,{inputSource});
    }
  } catch (err) { return res.status(502).json({ ok:false, error:err.message || 'Retrieval failed' }); }

  const route = selectAnswerRoute(text, prepared, { hasImage });

  // Preserve the existing direct screenshot path; it now shares the same OpenAI provider.
  if (hasImage) {
    if (!OPENAI_API_KEY) return res.status(500).json({ok:false,error:'OPENAI_API_KEY missing on backend for vision'});
    try {
      const visionStart=Date.now();
      const data=await openAIJson('https://api.openai.com/v1/responses',{model:LLM_VISION_EXTRACT_MODEL,service_tier:OPENAI_SERVICE_TIER,instructions:`${COPILOT_INSTRUCTIONS}

${strictModeInstructions(prepared.responseType)}`,input:prepared.prompt,reasoning:{effort:'none'},text:{verbosity:prepared.responseType==='spoken'?LLM_VERBOSITY:'medium'},max_output_tokens:answerTokenBudget(text,true,prepared.responseType)});
      let visionAnswer=outputText(data);
      visionAnswer=(await ensureModeConformance({answer:visionAnswer,responseType:prepared.responseType,prompt:prepared.prompt,model:LLM_DEFAULT_MODEL,effort:LLM_REASONING_EFFORT})).answer;
      if(prepared.session&&visionAnswer)addTurn(prepared.session,`[Captured window${captureSource?`: ${captureSource}`:''}] ${prepared.intentQuestion||text}`,visionAnswer,prepared.retrieved,prepared.responseType);
      const latency={embeddingMs:0,retrievalMs:0,retrievalMode:'vision-direct',promptReadyMs:prepared.latency.promptReadyMs,firstTokenMs:Date.now()-prepared.latency.startedAt,llmMs:Date.now()-visionStart,totalMs:Date.now()-prepared.latency.startedAt,attempts:1};
      res.status(200);res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('Connection','keep-alive');res.flushHeaders?.();
      res.write(`event: meta\ndata: ${JSON.stringify({model:LLM_VISION_EXTRACT_MODEL,modelTier:'openai-vision',phase:'retrieval',contextPrepared:!!prepared.session,retrievalMode:'vision-direct'})}\n\n`);
      res.write(`event: delta\ndata: ${JSON.stringify({delta:visionAnswer})}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({answer:visionAnswer,model:LLM_VISION_EXTRACT_MODEL,modelTier:'openai-vision',serviceTier:String(data?.service_tier||OPENAI_SERVICE_TIER),latency})}\n\n`);
      return res.end();
    } catch(err) { return res.status(502).json({ok:false,error:err.message||'Vision LLM request failed'}); }
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  let clientClosed = false;
  let activeUpstreamController = null;
  res.on('close', () => { clientClosed = true; try { activeUpstreamController?.abort('client-disconnected'); } catch (_) {} });
  const emit = (event, data) => { if (!clientClosed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  emit('meta', { model:route.model, modelTier:route.tier, serviceTierRequested:route.provider==='cerebras'?CEREBRAS_SERVICE_TIER:OPENAI_SERVICE_TIER, routeReason:route.reason, routeScore:route.score, routeConfidence:route.confidence, phase:'retrieval', contextPrepared:!!prepared.session, embeddingMs:prepared.latency.embeddingMs, retrievalMs:prepared.latency.retrievalMs, promptReadyMs:prepared.latency.promptReadyMs, retrievalMode:prepared.latency.retrievalMode });

  if (prepared.rejection) {
    const latency = { ...prepared.latency, firstTokenMs:Date.now()-prepared.latency.startedAt, llmMs:0, totalMs:Date.now()-prepared.latency.startedAt, attempts:0 };
    emit('delta', { delta:prepared.rejection });
    emit('meta', { model:'local-guard', modelTier:'local', phase:'complete', latency, retrieved:[] });
    emit('done', { answer:prepared.rejection, model:'local-guard', modelTier:'local', latency });
    return res.end();
  }

  const llmStart = Date.now();
  let firstTokenMs = null;
  let answer = '';
  let streamAttempt = 0;
  let providerServiceTier = '';
  try {
    // Retry once when the provider accepts a request but stalls before producing any text.
    // Normal fast responses are untouched; this only caps the rare 30-60s first-token stalls.
    while (streamAttempt < 2 && firstTokenMs === null) {
      streamAttempt++;
      const upstreamController = new AbortController();
      activeUpstreamController = upstreamController;
      const firstTokenTimeoutMs = hasImage ? Math.max(9000, LLM_FIRST_TOKEN_TIMEOUT_MS) : LLM_FIRST_TOKEN_TIMEOUT_MS;
      const firstTokenTimer = setTimeout(() => upstreamController.abort('first-token-timeout'), firstTokenTimeoutMs);
      let upstream;
      try {
        const isCerebras=route.provider==='cerebras';
        const streamBody=isCerebras
          ? {model:route.model,service_tier:CEREBRAS_SERVICE_TIER,messages:cerebrasMessages(`${COPILOT_INSTRUCTIONS}

${strictModeInstructions(prepared.responseType)}`,prepared.prompt),reasoning_effort:'low',reasoning_format:'hidden',max_completion_tokens:answerTokenBudget(text,false,prepared.responseType),stream:true}
          : openAIResponseBody({model:route.model,instructions:`${COPILOT_INSTRUCTIONS}

${strictModeInstructions(prepared.responseType)}`,input:prepared.prompt,effort:route.effort,maxTokens:answerTokenBudget(text,false,prepared.responseType),verbosity:prepared.responseType==='spoken'?LLM_VERBOSITY:'medium',stream:true});
        upstream = await fetch(isCerebras?`${CEREBRAS_API_BASE}/chat/completions`:'https://api.openai.com/v1/responses', {
          method:'POST', signal:upstreamController.signal,
          headers:{'content-type':'application/json', authorization:`Bearer ${isCerebras?CEREBRAS_API_KEY:OPENAI_API_KEY}`},
          body:JSON.stringify(streamBody)
        });
        if (!upstream.ok) {
          clearTimeout(firstTokenTimer);
          const data = await upstream.json().catch(() => ({}));
          throw new Error(data?.error?.message || `${route.provider==='cerebras'?'Cerebras':'OpenAI'} request failed (${upstream.status})`);
        }
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, {stream:true});
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() || '';
          for (const block of blocks) {
            const dataLines = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
            if (!dataLines.length) continue;
            const raw = dataLines.join('\n');
            if (!raw || raw === '[DONE]') continue;
            let evt; try { evt = JSON.parse(raw); } catch (_) { continue; }
            const eventType=String(evt?.type||'');
            const delta=route.provider==='cerebras' ? String(evt?.choices?.[0]?.delta?.content||'') : (eventType==='response.output_text.delta' ? String(evt?.delta||'') : '');
            if (delta) {
              if (firstTokenMs === null) {
                firstTokenMs = Date.now() - prepared.latency.startedAt;
                clearTimeout(firstTokenTimer);
              }
              answer += delta;
              emit('delta', { delta });
            }
            if (eventType==='error' || evt?.error) throw new Error(evt?.error?.message || evt?.message || `${route.provider==='cerebras'?'Cerebras':'OpenAI'} stream error`);
            if (route.provider==='cerebras' && (evt?.service_tier_used||evt?.service_tier)) providerServiceTier=String(evt.service_tier_used||evt.service_tier);
            if (eventType==='response.completed' && evt?.response?.service_tier) providerServiceTier=String(evt.response.service_tier);
            if (eventType==='response.failed') throw new Error(evt?.response?.error?.message || 'OpenAI response failed');
          }
        }
        clearTimeout(firstTokenTimer);
        break;
      } catch (attemptErr) {
        clearTimeout(firstTokenTimer);
        const timedOut = upstreamController.signal.aborted && firstTokenMs === null;
        if (route.provider==='cerebras' && firstTokenMs===null) {
          console.warn(`[LLM router] Cerebras unavailable/stalled; falling back to Sol: ${attemptErr.message}`);
          route.provider='openai'; route.model=LLM_DEFAULT_MODEL; route.effort=LLM_REASONING_EFFORT; route.tier='openai-sol-fast-fallback'; route.reason+=':cerebras-fallback';
          streamAttempt=0;
          emit('meta',{model:route.model,modelTier:route.tier,phase:'fallback',reason:'cerebras unavailable; using Sol'});
          continue;
        }
        if (timedOut && streamAttempt < 2) {
          console.warn(`[LLM stream] first-token timeout after ${firstTokenTimeoutMs}ms; retrying once`);
          emit('meta', { model:route.model, modelTier:route.tier, phase:'retry', reason:'provider first-token timeout' });
          continue;
        }
        throw attemptErr;
      }
    }
    answer=normalizeStructuredText(answer);
    if((prepared.responseType==='code'&&!hasCompleteCode(answer))||(prepared.responseType==='diagram'&&!hasDrawableDiagram(answer)))emit('meta',{model:route.model,modelTier:route.tier,phase:'format-retry'});
    const conformance=await ensureModeConformance({answer,responseType:prepared.responseType,prompt:prepared.prompt,model:LLM_DEFAULT_MODEL,effort:LLM_REASONING_EFFORT});
    answer=conformance.answer;
    if(conformance.repaired)emit('replace',{text:answer});
    if (!clientClosed && prepared.session && answer) addTurn(prepared.session,hasImage?`[Captured window${captureSource?`: ${captureSource}`:''}] ${prepared.intentQuestion||text}`:prepared.intentQuestion||text,answer,prepared.retrieved,prepared.responseType);
    const latency = { embeddingMs:prepared.latency.embeddingMs, retrievalMs:prepared.latency.retrievalMs, retrievalMode:prepared.latency.retrievalMode, promptReadyMs:prepared.latency.promptReadyMs, firstTokenMs, llmMs:Date.now()-llmStart, totalMs:Date.now()-prepared.latency.startedAt, attempts:streamAttempt };
    providerServiceTier=providerServiceTier||(route.provider==='cerebras'?CEREBRAS_SERVICE_TIER:OPENAI_SERVICE_TIER);
    console.log(`[LLM stream] ${email} model=${route.model} modelTier=${route.tier} serviceTier=${providerServiceTier} first=${firstTokenMs ?? '-'}ms total=${latency.totalMs}ms embed=${latency.embeddingMs}ms retrieve=${latency.retrievalMs}ms mode=${prepared.latency.retrievalMode} attempts=${streamAttempt}`);
    emit('meta', { model:route.model, modelTier:route.tier, serviceTier:providerServiceTier, phase:'complete', latency, retrieved:prepared.retrieved.map(c => ({source:c.source, section:c.section, score:Number(c.score.toFixed(3))})) });
    emit('done', { answer, model:route.model, modelTier:route.tier, serviceTier:providerServiceTier, latency });
  } catch (err) {
    console.error('[LLM stream] Error:', err.message);
    emit('error', { error:err.message || 'LLM stream failed' });
  } finally {
    res.end();
  }
});
const server = http.createServer(app);

const wss = new WebSocket.Server({
  server,
  path: '/stt',
});

function buildDeepgramUrl() {
  const params = new URLSearchParams({
    model: String(process.env.DG_MODEL || 'nova-3'),
    language: String(process.env.DG_LANGUAGE || 'en-US'),
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
    // Low latency finalization. Keep utterance_end_ms >= 1000; Deepgram can reject lower values.
    endpointing: '300',
    utterance_end_ms: '1000',
    vad_events: 'true',
  });

  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
}

wss.on('connection', (clientWs, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const email = String(url.searchParams.get('email') || 'unknown').trim().toLowerCase();

  console.log(`[STT] Client connected: ${email}`);

  const licenseResult = isLicenseValid(email);
  if (!licenseResult.ok) {
    clientWs.send(JSON.stringify({
      type: 'error',
      message: licenseResult.reason || 'Invalid license',
    }));
    clientWs.close(1008, 'invalid license');
    return;
  }

  if (!DEEPGRAM_API_KEY) {
    clientWs.send(JSON.stringify({
      type: 'error',
      message: 'DEEPGRAM_API_KEY missing on backend',
    }));
    clientWs.close();
    return;
  }

  let dgWs = null;
  let dgOpen = false;
  let dgConnecting = false;
  let keepAliveTimer = null;
  let pendingAudio = [];
  const MAX_PENDING_AUDIO = 50;
  let sessionLimitTimer = null;
  let clientPingTimer = null;
  let dgConnectedAt = 0;
  let lastDeepgramAudioAt = 0;
  let limitReached = false;

  function sendClient(payload) {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(payload));
    }
  }

  function clearSessionTimers() {
    if (sessionLimitTimer) {
      clearTimeout(sessionLimitTimer);
      sessionLimitTimer = null;
    }
    if (clientPingTimer) {
      clearInterval(clientPingTimer);
      clientPingTimer = null;
    }
  }

  function closeForTranscriptLimit() {
    if (limitReached) return;
    limitReached = true;
    const message = 'Transcript limit reached: 2 hours 15 minutes. Captions are disconnecting now.';
    console.log('[STT] ' + message);
    sendClient({ type: 'limit_reached', message });
    cleanupDeepgram();
    try { clientWs.close(1000, 'transcript limit reached'); } catch (_) {}
  }

  sessionLimitTimer = setTimeout(closeForTranscriptLimit, MAX_TRANSCRIPTION_SESSION_MS);
  clientPingTimer = setInterval(() => {
    if (clientWs.readyState === WebSocket.OPEN) {
      try { clientWs.ping(); } catch (_) {}
    }
  }, BACKEND_CLIENT_PING_MS);

  function resetDeepgramState() {
    dgOpen = false;
    dgConnecting = false;

    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }

    dgWs = null;
  }

  function cleanupDeepgram() {
    dgOpen = false;
    dgConnecting = false;

    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }

    if (dgWs) {
      try {
        if (dgWs.readyState === WebSocket.OPEN) {
          dgWs.send(JSON.stringify({ type: 'CloseStream' }));
        }
        dgWs.close();
      } catch (_) {}
      dgWs = null;
    }
  }

  function connectDeepgram() {
    if (dgWs && (dgWs.readyState === WebSocket.OPEN || dgWs.readyState === WebSocket.CONNECTING)) return;

    dgOpen = false;
    dgConnecting = true;

    const deepgramUrl = buildDeepgramUrl();
    console.log('[Deepgram] Connecting with params:', deepgramUrl.replace('wss://api.deepgram.com/v1/listen?', ''));

    dgWs = new WebSocket(deepgramUrl, {
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
      },
    });

    dgWs.on('open', () => {
      dgOpen = true;
      dgConnecting = false;
      console.log('[Deepgram] WebSocket connected after first Meet audio');
      dgConnectedAt = Date.now();
      lastDeepgramAudioAt = Date.now();
      sendClient({ type: 'status', text: 'Deepgram connected. Captions active.' });

      for (const chunk of pendingAudio.splice(0)) {
        if (dgWs.readyState === WebSocket.OPEN) dgWs.send(chunk);
      }

      // Prevent Deepgram/Railway idle close during long silence. KeepAlive runs continuously;
      // a tiny silent PCM frame is sent only during the first 30 minutes without speech/audio.
      keepAliveTimer = setInterval(() => {
        if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          try { dgWs.send(JSON.stringify({ type: 'KeepAlive' })); } catch (_) {}

          const now = Date.now();
          const withinNoSpeechWindow = dgConnectedAt && (now - dgConnectedAt <= NO_SPEECH_KEEPALIVE_LIMIT_MS);
          const noAudioRecently = now - lastDeepgramAudioAt >= SILENCE_PCM_KEEPALIVE_AFTER_MS;
          if (withinNoSpeechWindow && noAudioRecently) {
            try {
              dgWs.send(SILENCE_PCM_100MS_16K_MONO);
              lastDeepgramAudioAt = now;
            } catch (_) {}
          }
        }
      }, DEEPGRAM_KEEPALIVE_MS);
    });

    dgWs.on('unexpected-response', (request, response) => {
      let body = '';

      response.on('data', chunk => {
        body += chunk.toString();
      });

      response.on('end', () => {
        console.error('[Deepgram] Unexpected response');
        console.error('[Deepgram] Status:', response.statusCode);
        console.error('[Deepgram] Headers:', response.headers);
        console.error('[Deepgram] Body:', body);

        sendClient({
          type: 'error',
          message: body || `Deepgram connection failed with status ${response.statusCode}`,
          status: response.statusCode,
          body,
          dgError: response.headers['dg-error'],
          dgRequestId: response.headers['dg-request-id'],
        });

        resetDeepgramState();
      });
    });

    dgWs.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'SpeechStarted') {
          sendClient({ type: 'speech_started' });
          return;
        }

        const transcript = msg?.channel?.alternatives?.[0]?.transcript || '';
        if (!transcript) return;

        sendClient({
          type: 'transcript',
          text: transcript,
          isFinal: Boolean(msg.is_final),
          speechFinal: Boolean(msg.speech_final),
          confidence: Number(msg?.channel?.alternatives?.[0]?.confidence || 0),
        });
      } catch (err) {
        console.error('[Deepgram] Parse error:', err.message);
      }
    });

    dgWs.on('close', (code, reason) => {
      dgOpen = false;
      dgConnecting = false;
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }

      dgWs = null;

      const reasonText = reason.toString();
      console.log('[Deepgram] Closed:', code, reasonText);

      // Do not close the app/client on Deepgram idle/network close. The next real
      // audio chunk will reconnect and continue captions.
      if (clientWs.readyState === WebSocket.OPEN && code !== 1000) {
        sendClient({ type: 'status', text: 'Deepgram paused. Waiting for audio to reconnect captions...' });
      }
    });

    dgWs.on('error', err => {
      dgOpen = false;
      dgConnecting = false;
      dgWs = null;
      console.error('[Deepgram] Error:', err.message);
      sendClient({ type: 'error', message: err.message });
    });
  }

  clientWs.on('message', audioChunk => {
    if (limitReached) return;
    if (!audioChunk || audioChunk.length === 0) return;
    lastDeepgramAudioAt = Date.now();

    if (!dgWs || dgWs.readyState === WebSocket.CLOSED || dgWs.readyState === WebSocket.CLOSING) {
      pendingAudio.push(Buffer.from(audioChunk));
      if (pendingAudio.length > MAX_PENDING_AUDIO) pendingAudio.shift();
      connectDeepgram();
      return;
    }

    if (dgOpen && dgWs.readyState === WebSocket.OPEN) {
      lastDeepgramAudioAt = Date.now();
      dgWs.send(audioChunk);
      return;
    }

    if (dgConnecting || dgWs.readyState === WebSocket.CONNECTING) {
      pendingAudio.push(Buffer.from(audioChunk));
      if (pendingAudio.length > MAX_PENDING_AUDIO) pendingAudio.shift();
    }
  });

  clientWs.on('close', () => {
    console.log(`[STT] Client disconnected: ${email}`);
    clearSessionTimers();
    cleanupDeepgram();
    pendingAudio = [];
  });

  clientWs.on('error', err => {
    console.error('[STT] Client error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`[BOOT] Topper backend running on port ${PORT}`);
});
