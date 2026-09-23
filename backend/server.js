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
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || 'gemini-3.6-flash').trim();
const GEMINI_API_BASE = String(process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').trim().replace(/\/+$/, '');
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
const OPENAI_4O_MODEL = String(process.env.OPENAI_4O_MODEL || 'gpt-4o').trim();
const OPENAI_4O_MINI_MODEL = String(process.env.OPENAI_4O_MINI_MODEL || 'gpt-4o-mini').trim();
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
const RAG_QUERY_MODE = ['local','hybrid'].includes(String(process.env.RAG_QUERY_MODE || 'local').trim().toLowerCase())
  ? String(process.env.RAG_QUERY_MODE || 'local').trim().toLowerCase()
  : 'local';
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
console.log('[BOOT] GEMINI_API_KEY present:', !!GEMINI_API_KEY, '| model:', GEMINI_MODEL);
console.log('[BOOT] LLM provider: OpenAI ->', LLM_DEFAULT_MODEL, '| profile:', LLM_PROFILE_MODEL, '| vision:', LLM_VISION_EXTRACT_MODEL, '| embedding:', EMBEDDING_MODEL, '| dims:', EMBEDDING_DIMENSIONS);
console.log('[BOOT] OpenAI service tier:', OPENAI_SERVICE_TIER, '| reasoning effort:', LLM_REASONING_EFFORT);
console.log('[BOOT] Live RAG query mode:', RAG_QUERY_MODE, RAG_QUERY_MODE==='local' ? '(one selected-LLM network call per interview question)' : '(semantic query embedding fallback enabled)');

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
function isLegacy4oFamily(model) {
  return /^gpt-4o(?:-mini)?(?:-|$)/i.test(String(model||'').trim());
}
function openAIResponseBody({model=LLM_DEFAULT_MODEL,instructions='',input='',effort=LLM_REASONING_EFFORT,maxTokens=420,verbosity=LLM_VERBOSITY,stream=false}) {
  const body={
    model,
    service_tier:OPENAI_SERVICE_TIER,
    instructions:String(instructions||''),
    input,
    max_output_tokens:maxTokens,
    stream:!!stream
  };
  // Preserve the v14.7.2 OpenAI request architecture. GPT-4o / GPT-4o mini do not
  // receive GPT-5.6-only reasoning/verbosity controls, but use the same Topper prompt.
  if(!isLegacy4oFamily(model)) {
    body.reasoning={effort:normalizedReasoningEffort(effort)};
    body.text={verbosity:String(verbosity||'medium')};
  }
  return body;
}
async function openAIResponseJson({model=LLM_DEFAULT_MODEL,instructions='',input='',effort=LLM_REASONING_EFFORT,maxTokens=420,verbosity=LLM_VERBOSITY}) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing on backend');
  return openAIJson('https://api.openai.com/v1/responses', openAIResponseBody({model,instructions,input,effort,maxTokens,verbosity,stream:false}));
}
function cerebrasOutputText(data) {
  return String(data?.choices?.[0]?.message?.content || '').trim();
}
function cerebrasReasoningEffort(effort=CEREBRAS_REASONING_EFFORT) {
  const value=String(effort||CEREBRAS_REASONING_EFFORT).trim().toLowerCase();
  return ['low','medium','high'].includes(value) ? value : CEREBRAS_REASONING_EFFORT;
}
function cerebrasChatBody({instructions='',input='',maxTokens=420,stream=false,effort=CEREBRAS_REASONING_EFFORT}) {
  // Cerebras exposes OpenAI GPT-OSS 120B through its OpenAI-compatible Chat Completions API.
  // Keep this adapter isolated so Sol/Terra, SQL/RAG, STT and the renderer contracts stay untouched.
  const body={
    model:CEREBRAS_MODEL,
    messages:[
      {role:'developer',content:String(instructions||'')},
      {role:'user',content:typeof input==='string'?input:JSON.stringify(input)}
    ],
    max_completion_tokens:maxTokens,
    reasoning_effort:cerebrasReasoningEffort(effort),
    stream:!!stream
  };
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
function geminiInteractionBody({instructions='',input='',maxTokens=420,stream=false}) {
  return {
    model:GEMINI_MODEL,
    system_instruction:String(instructions||''),
    input:typeof input==='string'?input:JSON.stringify(input),
    generation_config:{max_output_tokens:maxTokens,thinking_level:'low'},
    stream:!!stream,
    store:false
  };
}
function geminiOutputText(data) {
  return String((data?.steps||[])
    .filter(step=>step?.type==='model_output')
    .flatMap(step=>step?.content||[])
    .filter(content=>content?.type==='text')
    .map(content=>content?.text||'')
    .join('')).trim();
}
async function geminiJson({instructions='',input='',maxTokens=420}) {
  if(!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY missing on backend');
  let lastError;
  for(let attempt=0;attempt<2;attempt++){
    const response=await fetch(`${GEMINI_API_BASE}/interactions`,{
      method:'POST',headers:{'content-type':'application/json','x-goog-api-key':GEMINI_API_KEY},
      body:JSON.stringify(geminiInteractionBody({instructions,input,maxTokens,stream:false}))
    });
    const data=await response.json().catch(()=>({}));
    if(response.ok)return data;
    lastError=new Error(data?.error?.message||`Gemini request failed (${response.status})`);
    if(![429,503].includes(response.status)||attempt>0)throw lastError;
    await new Promise(resolve=>setTimeout(resolve,750));
  }
  throw lastError;
}
async function providerResponseJson({provider='openai',model=LLM_DEFAULT_MODEL,instructions='',input='',effort=LLM_REASONING_EFFORT,maxTokens=420,verbosity=LLM_VERBOSITY}) {
  if(provider==='cerebras') return cerebrasJson({instructions,input,maxTokens,effort});
  if(provider==='gemini') return geminiJson({instructions,input,maxTokens});
  return openAIResponseJson({model,instructions,input,effort,maxTokens,verbosity});
}
function providerOutputText(provider,data){
  if(provider==='cerebras') return cerebrasOutputText(data);
  if(provider==='gemini') return geminiOutputText(data);
  return outputText(data);
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
  return selectBalancedEvidence(ranked, query, TOP_K);
}

// Live interview retrieval is intentionally local-first. The resume/JD is prepared once,
// then every question is ranked in-process so the selected answer provider is normally the
// only network call on the critical path. This avoids paying an embeddings round-trip before
// the LLM can even start thinking.
const TECH_QUERY_ALIASES = [
  ['Spring Boot', ['springboot','spring boot','spring boat','spring bot','your boot']],
  ['Spring', ['spring framework']],
  ['JavaScript', ['java script','javascript','js']],
  ['TypeScript', ['type script','typescript','ts']],
  ['React', ['react js','reactjs']],
  ['Next.js', ['next js','nextjs']],
  ['Node.js', ['node js','nodejs']],
  ['PostgreSQL', ['postgres','postgre sql','post grass','postgresql']],
  ['MySQL', ['my sql','mysql']],
  ['PySpark', ['pie spark','py spark','pyspark']],
  ['Databricks', ['data bricks','databricks']],
  ['LangGraph', ['lang graph','langgraph']],
  ['LangChain', ['lang chain','langchain']],
  ['Kubernetes', ['kubernetes','kuber netes','k8s']],
  ['Terraform', ['terra form','terraform']],
  ['Kafka', ['kafka','kaf ka']],
  ['Redis', ['redis','red is']],
  ['Golang', ['go lang','golang']],
  ['GitLab', ['git lab','gitlab']],
  ['GitHub', ['git hub','github']],
  ['AWS', ['amazon web services','aws']],
  ['Azure', ['microsoft azure','azure']],
  ['GCP', ['google cloud platform','google cloud','gcp']],
  ['REST', ['rest api','restful']],
  ['GraphQL', ['graph ql','graphql']],
  ['CI/CD', ['ci cd','cicd','ci/cd']],
  ['OpenTelemetry', ['open telemetry','opentelemetry']],
  ['Prometheus', ['prometheus']],
  ['Grafana', ['grafana']],
  ['Splunk', ['splunk']],
  ['Docker', ['docker']],
  ['Jenkins', ['jenkins']],
  ['Selenium', ['selenium']],
  ['Playwright', ['playwright']],
  ['Cypress', ['cypress']],
  ['JUnit', ['j unit','junit']],
  ['Mockito', ['mockito']],
  ['Maven', ['maven']],
  ['Gradle', ['gradle']],
  ['Hibernate', ['hibernate']],
  ['JPA', ['java persistence api','jpa']],
  ['REST API', ['rest api']],
  ['Microservices', ['micro services','microservice','microservices']],
  ['Structured Streaming', ['structured streaming','spark streaming']],
  ['Delta Lake', ['delta lake']],
  ['RDS', ['amazon rds','rds']],
  ['ECS', ['amazon ecs','ecs']],
  ['Fargate', ['aws fargate','fargate']],
  ['CloudWatch', ['cloud watch','cloudwatch']],
  ['Secrets Manager', ['secret manager','secrets manager']],
  ['S3', ['amazon s3','s3']],
  ['ECR', ['amazon ecr','ecr']]
];

function normalizeRetrievalToken(token) {
  let t=String(token||'').toLowerCase().replace(/^\.+|\.+$/g,'');
  if(!t)return '';
  // Light stemming only for ordinary English words. Do not mutate technology-shaped tokens.
  if(/^[a-z]{5,}$/.test(t)){
    if(t.endsWith('ies')&&t.length>5)t=t.slice(0,-3)+'y';
    else if(t.endsWith('ing')&&t.length>6)t=t.slice(0,-3);
    else if(t.endsWith('ed')&&t.length>5)t=t.slice(0,-2);
    else if(t.endsWith('es')&&t.length>5)t=t.slice(0,-2);
    else if(t.endsWith('s')&&t.length>4)t=t.slice(0,-1);
  }
  return t;
}
function retrievalTokens(text) {
  return (String(text||'').toLowerCase().match(/[a-z0-9+#.\/.-]{2,}/g)||[])
    .map(normalizeRetrievalToken).filter(t=>t&&!STOP_WORDS.has(t));
}
function buildLocalRetrievalIndex(chunks) {
  const docs=(chunks||[]).map((chunk,id)=>{
    const normalized=normalizeText(`${chunk.section||''} ${chunk.text||''}`).toLowerCase();
    const tokens=retrievalTokens(normalized);
    const tf=new Map();
    for(const token of tokens)tf.set(token,(tf.get(token)||0)+1);
    return {id, normalized, tokens, tf, length:Math.max(1,tokens.length)};
  });
  const df=new Map();
  for(const doc of docs)for(const token of new Set(doc.tokens))df.set(token,(df.get(token)||0)+1);
  const avgLen=docs.length?docs.reduce((sum,d)=>sum+d.length,0)/docs.length:1;
  return {docs,df,avgLen,count:docs.length};
}
function sessionCanonicalVocabulary(session) {
  return (session?.profile?.domainVocabulary||session?.profile?.primarySkills||[]).map(String).filter(Boolean);
}
function canonicalTermsInQuestion(session, query) {
  const q=normalizeText(query).toLowerCase();
  const vocab=sessionCanonicalVocabulary(session);
  const matches=[];
  for(const term of vocab){
    const t=normalizeText(term).toLowerCase();
    if(t.length>=2&&q.includes(t))matches.push(term);
  }
  for(const [canonical,aliases] of TECH_QUERY_ALIASES){
    const present=vocab.some(v=>normalizeText(v).toLowerCase()===canonical.toLowerCase()) ||
      (session?.chunks||[]).some(c=>normalizeText(c.text).toLowerCase().includes(canonical.toLowerCase()));
    if(!present)continue;
    if(aliases.some(alias=>q.includes(alias.toLowerCase())))matches.push(canonical);
  }
  return [...new Set(matches)];
}
function expandLocalRetrievalQuery(session, query) {
  let expanded=normalizeText(query);
  const q=expanded.toLowerCase();
  const vocab=sessionCanonicalVocabulary(session);
  for(const [canonical,aliases] of TECH_QUERY_ALIASES){
    const present=vocab.some(v=>normalizeText(v).toLowerCase()===canonical.toLowerCase()) ||
      (session?.chunks||[]).some(c=>normalizeText(c.text).toLowerCase().includes(canonical.toLowerCase()));
    if(!present)continue;
    if(aliases.some(alias=>q.includes(alias.toLowerCase()))&&!q.includes(canonical.toLowerCase()))expanded+=` ${canonical}`;
  }
  // Concept expansions are intentionally conservative and activated only when the related
  // technology exists in the candidate/JD context. They improve STT/synonym retrieval without
  // inventing experience claims.
  const has=(term)=>vocab.some(v=>normalizeText(v).toLowerCase().includes(term))||(session?.chunks||[]).some(c=>normalizeText(c.text).toLowerCase().includes(term));
  if(/global(?:ly)?\s+(?:handle|handling|maintain).{0,30}exception|exception.{0,30}global/i.test(q) && has('spring')) expanded+=' RestControllerAdvice ControllerAdvice ExceptionHandler MethodArgumentNotValidException';
  if(/reconciliation|virtual dom/i.test(q) && has('react')) expanded+=' React virtual DOM render key state props';
  if(/memo(?:ization)?|usememo|usecallback/i.test(q) && has('react')) expanded+=' React useMemo useCallback memo render';
  if(/cpu.{0,20}(?:90|spike|high)|high.{0,20}cpu/i.test(q) && (has('golang')||has('go'))) expanded+=' Go pprof goroutine runtime profiling';
  if(/incremental|new records|checkpoint|offset/i.test(q) && (has('kafka')||has('structured streaming'))) expanded+=' Kafka offsets checkpoint Structured Streaming micro-batch';
  return expanded;
}
function localRank(session, query) {
  if(!session?.chunks?.length)return [];
  const index=session.localRetrievalIndex||buildLocalRetrievalIndex(session.chunks);
  if(!session.localRetrievalIndex)session.localRetrievalIndex=index;
  const expanded=expandLocalRetrievalQuery(session,query);
  const qTokens=retrievalTokens(expanded);
  const unique=[...new Set(qTokens)];
  const qLower=normalizeText(expanded).toLowerCase();
  const canonical=canonicalTermsInQuestion(session,expanded).map(t=>normalizeText(t).toLowerCase());
  const experienceLike=/\b(?:you|your|project|experience|worked|implemented|used|built|developed|production|client)\b/i.test(query);
  const k1=1.25,b=0.72;
  return session.chunks.map((chunk,i)=>{
    const doc=index.docs[i]||{normalized:normalizeText(`${chunk.section||''} ${chunk.text||''}`).toLowerCase(),tf:new Map(),length:1};
    let bm25=0;
    for(const token of unique){
      const tf=doc.tf.get(token)||0;if(!tf)continue;
      const df=index.df.get(token)||0;
      const idf=Math.log(1+((index.count-df+0.5)/(df+0.5)));
      bm25+=idf*((tf*(k1+1))/(tf+k1*(1-b+b*(doc.length/index.avgLen))));
    }
    let phrase=0;
    const meaningful=unique.filter(t=>t.length>=3);
    for(let n=2;n<=3;n++)for(let j=0;j<=meaningful.length-n;j++){
      const p=meaningful.slice(j,j+n).join(' ');if(p.length>=7&&doc.normalized.includes(p))phrase+=n===3?0.9:0.45;
    }
    let tech=0;
    for(const term of canonical)if(term&&doc.normalized.includes(term))tech+=1.25;
    const section=normalizeText(chunk.section||'').toLowerCase();
    const headingHits=unique.filter(t=>section.includes(t)).length;
    const heading=Math.min(0.8,headingHits*0.22);
    const sourceBoost=experienceLike&&chunk.source==='resume'?0.35:(chunk.source==='resume'?0.08:0);
    const lexical=keywordScore(new Set(unique),`${chunk.section} ${chunk.text}`);
    const score=bm25+phrase+tech+heading+sourceBoost+(lexical*0.7);
    return {...chunk,score,vector:0,lexical,bm25,phrase,tech};
  }).sort((a,b)=>b.score-a.score);
}
function selectBalancedEvidence(ranked, query, limit=TOP_K) {
  const selected=[];
  const sectionCounts=new Map();
  for(const item of ranked){
    if(selected.length>=limit)break;
    const sectionKey=`${item.source}:${item.section}`;
    const count=sectionCounts.get(sectionKey)||0;
    if(count>=2)continue;
    if(item.score<=0 && selected.length>=2)continue;
    selected.push(item);sectionCounts.set(sectionKey,count+1);
  }
  for(const item of ranked){if(selected.length>=limit)break;if(!selected.includes(item))selected.push(item);}
  // Do not force an unrelated JD chunk into every answer. Include JD when it is competitive
  // with the selected evidence or the question explicitly asks about role/JD requirements.
  const hasJd=ranked.some(x=>x.source==='jd');
  if(hasJd&&!selected.some(x=>x.source==='jd')){
    const bestJd=ranked.find(x=>x.source==='jd');
    const best=ranked[0];
    const jdRelevant=/\b(?:jd|job description|requirement|role|position|responsibilit|must have|nice to have)\b/i.test(query) || (bestJd&&best&&bestJd.score>=Math.max(0.45,best.score*0.62));
    if(jdRelevant&&bestJd&&selected.length)selected[selected.length-1]=bestJd;
  }
  return selected;
}
function retrieveChunksLocal(session, query) {
  return selectBalancedEvidence(localRank(session,query),query,TOP_K);
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

  // Context-aware repair for a high-confidence multi-token STT failure that
  // token-level edit distance cannot recover: "ask and quarks" -> "*args and **kwargs".
  const technologyContext=normalizeText(`${(session?.profile?.primarySkills||[]).join(' ')} ${(session?.profile?.domainVocabulary||[]).join(' ')} ${(session?.turns||[]).slice(-3).map(t=>t.question).join(' ')}`).toLowerCase();
  if (/\bpython\b/.test(technologyContext) || /\b(?:ask|args?)\s+(?:and|&)\s+(?:quarks|kwargs?|k\s*wargs?)\b/i.test(working)) {
    working=working.replace(/\b(?:ask|arks?|args?)\s+(?:and|&)\s+(?:quarks|kwargs?|k\s*wargs?)\b/gi, match=>{
      replacements.push({from:match,to:'*args and **kwargs',distance:0,kind:'context-phrase'});
      return '*args and **kwargs';
    });
  }

  // Repair common multi-word technology STT errors only when the canonical technology
  // actually exists in this resume/JD context. This is safer than global replacements.
  if (profileVocab.length) {
    const lowerVocab=profileVocab.map(term=>normalizeText(term).toLowerCase());
    for(const [canonical,aliases] of TECH_QUERY_ALIASES){
      const canonicalLower=canonical.toLowerCase();
      if(!lowerVocab.some(term=>term===canonicalLower||term.includes(canonicalLower)||canonicalLower.includes(term)))continue;
      for(const alias of aliases){
        if(alias.toLowerCase()===canonicalLower)continue;
        const escaped=alias.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        const re=new RegExp(`\\b${escaped.replace(/ /g,'\\s+')}\\b`,'gi');
        working=working.replace(re,match=>{
          replacements.push({from:match,to:canonical,distance:0,kind:'context-tech-phrase'});
          return canonical;
        });
      }
    }
  }

  if (!profileVocab.length) return { corrected:working, replacements };
  const corrected = working.replace(/\b[A-Za-z][A-Za-z0-9+#.-]{1,}\b/g, token => {
    const cleanToken = token.toLowerCase().replace(/[^a-z0-9+#]/g, '');
    // Bias correction toward acronym/technology-looking STT tokens. Ordinary prose is left untouched.
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
  // Prefer an explicit total when the candidate states it directly.
  const explicit=[...text.matchAll(/\b(\d{1,2}(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:overall\s+|total\s+|professional\s+|industry\s+)?experience\b/gi)]
    .map(match=>Number(match[1])).filter(value=>Number.isFinite(value)&&value>=0&&value<=60);
  if(explicit.length)return Math.max(...explicit);

  // Otherwise calculate the span from the earliest employment/project start to
  // the latest end/current date. Education date ranges are deliberately ignored.
  const monthNames='Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
  const dateToken=`(?:(?:${monthNames})[\\s,./-]*\\d{4}|(?:0?[1-9]|1[0-2])[/-]\\d{4}|(?:19|20)\\d{2})`;
  const endToken=`(?:${dateToken}|Present|Current|Till\\s+Date|To\\s+Date|Now)`;
  const rangeRe=new RegExp(`(${dateToken})\\s*(?:-|–|—|to|through|till|until)\\s*(${endToken})`,'gi');
  const monthMap={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  const current=new Date();
  const currentMonth=(current.getUTCFullYear()*12)+current.getUTCMonth();
  const parsePoint=(value,isEnd=false)=>{
    const raw=String(value||'').trim();
    if(/^(?:present|current|till\s+date|to\s+date|now)$/i.test(raw))return currentMonth;
    let m=raw.match(/^(0?[1-9]|1[0-2])[/-]((?:19|20)\d{2})$/);
    if(m)return (Number(m[2])*12)+(Number(m[1])-1);
    m=raw.match(new RegExp(`^(${monthNames})[\\s,./-]*((?:19|20)\\d{2})$`,'i'));
    if(m)return (Number(m[2])*12)+(monthMap[m[1].slice(0,3).toLowerCase()]??(isEnd?11:0));
    m=raw.match(/^((?:19|20)\d{2})$/);
    if(m)return (Number(m[1])*12)+(isEnd?11:0);
    return null;
  };

  let earliest=null,latest=null;
  for(const match of text.matchAll(rangeRe)){
    // Classify the date range using its own line plus the immediately preceding line.
    // This avoids counting education/certification ranges while still accepting the
    // first work range that appears directly after an Education section.
    const idx=match.index||0;
    const lineStart=text.lastIndexOf('\n',Math.max(0,idx-1))+1;
    const lineEnd=text.indexOf('\n',idx);
    const currentLine=text.slice(lineStart,lineEnd<0?text.length:lineEnd);
    const prevEnd=Math.max(0,lineStart-1);
    const prevStart=text.lastIndexOf('\n',Math.max(0,prevEnd-1))+1;
    const previousLine=text.slice(prevStart,prevEnd);
    const localContext=`${previousLine} ${currentLine}`;
    const workHint=/\b(?:experience|employment|work|professional|project|client|company|engineer|developer|architect|consultant|analyst|tester|sdet|lead|manager|specialist|administrator|intern|associate|role|position)\b/i.test(localContext);
    const nonWorkHint=/\b(?:education|university|college|school|bachelor|master(?:'s)?|degree|gpa|academic|certification|certificate|course|training)\b/i.test(localContext);
    if(nonWorkHint&&!workHint)continue;
    const startMonth=parsePoint(match[1],false),endMonth=parsePoint(match[2],true);
    if(!Number.isFinite(startMonth)||!Number.isFinite(endMonth)||endMonth<startMonth)continue;
    const duration=endMonth-startMonth+1;
    if(duration>60*12)continue;
    earliest=earliest===null?startMonth:Math.min(earliest,startMonth);
    latest=latest===null?endMonth:Math.max(latest,endMonth);
  }
  if(earliest!==null&&latest!==null&&latest>=earliest){
    const years=(latest-earliest+1)/12;
    if(years>=0&&years<=60){
      const rounded=Math.round(years*10)/10;
      return Math.abs(rounded-Math.round(rounded))<0.05?Math.round(rounded):rounded;
    }
  }
  return null;
}
function normalizeRoleTitle(value) {
  return String(value||'')
    .replace(/[|•·].*$/,'')
    .replace(/\s{2,}/g,' ')
    .replace(/^[-–—:,;\s]+|[-–—:,;\s]+$/g,'')
    .trim()
    .slice(0,160);
}
function explicitRolePattern() {
  return /\b(?:(?:senior|sr\.?|lead|principal|staff|associate|junior|jr\.?|technical|solution|solutions|cloud)\s+)?(?:qa\s+automation|quality\s+assurance|test\s+automation|software|java|python|\.net|dotnet|data|analytics|business\s+intelligence|bi|power\s*bi|cloud|devops|sre|site\s+reliability|automation|full[- ]?stack|backend|front[- ]?end|machine\s+learning|ml|ai|solutions?|technical|application|systems?)\s+(?:engineer|developer|architect|tester|analyst|consultant|lead|manager)\b|\b(?:sdet|software\s+engineer|software\s+developer|solution\s+architect|solutions\s+architect|data\s+engineer|data\s+scientist|devops\s+engineer|qa\s+engineer|automation\s+engineer|test\s+engineer|technical\s+lead|team\s+lead|business\s+analyst|data\s+analyst)\b/i;
}
function extractExplicitRoleFromDocument(documentText) {
  const text=normalizeText(documentText);
  if(!text)return '';
  const lines=text.split('\n').map(line=>line.trim()).filter(Boolean);
  const labelled=/\b(?:current\s+)?(?:role|job\s+title|title|designation|position)\s*[:\-–—]\s*(.+)$/i;
  for(const line of lines.slice(0,180)){
    const label=line.match(labelled);
    if(!label)continue;
    const direct=label[1].match(explicitRolePattern());
    if(direct)return normalizeRoleTitle(direct[0]);
    const fallback=normalizeRoleTitle(label[1]);
    if(fallback.length>=3&&fallback.length<=100)return fallback;
  }
  // Resumes commonly place the current title near the top or at the first job.
  const top=text.slice(0,9000);
  const direct=top.match(explicitRolePattern());
  return direct?normalizeRoleTitle(direct[0]):'';
}
function inferRoleFromSkills(resumeText,jdText) {
  const resume=normalizeText(resumeText).toLowerCase();
  const jd=normalizeText(jdText).toLowerCase();
  const combined=`${resume} ${resume} ${jd}`; // resume evidence receives slightly more weight.
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
  // A clear mix of frontend and backend technologies is better represented as full stack.
  const frontend=(combined.match(/\b(?:react|angular|vue)\b/g)||[]).length;
  const backend=(combined.match(/\b(?:spring boot|spring|node(?:\.js)?|express|django|fastapi|asp\.net)\b/g)||[]).length;
  if(frontend>=2&&backend>=2)return 'Full Stack Developer';
  return bestScore>=2?best:'';
}
function inferTargetRoleFromDocuments(resumeText,jdText) {
  // Required priority: an explicit CV title wins; then an explicit JD title;
  // only then infer from the combined technical profile.
  return extractExplicitRoleFromDocument(resumeText)
    || extractExplicitRoleFromDocument(jdText)
    || inferRoleFromSkills(resumeText,jdText);
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
  const explicitResumeRole=role?'':extractExplicitRoleFromDocument(resumeText);
  const explicitJdRole=(role||explicitResumeRole)?'':extractExplicitRoleFromDocument(jdText);
  const inferredSkillRole=inferRoleFromSkills(resumeText,jdText);
  const deterministicRole=role||explicitResumeRole||explicitJdRole||inferredSkillRole;
  try {
    const data = await openAIResponseJson({
      model:LLM_PROFILE_MODEL,
      instructions:'Create a compact interview-grounding profile. Return JSON only, no markdown. Never invent project facts. Respect the deterministic resume/JD role and experience extraction supplied in the prompt; use model inference only to fill genuinely unresolved profile fields.',
      input:`Years of experience supplied by user: ${suppliedYears===null?'not supplied':suppliedYears}
Deterministic resume timeline years: ${Number.isFinite(deterministicYears)?deterministicYears:'not resolved'}
Target role supplied by user: ${role || 'not supplied'}
Explicit role found in CV: ${explicitResumeRole || 'not found'}
Explicit role found in JD: ${explicitJdRole || 'not found'}
Skill-based role fallback: ${inferredSkillRole || 'not resolved'}

RESUME:
${resumeText.slice(0, 30000)}

JOB DESCRIPTION:
${jdText ? jdText.slice(0, 24000) : 'Not provided. Use resume-only grounding.'}

Return JSON with keys candidateSummary (max 1800 chars), jdSummary (max 1200 chars; empty string when no JD), primarySkills (array max 25), projectHighlights (array max 8), domainVocabulary (array max 60 of exact technology/product/framework/domain terms appearing in the resume or JD, preserving canonical spelling such as LangGraph, LangChain, Kubernetes), targetRole, yearsExperience. For yearsExperience, use a supplied value when present; otherwise prefer the deterministic resume timeline value above and only infer from resume dates if it was unresolved. For targetRole, priority is: supplied role, explicit CV title, explicit JD title, then a conservative role inferred from the technical profile. Do not replace an explicit CV title with a JD title.`,
      effort:'low', maxTokens:900, responseFormat:{type:'json_object'}
    });
    const raw = outputText(data);
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    const parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
    const rawParsedYears=parsed.yearsExperience;
    const parsedYears=(rawParsedYears===null||rawParsedYears===undefined||String(rawParsedYears).trim()==='')?NaN:Number(rawParsedYears);
    const resolvedYears=Number.isFinite(suppliedYears)?suppliedYears:(Number.isFinite(deterministicYears)?deterministicYears:(Number.isFinite(parsedYears)&&parsedYears>=0&&parsedYears<=60?parsedYears:fallback.yearsExperience));
    const parsedRole=normalizeRoleTitle(parsed.targetRole || '');
    const resolvedRole=normalizeRoleTitle(role||explicitResumeRole||explicitJdRole||parsedRole||inferredSkillRole||fallback.targetRole||'Software Engineer');
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
  // Explicit references/modifiers are continuations even when they contain a technology name.
  if (/\b(it|that|this|those|these|earlier|above|previous|prior|same|one example|another example|more detail|what about|how about|show code|give code|alternative code|alternate code|another code|other code|another solution|alternative solution|alternate solution|different solution|convert it|rewrite it|same in|do it in|instead|alternative|alternate|another one|dry run|time complexity|space complexity|edge cases?|optimi[sz]e|without|avoid|do not use|don't use|not using|using only|different way|different approach|another way|other approach)\b/.test(q)) return true;
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
function extractMultipleQuestionIntents(rawQuestion) {
  const raw=normalizeText(rawQuestion);
  if(!raw)return [];
  const normalized=raw.replace(/\s+/g,' ').trim();
  const starter=/^(?:have you|do you|did you|can you|could you|would you|will you|are you|were you|what|why|how|when|where|which|who|describe|explain|define|compare|tell me|walk me through|write|implement|find|solve|design|draw|create|show|debug|fix|calculate|return|print)\b/i;
  const candidates=normalized
    .split(/(?<=[?!])\s+|(?<=\.)\s+(?=(?:and\s+|also\s+|then\s+|next\s+|second(?:ly)?\s+)?(?:have you|do you|did you|can you|could you|would you|will you|are you|were you|what|why|how|when|where|which|who|describe|explain|define|compare|tell me|walk me through|write|implement|find|solve|design|draw|create|show|debug|fix|calculate|return|print)\b)/i)
    .map(part=>cleanIntentLead(part))
    .filter(Boolean);
  const requests=[];
  for(const candidate of candidates){
    const clean=candidate.replace(/^(?:and|also|then|next|second(?:ly)?|one more thing)[,.:;]?\s+/i,'').trim();
    if(starter.test(clean)||/[?]$/.test(clean))requests.push(clean);
  }
  if(requests.length<=1){
    const pieces=normalized.split(/\s+(?:and\s+then|and\s+also|and|also|then|next|second(?:ly)?|plus)\s+(?=(?:what|why|how|when|where|which|who|have you|do you|did you|can you|could you|would you|will you|are you|were you|describe|explain|define|compare|tell me|walk me through|write|implement|find|solve|design|draw|create|show|debug|fix)\b)/i)
      .map(part=>cleanIntentLead(part)).filter(Boolean);
    if(pieces.length>=2)return pieces.slice(0,3);
  }
  return requests.length>=2?requests.slice(0,3):[];
}
function questionTerms(value) {
  const stop=new Set(['what','which','why','how','when','where','who','is','are','was','were','do','does','did','can','could','would','should','will','you','your','we','our','i','a','an','the','and','or','to','of','in','on','for','with','this','that','it','these','those','have','has','had','tell','me','explain','describe','please','then','also']);
  return new Set((normalizeText(value).toLowerCase().match(/[a-z0-9+#.]+/g)||[]).filter(word=>word.length>2&&!stop.has(word)));
}
function multiQuestionsRelated(parts) {
  if(!Array.isArray(parts)||parts.length<2)return false;
  for(let i=1;i<parts.length;i++){
    if(/^\s*(?:and\s+)?(?:how|why|where|when|what)\b.*\b(?:it|that|this|same|those|these)\b/i.test(parts[i]))return true;
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

  const multi=extractMultipleQuestionIntents(raw);
  if(multi.length>=2){
    const relation=multiQuestionsRelated(multi)?'RELATED':'DISTINCT';
    return `MULTI_QUESTION: ${relation}\n${multi.map((item,index)=>`Question ${index+1}: ${item}`).join('\n')}`.slice(0,3000);
  }

  // For a single request, select the last complete interviewer request locally. Multi-question
  // prompts were already preserved above. This avoids a second LLM/classifier request.
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
function isCodeAlternativeFollowup(question) {
  const q=normalizeText(question).toLowerCase();
  if(!q)return false;
  return /\b(?:alternative|alternate|another|different|other)\b.{0,35}\b(?:code|solution|implementation|approach|program|method)\b/.test(q)
    || /\b(?:code|solution|implementation|program|method)\b.{0,35}\b(?:alternative|alternate|another|different|other)\b/.test(q)
    || /\b(?:same|previous|prior|earlier|above)\b.{0,25}\b(?:code|solution|implementation|program|method)\b/.test(q);
}
function findFollowupAnchorTurn(session, question) {
  const turns=Array.isArray(session?.turns)?session.turns:[];
  if(!turns.length)return null;
  if(isCodeAlternativeFollowup(question)||isCodeConstraintFollowup(question)||isCodingFollowupQuestion(question)){
    for(let i=turns.length-1;i>=0;i--){
      const turn=turns[i];
      if(turn?.responseType==='code'||isCodingQuestion(turn?.question||'')||hasCompleteCode(turn?.answer||''))return turn;
    }
  }
  return turns[turns.length-1]||null;
}
function resolveFollowupIntent(session, question) {
  if (!isContextualFollowup(question)) return { isFollowup:false, resolvedQuestion:question, previous:null };
  const previous = findFollowupAnchorTurn(session, question);
  if (!previous) return { isFollowup:false, resolvedQuestion:question, previous:null };
  const mostRecent=session?.turns?.[session.turns.length-1];
  const codeAnchor=isCodeAlternativeFollowup(question)&&previous!==mostRecent;
  return {
    isFollowup:true,
    previous,
    resolvedQuestion:`${codeAnchor?'Relevant earlier':'Previous'} interviewer request: ${previous.question}\nCurrent follow-up/modifier: ${question}`
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
  const snippetRequest=/\b(?:show|give|provide|write)?\s*(?:me\s+)?(?:a\s+)?(?:small\s+|simple\s+)?(?:code\s+)?(?:example|snippet)\b.{0,45}\b(?:java|python|c#|c\+\+|javascript|typescript|go|golang|kotlin|sql|shell|bash)\b|\b(?:java|python|c#|c\+\+|javascript|typescript|go|golang|kotlin|sql|shell|bash)\b.{0,45}\b(?:example|snippet)\b/i.test(q);
  const experienceQuestion=/\b(?:have you|do you have|did you|experience (?:with|in)|worked (?:with|on)|used (?:it|that|this|these|those)?\s*(?:in|on)?\s*(?:a|any|past|previous|production)|which project|tell me about your experience)\b/i.test(q);
  // Mentioning "code", "coding" or a "module" in an experience question is
  // not a request to manufacture a program.
  if(experienceQuestion&&!explicitRequest&&!snippetRequest)return false;
  if(explicitRequest||snippetRequest||/```|\b(?:leetcode|hackerrank)\b/i.test(q))return true;
  if(/\b(?:public|private|protected)\s+(?:static\s+)?(?:class|interface|void|int|string)|\bdef\s+\w+\s*\(|\bfunction\s+\w+\s*\(|\b(?:console\.log|system\.out\.println)\s*\(/i.test(q))return true;
  return /\b(?:find|return|print|calculate|check|remove|reverse|sort|search|merge|validate|count|implement|solve)\b.{0,65}\b(?:string|character|char|array|list|linked list|tree|graph|number|integer|duplicate|non[- ]?repeating|unique|palindrome|anagram|substring|subarray)\b/i.test(q)
    || /\bgiven\b.{0,55}\b(?:string|array|list|tree|graph|number|integer)\b.{0,100}\b(?:find|return|print|calculate|remove|reverse|sort|search|merge|count)\b/i.test(q)
    || /\b(?:first|last)\s+(?:non[- ]?)?(?:duplicate|repeating|unique)\s+(?:character|char|element)\b/i.test(q);
}
function isImplementationSnippetQuestion(prompt) {
  const q=normalizeText(prompt).toLowerCase();
  if(!q)return false;
  // Some interview questions are naturally explanation + a small implementation snippet,
  // not a full algorithm program. Keep this conservative so ordinary concepts stay spoken.
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
  return /\b(?:without|avoid|do not use|don't use|not using|using only|instead of|alternative|alternate|another way|different way|different approach|other approach|another solution|alternative solution|different solution)\b/.test(q)
    || /^(?:no[, ]+)?(?:stringbuilder|streams?|hashmap|map|recursion|loop|loops|built[- ]?in|library|libraries|sort|sorting)\b/.test(q);
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
    || /\b(?:time|space) complexity\b|\bedge cases?\b/i.test(q)
    || isCodeAlternativeFollowup(q)
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
  if(isVersionQuestion(q))return 'VERSION';
  if(/\b(difference|differences|different|differentiate|distinguish|compare|comparison|versus|\bvs\b|same or different)\b/i.test(q))return 'COMPARISON';
  if(/\b(advantage|advantages|feature|features|benefit|benefits|types|ways)\b/i.test(q))return 'FEATURES';
  if(/\b(out of memory|oom|production issue|performance issue|debug|troubleshoot|failing|failure|not working|latency issue|slow|incident)\b/i.test(q))return 'TROUBLESHOOTING';
  if(/\b(have you|did you|what did you|what exactly you did|your current|current engagement|recently|experience with|worked on|implemented|used in your project|in your project|tell me about your)\b/i.test(q))return 'EXPERIENCE';
  if(/\b(how do you|how did you|how would you|walk me through|flow|framework|mechanism|architecture|design|end[- ]to[- ]end|bring .* data|ingest|pipeline|implement it)\b/i.test(q))return 'IMPLEMENTATION_FLOW';
  if(/\b(what is|what are|why|when|where|which|how does|how is|how are|how can|explain|define|describe)\b/i.test(q))return 'CONCEPT';
  return 'DIRECT';
}
function exampleGuidance(question, followupInfo=null) {
  const q=normalizeText(question).toLowerCase();
  const shape=spokenAnswerShape(question);
  const explicit=/\b(example|examples|for example|scenario|use case|real[- ]?time|real[- ]?world|where did you use|how did you use|what did you implement|what exactly you did|implemented in your project|used in your project|in your project)\b/i.test(q);
  const projectApplication=/\b(used|implemented|applied|handled|handling|business logic|additional logic|project|production|current engagement|worked on)\b/i.test(q);
  const narrowCorrection=/^(?:no[,. ]+|correct|right|but|okay|so)?\s*(?:is that|does that|will that|can that|are you saying|do you mean|why\??$|how\??$)/i.test(q)
    || /\b(checkpoint only|insert(?:s)? versus update(?:s)?|identify insert|identify update)\b/i.test(q);
  const alreadyConcreteFlow=shape==='IMPLEMENTATION_FLOW' && /\b(how (?:are|do|did|would)|load(?:ed|ing)?|process(?:ed|ing)?|flow|pipeline|from .{0,30} to)\b/i.test(q);

  if(explicit) return 'INCLUDE_ONE: The interviewer explicitly asks for, or strongly implies, a practical example. Include exactly one concise example after the direct explanation. For candidate/project-specific examples, use only facts supported by RETRIEVED EVIDENCE; never invent project details.';
  if(narrowCorrection) return 'OMIT_UNLESS_NEEDED: This is primarily a correction/clarification. Do not add a separate example when the mechanism itself answers the question; add one only if it resolves otherwise-remaining ambiguity.';
  if(projectApplication && ['EXPERIENCE','CONCEPT','DIRECT','FEATURES'].includes(shape)) return 'INCLUDE_IF_GROUNDED_AND_USEFUL: Prefer one short concrete project/production example when it makes the answer easier to explain. Use only RETRIEVED EVIDENCE for personal/project facts. Skip the example if the evidence is insufficient or the preceding sentence is already concrete enough.';
  if(alreadyConcreteFlow) return 'OPTIONAL_NON_REDUNDANT: The answer is already an implementation/process flow. Add one short example only when it demonstrates a decision, transformation, or business outcome not already obvious from the flow; otherwise omit it.';
  if(shape==='CONCEPT') return 'OPTIONAL_FOR_CLARITY: Add one concise example only when the concept is materially easier to understand through application. Do not force examples for narrow definitions or facts.';
  return 'OPTIONAL_NON_REDUNDANT: Use one concise example only when it materially improves the answer. Never add an example merely to fill space, and never invent candidate-specific facts.';
}

function responseMode(question, followupInfo=null, inputSource='') {
  const type=classifyResponseType(question,followupInfo,inputSource);
  const codingFollowup=type==='code'&&!!followupInfo?.previous&&isCodingFollowupQuestion(question);
  if(type==='multi') return 'MULTI_QUESTION_REQUIRED: Cover every detected interviewer question in the same response and in the same order. If the questions are related, combine them naturally into one connected answer while explicitly satisfying both. If they are distinct, answer the first briefly at a useful high level, then transition immediately to the second and answer it directly. Never discard the first question just because the second is newer. If any sub-question asks for code, include the requested working code for that sub-question rather than explanation only.';
  if (type==='code'&&codingFollowup) return 'CODING_REQUIRED_FOLLOW_UP: Answer the current follow-up directly in 1-3 short sentences. Then write "Logic:" with the simple approach in 1-2 concise lines, followed by "Complete code:" and the entire relevant earlier working solution. If the interviewer asks for an alternative/another way, provide a complete alternative implementation of the same earlier problem rather than explanation only. Preserve the original problem constraints unless the follow-up changes them. Include concise inline comments for every meaningful logical step. When a complete runnable program is printed, finish with one small "Sample input:" and matching "Sample output:" example.';
  if (type==='code') return 'CODING_REQUIRED: Start with "Logic:" and explain the simple approach in 1-2 concise lines. Then write "Complete code:" and provide one complete working solution in the requested or context-supported language. Include concise inline comments for every meaningful logical step. When a complete runnable program is printed, finish with one small "Sample input:" and matching "Sample output:" example.';
  if (type==='snippet') return 'EXPLANATION_WITH_CODE_SNIPPET: Answer the question directly in 2-4 concise sentences, then write "Code snippet:" and give the smallest practical snippet that demonstrates how to implement it in the requested or context-supported language/framework. Do not force a full standalone program or sample input/output unless the interviewer asks for it.';
  if (type==='diagram') return 'DRAWABLE_DIAGRAM_REQUIRED: Give a one-line overview, then a detailed monospaced Unicode box-drawing flow that can be copied into Notepad or redrawn in draw.io. Use boxes made with ┌ ─ ┐ │ └ ┘, directional arrows, branch labels, data/control direction, external systems and failure/return paths where relevant. Follow the diagram with only the essential explanation.';
  return `SPOKEN_INTERVIEW_EXPLAINED${String(inputSource).startsWith('screen-capture')?' (screen-captured input; apply exactly the same quality and format rules as typed input)':''}`;
}
function answerTokenBudget(question, hasImage=false,responseType='') {
  const q = String(question || '');
  // max_output_tokens is a ceiling, not a target. A slightly larger ceiling prevents
  // Responses API reasoning tokens from crowding out the visible interview answer.
  // The prompt still keeps normal answers concise, so this does not force extra verbosity.
  if (responseType==='code'||isCodingQuestion(q)) return 3600;
  if (responseType==='multi') return /\b(?:code|program|function|method|implement|write)\b/i.test(q)?3000:1800;
  if (responseType==='snippet'||isImplementationSnippetQuestion(q)) return 1600;
  if (responseType==='diagram'||isDiagramQuestion(q)) return 3000;
  if (hasImage || /\b(design|architecture|system design)\b/i.test(q)) return 1800;
  if (/\b(introduce yourself|tell me about yourself|self[- ]introduction)\b/i.test(q)) return 1000;
  if (wantsExpandedAnswer(q)) return 1200;
  if (/\b(what is|what are|difference|compare|why|how|explain|describe|experience|implemented|troubleshoot|debug|flow|pipeline|framework)\b/i.test(q)) return 750;
  return 600;
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
  const history = info.isFollowup
    ? session.turns.slice(-MAX_HISTORY_TURNS).map((t,i) => `Turn ${i+1}\nInterviewer: ${t.question}\nCandidate: ${t.answer}`).join('\n\n')
    : '';
  const evidence = retrieved.map((c,i) => {
    const sourceName = c.source === 'resume' ? 'Resume' : (c.source === 'jd' ? 'JD' : String(c.source || 'Source'));
    const sourceId = `${c.source === 'resume' ? 'R' : (c.source === 'jd' ? 'J' : 'S')}${i+1}`;
    return `[${sourceId}] ${sourceName} · ${c.section}\n${c.text.slice(0, 800)}`;
  }).join('\n\n');
  const projectHighlights=(profile.projectHighlights||[]).slice(0,8).map((item,index)=>`${index+1}. ${normalizeText(item).slice(0,360)}`).join('\n');
  const followup = info.isFollowup
    ? `YES. Treat the current words as a continuation/modifier of the immediately previous interviewer request. Resolved intent:\n${info.resolvedQuestion}`
    : 'NO';
  const sameQuestionAnswers=regenerate?session.turns
    .filter(turn=>normalizeText(turn.question).toLowerCase()===normalizeText(intentQuestion).toLowerCase())
    .slice(-3):[];
  const priorAnswersForRegenerate=sameQuestionAnswers.length?sameQuestionAnswers:session.turns.slice(-1);
  const reanswer=regenerate
    ? `YES. Re-answer the same interviewer request with a materially different, independently useful approach while preserving all factual grounding and explicit constraints. Correct any weakness in the earlier answers. Do not mention that this is a retry or re-answer. For coding, use a different valid implementation/structure when practical without violating the requested constraints. Recent answers to avoid merely repeating:
${priorAnswersForRegenerate.map((turn,index)=>`Earlier answer ${index+1}:
${String(turn?.answer||'').slice(0,3500)}`).join('\n\n')}`
    : 'NO';
  return `CANDIDATE PROFILE\nYears: ${Number.isFinite(session.yearsExperience)?session.yearsExperience:'Not specified'}\nTarget role: ${session.role || profile.targetRole || 'Not specified'}\n${profile.candidateSummary || ''}\nPrimary skills: ${(profile.primarySkills || []).join(', ')}\nCanonical resume/JD vocabulary: ${(profile.domainVocabulary || profile.primarySkills || []).join(', ')}\n\nPROJECT/EXPERIENCE HIGHLIGHTS\n${projectHighlights || 'Use retrieved resume evidence for project-specific claims.'}\n\nJOB ALIGNMENT\n${profile.jdSummary || 'No job description supplied; use resume-only grounding.'}\n\nRETRIEVED EVIDENCE\n${evidence || 'No prepared evidence matched.'}\n\nRECENT INTERVIEW CONTEXT\n${history || 'Not supplied because the current question is standalone.'}\n\nCONTEXTUAL FOLLOW-UP\n${followup}\n\nRE-ANSWER REQUEST\n${reanswer}\n\nINPUT SOURCE\n${inputSource||'system-audio-or-typed'}\n\nMULTI-QUESTION POLICY\n${multiQuestionGuidance(intentQuestion)}\n\nRESPONSE MODE\n${responseMode(intentQuestion,info,inputSource)}\n\nSPOKEN ANSWER SHAPE\n${spokenAnswerShape(intentQuestion)}\n\nEXAMPLE POLICY\n${exampleGuidance(intentQuestion,info)}\n\nREFRAMED CURRENT INTENT (this alone controls answer type and requested output)\n${intentQuestion}\n\nRAW CURRENT TRANSCRIPT (context only; incidental words such as code, coding or module do not control the format)\n${correctedQuestion}\n\nDEPTH\n${wantsExpandedAnswer(intentQuestion) ? 'Expanded answer requested.' : 'Default: direct interview answer with concise practical elaboration.'}`;
}
const COPILOT_INSTRUCTIONS = `You are the candidate in a live senior/lead engineer interview. Return only the answer the candidate can speak. Never mention AI, prompts, retrieval, transcription, CV/JD evidence, or how the answer was generated.

CORE RESPONSE RULES
- Start with the real answer immediately. Never start with acknowledgement/readiness filler such as "I am ready to proceed", "I can walk you through", "Sure", "Certainly", "Absolutely", "Of course", "Here is the answer", or similar.
- Do not repeat or paraphrase the interviewer's question before answering.
- Normal answers must sound like a working engineer speaking naturally, not notes being read. Prefer short connected paragraphs and complete sentences.
- Do NOT default to heading/bullet patterns such as "Kafka Offsets - ...", "Checkpointing - ...", "Request Routing & Middleware: ...", or "Collect Metrics: ...". Convert those ideas into a connected spoken flow.
- Use bullets only when the interviewer explicitly asks to list/name/enumerate items, or when a true checklist is materially clearer. Comparisons are the exception described below.
- Give enough high-level implementation detail to make the answer complete and credible. Do not artificially stop at 45 seconds. For normal questions, target roughly 60-120 seconds when the subject needs it; narrow factual questions can be much shorter. Go deeper only when asked.
- Use common senior-engineering language: "I used", "I worked on", "I implemented", "we handled", "the main reason was", "we needed to", "this helped us". Avoid inflated wording.

GROUNDING AND TERMINOLOGY
- RETRIEVED EVIDENCE is the authority for claims that I personally used/built/owned/deployed something. JD requirements are not proof of past experience.
- General technical knowledge may explain a technology, but do not turn it into a personal production claim without resume evidence.
- If my production experience with the exact technology is unsupported, say that once naturally, then explain the closest relevant experience and/or the concrete production-style implementation/POC approach. Never invent that I completed a POC or production implementation.
- Silently repair obvious speech-to-text technology names using the canonical Resume/JD vocabulary, current question, and recent conversation. Prefer the technology that best fits the candidate stack and JD. Do not tell the interviewer that a word was corrected.
- Current-question intent outranks prior turns. Use prior context only for a genuine continuation such as "that", "same", "why?", "show code for it", a coding constraint, or a request for an alternative/another implementation. For an alternative-code follow-up, carry forward the actual earlier coding problem and return working code, not a generic explanation.

ANSWER SHAPE
- Concept/direct question: answer in one direct sentence, then explain how it works and why/when it matters in connected paragraphs.
- Experience/project question: when supported, speak in first person and naturally cover what I used -> how I used it -> why -> result/operational consideration. Do not split those into labelled bullets.
- Implementation/flow question: explain the real runtime/process flow in order as connected speech. Include the important components, data/control movement, failure handling, and validation only when relevant.
- Troubleshooting/scenario question: start with the immediate production action, then walk through evidence -> isolation -> fix -> validation. Mention concrete commands/tools where useful, but do not turn each step into a labelled bullet by default.
- Features/advantages: give the direct point, then explain the important 3-5 items naturally. Use a list only if explicitly requested.
- Comparison/difference: first give the one-line key distinction. Then explain the first item fully in one compact labelled paragraph, then the second item fully in the same pattern. Finish with the practical difference when useful. Do not use a table or alternating attribute bullets unless requested.
- Version question: ONLY when the CURRENT question explicitly asks a software/framework version, put the version in the first sentence. If an exact project version is supported, use it. Otherwise give the penultimate stable major/minor release line you reliably know and add one brief qualifier that the exact project version is not documented. Never inject versions into unrelated answers and never invent patch/build numbers.
- Narrow yes/no or factual follow-up: answer in 1-3 sentences without padding.

ADAPTIVE CODE
- For a normal technical explanation, add a tiny 1-2 line code/config/command statement only when it materially clarifies the mechanism and is natural for that topic. Examples: a useMemo/useCallback line, a pprof command, a SQL MERGE shape. Never force code into every answer.
- If the interviewer explicitly asks to write/implement/solve/debug code, follow RESPONSE MODE exactly: give Logic, complete working code, meaningful inline comments, and sample input/output when applicable. Do not substitute pseudo-code for requested implementation.
- If the interviewer asks "how would you implement it" and clearly expects implementation code, provide the complete implementation, not only verbal logic.

STYLE EXEMPLARS — imitate the rhythm, not the facts
Example A — streaming implementation:
"Yes. So in my case, when I was processing Kafka data through Structured Streaming in Databricks, I mainly relied on Kafka offsets and checkpointing. Once a micro-batch was successfully processed, Spark maintained the progress in the checkpoint location, so the next batch picked up only new records instead of processing the same data again. If the job failed or restarted, it continued from the last committed checkpoint. While writing into Delta tables, wherever updates were involved, I used MERGE logic to handle them and avoid duplicates. From the monitoring side, I checked Kafka consumer lag and streaming failures to make sure the pipeline was continuously processing."
Example B — troubleshooting:
"For a Go API suddenly reaching 90% CPU, I would capture runtime evidence before restarting it, because otherwise I may lose the actual cause. I would first correlate the spike with request rate, latency and the affected endpoints, then take a short pprof CPU profile, for example \`go tool pprof ...\`, to identify the hot path. If needed I would inspect goroutines and GC behavior as well. Once I isolate whether it is a tight loop, expensive serialization, crypto, excessive concurrency or another hotspot, I would fix that path and validate it under representative load before rolling it out."
Example C — concept with tiny code only because it helps:
"useMemo caches a computed value, whereas useCallback keeps a stable function reference. I use useMemo when a calculation is expensive and should run only when its dependencies change, for example \`const rows = useMemo(() => filter(data), [data]);\`. I use useCallback mainly when I pass a callback to a memoized child and want to avoid changing that function reference unnecessarily."

OUTPUT
- Plain text only for spoken answers. No Markdown bold/italic and no decorative headings.
- The first words must be substantive answer content. No preamble, no question repetition, no self-introduction.
- Produce the desired final wording and structure in the first generation. The live client treats streamed text as immutable and will not replace or shorten it after it appears.
- Keep the answer technically specific but easy to speak. Do not dump keywords without explaining the connection.
- Do not invent project metrics, architectures, tools or responsibilities just because they are plausible.
- If the input is genuinely unintelligible, ask for the interview question again briefly instead of guessing.`
function strictModeInstructions(responseType) {
  if(responseType==='multi')return 'NON-NEGOTIABLE OUTPUT CONTRACT: The current prompt contains multiple interviewer questions. Cover every question in the original order. Related questions may be merged into one connected explanation; distinct questions must both be answered, with the first concise and the second immediately after it. Never answer only the last question. If a sub-question requests code, include usable code for that sub-question.';
  if(responseType==='code')return 'NON-NEGOTIABLE OUTPUT CONTRACT: This is a coding response. Explanation without a complete compilable/runnable solution is invalid. Output Logic:, then Complete code:, then the full code with meaningful inline comments. When a complete runnable program is printed, include one Sample input: and matching Sample output:. For a follow-up, include the entire previous solution again after the explanation.';
  if(responseType==='snippet')return 'NON-NEGOTIABLE OUTPUT CONTRACT: This question requires a practical implementation snippet. Give the concise explanation first, then Code snippet: followed by usable code. Explanation-only output is invalid. Keep the snippet small; do not force full program scaffolding or sample input/output unless requested.';
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
function hasCodeSnippet(answer) {
  const text=String(answer||'');
  const hasLabel=/\bCode snippet:\s*/i.test(text);
  const executable=/\b(?:class|function|def|return|for\s*\(|while\s*\(|if\s*\(|try\s*\{|catch\s*\(|new\s+[A-Z]|driver\.|HttpURLConnection|requests\.|fetch\s*\(|axios\.|console\.log|System\.out)\b/i.test(text);
  return hasLabel&&executable&&text.split('\n').filter(line=>line.trim()).length>=4;
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
  // Strip provider acknowledgement/readiness filler so the overlay starts with the answer.
  text=text.replace(/^\s*(?:I(?:'|’)m|I am) ready to proceed[.!,:;\s-]*/i,'');
  text=text.replace(/^\s*(?:I can|I(?:'|’)ll|I will) (?:walk you through|explain|go through|talk through)(?: how I approach)?[^.!?]{0,140}[.!?]\s*/i,'');
  text=text.replace(/^\s*(?:Sure|Certainly|Absolutely|Of course|Okay|Here(?:'|’)s the answer|Here is the answer|Yes[,.:;]?\s+(?=I can walk you through))[.!,:;\s-]*/i,'');
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
function stripOpeningAnswerFiller(value) {
  let text=String(value||'');
  let previous='';
  do {
    previous=text;
    text=text
      .replace(/^\s*(?:I(?:'|’)m|I am) ready to proceed[.!,:;\s-]*/i,'')
      .replace(/^\s*(?:Sure|Certainly|Absolutely|Of course|Okay)[.!,:;\s-]+/i,'')
      .replace(/^\s*(?:Here(?:'|’)s|Here is) (?:the )?(?:answer|response)[.!,:;\s-]*/i,'')
      .replace(/^\s*Yes[,.:;]?\s+(?=(?:I can|I(?:'|’)ll|I will)\s+(?:walk you through|explain|go through|talk through))/i,'')
      .replace(/^\s*(?:I can|I(?:'|’)ll|I will) (?:walk you through|explain|go through|talk through)(?: how I approach)?[^.!?]{0,180}[.!?]\s*/i,'');
  } while(text!==previous);
  return text;
}
function createImmutableOpeningGate(onVisibleText) {
  let decided=false;
  let buffer='';
  let visible='';
  const possibleFillerStart = value => {
    const t=String(value||'').trimStart().toLowerCase();
    if(!t)return true;
    const starts=['i am ready to proceed',"i'm ready to proceed",'i’m ready to proceed','i can walk you through',"i'll walk you through",'i’ll walk you through','i will walk you through','i can explain',"i'll explain",'i’ll explain','i will explain','i can go through','i will go through','i can talk through','i will talk through','sure','certainly','absolutely','of course','okay','here is the answer',"here's the answer",'here is the response',"here's the response",'yes'];
    return starts.some(prefix=>prefix.startsWith(t)||t.startsWith(prefix));
  };
  const release = force => {
    if(decided)return;
    const boundary=/[.!?](?:\s|$)|\n/.test(buffer);
    if(!force && possibleFillerStart(buffer) && !boundary && buffer.length<120)return;
    const clean=stripOpeningAnswerFiller(buffer);
    if(!force && !clean.trim() && buffer.length<220)return;
    decided=true;
    buffer='';
    if(clean){visible+=clean;onVisibleText(clean);}
  };
  return {
    push(delta){
      const text=String(delta||'');
      if(!text)return;
      if(decided){visible+=text;onVisibleText(text);return;}
      buffer+=text;
      release(false);
    },
    flush(){if(!decided)release(true);return visible;},
    text(){return visible;}
  };
}

async function ensureModeConformance({answer,responseType,prompt,model,effort,provider='openai',allowRepair=true}) {
  if(!allowRepair)return {answer:String(answer||''),repaired:false};
  let clean=removeExactRepeatedOutput(answer);
  if(responseType==='diagram'){
    clean=makeDrawableDiagram(clean);
    if(hasDrawableDiagram(clean))return {answer:clean,repaired:clean!==answer};
  } else if(responseType==='code'&&hasCompleteCode(clean))return {answer:clean,repaired:clean!==answer};
  else if(responseType==='snippet'&&hasCodeSnippet(clean))return {answer:clean,repaired:clean!==answer};
  else if(responseType==='spoken'){const formatted=formatSpokenAnswer(clean);return {answer:formatted,repaired:formatted!==answer};}

  try {
    const correction=await providerResponseJson({
      provider,model,
      instructions:`${COPILOT_INSTRUCTIONS}

${strictModeInstructions(responseType)}`,
      input:`Produce the required final answer now. The earlier output violated the mandatory ${responseType} format. Do not discuss the violation.

ORIGINAL REQUEST AND CONTEXT:
${typeof prompt==='string'?prompt:JSON.stringify(prompt)}

INCOMPLETE OUTPUT TO REPLACE:
${clean}`,
      effort,maxTokens:1800
    });
    clean=removeExactRepeatedOutput(providerOutputText(provider,correction));
    if(responseType==='diagram')clean=makeDrawableDiagram(clean);
    return {answer:clean,repaired:true};
  } catch(err) {
    console.warn(`[LLM format] ${responseType} correction failed:`,err.message);
    return {answer:clean,repaired:clean!==answer};
  }
}
function selectAnswerRoute(_question, prepared=null, _options={}) {
  // The user explicitly chooses the live answer provider on Prepare Interview.
  // No automatic routing/classifier is introduced, so latency and answer flow remain deterministic.
  const selected=String(prepared?.session?.answerProvider||'openai');
  if(selected==='cerebras') return {provider:'cerebras',model:CEREBRAS_MODEL,effort:CEREBRAS_REASONING_EFFORT,tier:'cerebras',reason:'user-selected-cerebras-gpt-oss-120b'};
  if(selected==='gemini') return {provider:'gemini',model:GEMINI_MODEL,effort:'low',tier:GEMINI_MODEL,reason:'user-selected-gemini'};
  if(selected==='terra') return {provider:'openai',model:OPENAI_TERRA_MODEL,effort:LLM_REASONING_EFFORT,tier:'openai-terra-fast',reason:'user-selected-openai-terra-fast'};
  if(selected==='luna') return {provider:'openai',model:OPENAI_LUNA_MODEL,effort:LLM_REASONING_EFFORT,tier:'openai-luna-fast',reason:'user-selected-openai-luna-fast'};
  if(selected==='gpt4o') return {provider:'openai',model:OPENAI_4O_MODEL,effort:'none',tier:'openai-gpt-4o',reason:'user-selected-openai-gpt-4o'};
  if(selected==='gpt4omini') return {provider:'openai',model:OPENAI_4O_MINI_MODEL,effort:'none',tier:'openai-gpt-4o-mini',reason:'user-selected-openai-gpt-4o-mini'};
  return {provider:'openai',model:LLM_DEFAULT_MODEL,effort:LLM_REASONING_EFFORT,tier:'openai-sol-fast',reason:'user-selected-openai-sol-fast'};
}
function addTurn(session, question, answer, retrieved=[],responseType='spoken') {
  session.turns.push({ question:normalizeStructuredText(question).slice(0,4000), answer:normalizeStructuredText(answer).slice(0,14000), responseType, retrieved:retrieved.slice(0, TOP_K).map(c => ({source:c.source, section:c.section, text:c.text, score:c.score})), at:Date.now() });
  if (session.turns.length > MAX_HISTORY_TURNS) session.turns = session.turns.slice(-MAX_HISTORY_TURNS);
}
async function prepareQuestion(email, question, {inputSource='', requestId='', clientSentAt=0, userActionAt=0, regenerate=false}={}) {
  const startedAt = Date.now();
  const perf = { requestId:String(requestId||''), clientToBackendMs:Number(clientSentAt)>0?Math.max(0,startedAt-Number(clientSentAt)):null, userActionToBackendMs:Number(userActionAt)>0?Math.max(0,startedAt-Number(userActionAt)):null };
  const intentStartedAt = Date.now();
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
  perf.intentMs = Date.now() - intentStartedAt;
  const retrievalDecisionStartedAt = Date.now();

  if (!rejection && session?.chunks?.length) {
    const previous = followupInfo.previous;
    const retrievalBase = followupInfo.isFollowup ? followupInfo.resolvedQuestion : intentQuestion;
    const retrievalQuery = expandQuestionWithCanonicalTerms(session, retrievalBase);

    const retrievalCacheKey = `${email}|${session.preparedAt||0}|${normalizeText(retrievalQuery).toLowerCase().slice(0,1600)}`;
    if (followupInfo.isFollowup && previous?.retrieved?.length) {
      // Reuse prior evidence only for a genuine follow-up; standalone questions never inherit old-turn evidence.
      retrieved = previous.retrieved.map(c => ({...c}));
      retrievalMode = 'history-reuse';
      perf.retrievalCacheHit = false;
    } else if (retrievalResultCache.has(retrievalCacheKey)) {
      // Exact standalone retrieval reuse. Chunks are immutable for a prepared session, so this changes latency only, not evidence selection.
      retrieved = retrievalResultCache.get(retrievalCacheKey).map(c => ({...c}));
      retrievalMode = 'retrieval-cache';
      perf.retrievalCacheHit = true;
    } else if (RAG_QUERY_MODE === 'local') {
      const r0 = Date.now();
      retrieved = retrieveChunksLocal(session, retrievalQuery);
      retrievalMs = Date.now() - r0;
      retrievalMode = 'local-bm25-context';
      perf.retrievalCacheHit = false;
      retrievalResultCache.set(retrievalCacheKey, retrieved.map(c => ({...c})));
    } else if (canUseFastLexical(session, retrievalQuery)) {
      const r0 = Date.now();
      retrieved = retrieveChunksLexical(session, retrievalQuery);
      retrievalMs = Date.now() - r0;
      retrievalMode = 'lexical-fast';
      perf.retrievalCacheHit = false;
      retrievalResultCache.set(retrievalCacheKey, retrieved.map(c => ({...c})));
    } else {
      const embeddingKey = normalizeText(retrievalQuery).toLowerCase().slice(0,1200);
      perf.embeddingCacheHit = queryEmbeddingCache.has(embeddingKey);
      const e0 = Date.now();
      const vector = await embedQuery(retrievalQuery);
      embeddingMs = Date.now() - e0;
      const r0 = Date.now();
      retrieved = retrieveChunks(session, vector, retrievalQuery);
      retrievalMs = Date.now() - r0;
      retrievalMode = perf.embeddingCacheHit ? 'vector-hybrid-embedding-cache' : 'vector-hybrid';
      perf.retrievalCacheHit = false;
      retrievalResultCache.set(retrievalCacheKey, retrieved.map(c => ({...c})));
    }
    if (retrievalResultCache.size > RETRIEVAL_RESULT_CACHE_MAX) retrievalResultCache.delete(retrievalResultCache.keys().next().value);
  }
  perf.retrievalDecisionMs = Date.now() - retrievalDecisionStartedAt;
  const promptBuildStartedAt = Date.now();
  const prompt = session ? buildPrompt(session, question, retrieved, followupInfo, correctedQuestion,inputSource,intentQuestion,regenerate) : `INPUT SOURCE\n${inputSource||'system-audio-or-typed'}\n\nMULTI-QUESTION POLICY\n${multiQuestionGuidance(intentQuestion)}\n\nRESPONSE MODE\n${responseMode(intentQuestion,followupInfo,inputSource)}\n\nREFRAMED CURRENT INTENT\n${intentQuestion}\n\nRAW CURRENT TRANSCRIPT (context only)\n${correctedQuestion}\n\nDEPTH\n${wantsExpandedAnswer(intentQuestion) ? 'Expanded answer requested.' : 'Default: direct interview answer with concise practical elaboration.'}`;
  perf.promptBuildMs = Date.now() - promptBuildStartedAt;
  perf.promptChars = String(prompt||'').length;
  perf.promptTokenEstimate = Math.ceil(perf.promptChars / 4);
  return { session, prompt, retrieved, rejection, followupInfo, responseType, correctedQuestion, intentQuestion, canonicalReplacements:canonical.replacements, latency:{ startedAt, embeddingMs, retrievalMs, retrievalMode, promptReadyMs:Date.now()-startedAt, ...perf } };
}
app.get('/', (_req, res) => res.json({ ok:true, service:'Topper Backend', stt:'/stt', llm:'/ask', llmStream:'/ask/stream', prepare:'/prepare-context', llmProvider:'user-selectable', llmModel:LLM_DEFAULT_MODEL, cerebrasModel:CEREBRAS_MODEL, terraModel:OPENAI_TERRA_MODEL, lunaModel:OPENAI_LUNA_MODEL, gpt4oModel:OPENAI_4O_MODEL, gpt4oMiniModel:OPENAI_4O_MINI_MODEL, geminiModel:GEMINI_MODEL, openaiServiceTier:OPENAI_SERVICE_TIER, reasoningEffort:LLM_REASONING_EFFORT, visionProvider:'openai', llmRouting:{enabled:false,mode:'manual-selection',default:'openai',options:['openai','terra','luna','gpt4o','gpt4omini','gemini','cerebras']}, embeddingModel:EMBEDDING_MODEL, ragQueryMode:RAG_QUERY_MODE }));
app.get('/health', (_req, res) => res.json({ ok:true, llmProvider:'user-selectable', llmModel:LLM_DEFAULT_MODEL, cerebrasModel:CEREBRAS_MODEL, openaiConfigured:!!OPENAI_API_KEY, cerebrasConfigured:!!CEREBRAS_API_KEY, geminiConfigured:!!GEMINI_API_KEY, openaiServiceTier:OPENAI_SERVICE_TIER, reasoningEffort:LLM_REASONING_EFFORT, ragQueryMode:RAG_QUERY_MODE }));

app.post('/validate-license', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ ok:false, reason:'email required' });
  const result = isLicenseValid(email);
  return res.status(result.ok ? 200 : 401).json(result);
});

app.post('/prepare-context', async (req, res) => {
  const email = requireLicensedRequest(req, res); if (!email) return;
  if (!OPENAI_API_KEY) return res.status(500).json({ ok:false, error:'OPENAI_API_KEY missing on backend for one-time CV/JD profile preparation' });
  const rawYears=req.body.yearsExperience;
  const yearsExperience=(rawYears===null||rawYears===undefined||String(rawYears).trim()==='')?null:Number(rawYears);
  const role = normalizeText(req.body.role || '').slice(0,160);
  const requestedProvider=String(req.body.answerProvider || 'openai').trim().toLowerCase();
  const answerProvider=['openai','terra','luna','gpt4o','gpt4omini','gemini','cerebras'].includes(requestedProvider)?requestedProvider:'openai';
  if(answerProvider==='cerebras'&&!CEREBRAS_API_KEY)return res.status(500).json({ok:false,error:'CEREBRAS_API_KEY missing on backend for selected model'});
  if(answerProvider==='gemini'&&!GEMINI_API_KEY)return res.status(500).json({ok:false,error:'GEMINI_API_KEY missing on backend for selected model'});
  if((answerProvider==='openai'||answerProvider==='terra'||answerProvider==='luna'||answerProvider==='gpt4o'||answerProvider==='gpt4omini')&&!OPENAI_API_KEY)return res.status(500).json({ok:false,error:'OPENAI_API_KEY missing on backend for selected model'});
  if (yearsExperience!==null && (!Number.isFinite(yearsExperience) || yearsExperience < 0 || yearsExperience > 60)) return res.status(400).json({ ok:false, error:'yearsExperience must be between 0 and 60 when provided' });
  if (!req.body.resume) return res.status(400).json({ ok:false, error:'Resume is required' });
  const t0 = Date.now();
  try {
    const [resumeText, jdFileText] = await Promise.all([extractDocumentText(req.body.resume), extractDocumentText(req.body.jd)]);
    const jdText = normalizeText(`${jdFileText}\n${String(req.body.jdText || '')}`).slice(0, MAX_DOCUMENT_CHARS);
    const parseMs = Date.now() - t0;

    const summaryStart = Date.now();
    const profile = await generateStructuredProfile(resumeText, jdText, yearsExperience, role);
    const summaryMs = Date.now() - summaryStart;
    const resolvedYears=Number.isFinite(profile.yearsExperience)?profile.yearsExperience:(Number.isFinite(yearsExperience)?yearsExperience:null);
    const resolvedRole=normalizeText(profile.targetRole || role || '').slice(0,160);

    const chunks = [...semanticChunks(resumeText, 'resume'), ...(jdText?semanticChunks(jdText, 'jd'):[])];
    let embeddingMs = 0;
    if (RAG_QUERY_MODE === 'hybrid') {
      const embeddingStart = Date.now();
      const vectors = await embedTexts(chunks.map(c => `${c.source}: ${c.section}\n${c.text}`));
      if (vectors.length !== chunks.length) throw new Error('Embedding count did not match document chunks');
      chunks.forEach((c,i) => { c.embedding = vectors[i]; });
      embeddingMs = Date.now() - embeddingStart;
    }
    const localRetrievalIndex = buildLocalRetrievalIndex(chunks);

    interviewSessions.set(email, {
      email, yearsExperience:resolvedYears, role:resolvedRole, answerProvider, profile:{...profile,yearsExperience:resolvedYears,targetRole:resolvedRole}, chunks, localRetrievalIndex, turns:[], preparedAt:Date.now(),
      stats:{ resumeChars:resumeText.length, jdChars:jdText.length, chunkCount:chunks.length, parseMs, summaryMs, embeddingMs, ragQueryMode:RAG_QUERY_MODE }
    });
    console.log(`[RAG] Prepared ${email}: ${chunks.length} chunks in ${Date.now()-t0}ms`);
    return res.json({ ok:true, answerProvider, answerModel:answerProvider==='cerebras'?CEREBRAS_MODEL:(answerProvider==='terra'?OPENAI_TERRA_MODEL:(answerProvider==='luna'?OPENAI_LUNA_MODEL:(answerProvider==='gpt4o'?OPENAI_4O_MODEL:(answerProvider==='gpt4omini'?OPENAI_4O_MINI_MODEL:(answerProvider==='gemini'?GEMINI_MODEL:LLM_DEFAULT_MODEL))))), chunkCount:chunks.length, profile:{ yearsExperience:resolvedYears, targetRole:resolvedRole, primarySkills:(profile.primarySkills || []).slice(0,12), jdProvided:!!jdText }, latency:{ parseMs, summaryMs, embeddingMs, totalMs:Date.now()-t0 } });
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
  if (text.length > 12000) return res.status(400).json({ ok:false, error:'Transcript input too long' });
  try {
    const prepared = await prepareQuestion(email, text);
    if (prepared.rejection) return res.json({ ok:true, answer:prepared.rejection, model:'local-guard', modelTier:'local', contextPrepared:!!prepared.session, retrieved:[], latency:{...prepared.latency, llmMs:0, totalMs:Date.now()-prepared.latency.startedAt} });
    const route = selectAnswerRoute(text, prepared);
    const llmStart = Date.now();
    const cerebrasQuality = route.provider==='cerebras' ? `

CEREBRAS QUALITY CALIBRATION:
- Match the maturity, relevance and technical precision of a strong senior-engineer interview answer.
- Current-question intent outranks prior-turn context; do not inherit the previous topic unless this is an explicit follow-up.
- Do not add plausible-but-unsupported technologies, metrics, files, tools or implementation details.
- For finite concept lists, be complete on the first response when practical.` : '';
    const data = await providerResponseJson({
      provider:route.provider,model:route.model,instructions:`${COPILOT_INSTRUCTIONS}${cerebrasQuality}

${strictModeInstructions(prepared.responseType)}`,input:prepared.prompt,
      effort:route.effort,maxTokens:answerTokenBudget(text,false,prepared.responseType)
    });
    let answer=providerOutputText(route.provider,data);
    answer=(await ensureModeConformance({answer,responseType:prepared.responseType,prompt:prepared.prompt,model:route.model,effort:route.effort,provider:route.provider})).answer;
    if (prepared.session && answer) addTurn(prepared.session,prepared.intentQuestion||text,answer,prepared.retrieved,prepared.responseType);
    const latency = { embeddingMs:prepared.latency.embeddingMs, retrievalMs:prepared.latency.retrievalMs, retrievalMode:prepared.latency.retrievalMode, promptReadyMs:prepared.latency.promptReadyMs, llmMs:Date.now()-llmStart, totalMs:Date.now()-prepared.latency.startedAt };
    const providerServiceTier=route.provider==='cerebras'?CEREBRAS_SERVICE_TIER:String(data?.service_tier||OPENAI_SERVICE_TIER);
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
  return normalizeText(`Candidate role: ${profile.targetRole || session.role || ''}\nYears experience: ${Number.isFinite(session.yearsExperience)?session.yearsExperience:'not specified'}\nPrimary skills: ${skills}\n${recent}`);
}

function buildVisionInput(text, imageDataUrl, session, captureSource='') {
  const context = buildCaptureContext(session);
  const instruction = normalizeText(`${text || 'Analyze and solve the captured screen.'}\n\nCAPTURE CONTEXT\n${captureSource ? `Window: ${captureSource}\n` : ''}${context ? `${context}\n` : ''}Rules for screen tasks:\n- Read the screenshot directly; do not ask me to transcribe visible code or question text.\n- Identify every complete current question visible in the captured content before choosing an answer format. If there are multiple complete questions, preserve them in order; do not silently keep only the last one.\n- A mention of code, coding, development, DevOps, a programming language or a module inside an experience/conceptual question does not make it a coding task.\n- For genuine coding problems, always start with Logic (1-2 lines), then provide complete runnable code in the language visible in the screenshot unless another language is requested. Never return explanation alone.\n- Preserve method/class signatures shown in the screenshot when they are part of the problem contract.\n- Cover edge cases and complexity briefly when relevant.\n- Add concise inline comments to meaningful code statements so the solution can be explained in an interview.\n- For flowchart, architecture-flow or diagram requests, provide a detailed drawable Unicode box flow using ┌ ─ ┐ │ └ ┘, arrows, branches and data direction; never return prose alone.\n- If the screenshot contains an error, diagnose the actual failing line/behavior and provide the corrected code.\n- Keep the answer practical, concise, and directly usable.`);
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
  const extractionRules = `Extract the useful visible content from this screenshot so it can be used as the next interview prompt. The FIRST line must be exactly one of TASK_TYPE: CODING, TASK_TYPE: DIAGRAM, or TASK_TYPE: OTHER. After that first line return only the extracted/normalized prompt text, no analysis and no markdown fences.\n- First identify all complete current question intents; earlier conversational lead-ins do not control TASK_TYPE. If two complete questions are visible, keep both in their original order.\n- Use CODING only for an actual request to write, implement, complete, debug, analyze or run code, or solve an algorithm/data-structure programming task.\n- A question about experience, projects, Agile, DevOps, integrations or concepts is OTHER even when its transcript mentions code, coding, development, a programming language, class or module.\n- Use DIAGRAM for flowchart, architecture-flow, sequence, component, block or draw.io-style requests.\n- Preserve code exactly enough to solve it, including identifiers, method/class signatures, error text and visible line numbers when present.\n- Capture all visible content materially relevant to solving the current question, including supporting code, data, error messages, constraints, expected output, diagram labels, and question context that changes the solution.\n- Preserve explicit constraints and requested output.\n- Ignore Topper UI text, browser chrome, taskbar, notifications and unrelated navigation.\n- If this is a continuation of earlier captured content, keep only what is visible now; the desktop app will append multiple captures.\n- Do not answer the content. Extract it only.\nRecent interview context for disambiguation only:\n${recent}`;
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

// Best-effort local retrieval prefetch while the interviewer/user is still finishing the question.
// In the default local RAG mode this performs NO external network call; it only warms the
// deterministic retrieval-result cache. Hybrid mode retains the old semantic-embedding warmup.
app.post('/prefetch-query', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const question = normalizeStructuredText(req.body?.text || '');
  if (!email || !question || question.length > 12000) return res.status(204).end();
  const license = isLicenseValid(email);
  if (!license.ok) return res.status(204).end();
  const session = interviewSessions.get(email);
  if (!session?.chunks?.length) return res.status(204).end();
  try {
    const canonical = resolveCanonicalQuestion(session, question);
    const correctedQuestion = canonical.corrected || question;
    const intentQuestion = reframeQuestionIntent(correctedQuestion) || correctedQuestion;
    if (rejectLowConfidenceInput(intentQuestion)) return res.status(204).end();
    const followupInfo = resolveFollowupIntent(session, intentQuestion);
    if (followupInfo.isFollowup && followupInfo.previous?.retrieved?.length) return res.status(204).end();
    const retrievalBase = followupInfo.isFollowup ? followupInfo.resolvedQuestion : intentQuestion;
    const retrievalQuery = expandQuestionWithCanonicalTerms(session, retrievalBase);
    const retrievalCacheKey = `${email}|${session.preparedAt||0}|${normalizeText(retrievalQuery).toLowerCase().slice(0,1600)}`;
    if (retrievalResultCache.has(retrievalCacheKey)) return res.status(204).end();

    if (RAG_QUERY_MODE === 'local') {
      const retrieved=retrieveChunksLocal(session,retrievalQuery);
      retrievalResultCache.set(retrievalCacheKey,retrieved.map(c=>({...c})));
    } else if (canUseFastLexical(session, retrievalQuery)) {
      const retrieved=retrieveChunksLexical(session,retrievalQuery);
      retrievalResultCache.set(retrievalCacheKey,retrieved.map(c=>({...c})));
    } else {
      const key = normalizeText(retrievalQuery).toLowerCase().slice(0,1200);
      if (!queryEmbeddingCache.has(key)) await embedQuery(retrievalQuery);
    }
    if (retrievalResultCache.size > RETRIEVAL_RESULT_CACHE_MAX) retrievalResultCache.delete(retrievalResultCache.keys().next().value);
    return res.status(204).end();
  } catch (err) {
    console.warn('[PREFETCH] skipped:', err.message);
    return res.status(204).end();
  }
});

app.post('/ask/stream', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const text = normalizeStructuredText(req.body.text || '');
  const inputSource=normalizeText(req.body.inputSource||'').slice(0,40);
  const imageDataUrl = String(req.body.imageDataUrl || '').trim();
  const captureSource = normalizeText(req.body.captureSource || '').slice(0,300);
  const requestId = normalizeText(req.body.requestId || '').slice(0,120);
  const clientSentAt = Number(req.body.clientSentAt || 0);
  const userActionAt = Number(req.body.userActionAt || 0);
  const regenerate = req.body.regenerate === true;
  const hasImage = /^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(imageDataUrl);
  if (!email || (!text && !hasImage)) return res.status(400).json({ ok:false, error:'email and text or image are required' });
  const license = isLicenseValid(email); if (!license.ok) return res.status(401).json({ ok:false, error:license.reason || 'Invalid license' });
  if (hasImage && !OPENAI_API_KEY) return res.status(500).json({ ok:false, error:'OPENAI_API_KEY missing on backend for vision' });
  const maxInputChars=String(inputSource).startsWith('screen-capture')?32000:12000;
  if (text.length > maxInputChars) return res.status(400).json({ ok:false, error:'Transcript input too long' });

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
      prepared = await prepareQuestion(email,text,{inputSource,requestId,clientSentAt,userActionAt,regenerate});
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
      res.status(200);res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');res.flushHeaders?.();
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
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let clientClosed = false;
  let activeUpstreamController = null;
  res.on('close', () => { clientClosed = true; try { activeUpstreamController?.abort('client-disconnected'); } catch (_) {} });
  const emit = (event, data) => { if (!clientClosed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  emit('meta', { model:route.model, modelTier:route.tier, serviceTierRequested:route.provider==='cerebras'?CEREBRAS_SERVICE_TIER:OPENAI_SERVICE_TIER, routeReason:route.reason, phase:'retrieval', contextPrepared:!!prepared.session, embeddingMs:prepared.latency.embeddingMs, retrievalMs:prepared.latency.retrievalMs, promptReadyMs:prepared.latency.promptReadyMs, retrievalMode:prepared.latency.retrievalMode });

  if (prepared.rejection) {
    const latency = { ...prepared.latency, firstTokenMs:Date.now()-prepared.latency.startedAt, llmMs:0, totalMs:Date.now()-prepared.latency.startedAt, attempts:0 };
    emit('delta', { delta:prepared.rejection });
    emit('meta', { model:'local-guard', modelTier:'local', phase:'complete', latency, retrieved:[] });
    emit('done', { answer:prepared.rejection, model:'local-guard', modelTier:'local', latency });
    return res.end();
  }

  if (route.provider==='hybrid') {
    const llmStart=Date.now();
    const instructions=`${COPILOT_INSTRUCTIONS}\n\n${strictModeInstructions(prepared.responseType)}`;
    const maxTokens=answerTokenBudget(text,false,prepared.responseType);
    const cerebrasController=new AbortController();
    const solController=new AbortController();
    activeUpstreamController={abort:(reason)=>{try{cerebrasController.abort(reason)}catch(_){};try{solController.abort(reason)}catch(_){}}};
    let firstTokenMs=null;
    let provisional='';
    let finalAnswer='';
    let cerebrasError=null;
    let solError=null;
    let solServiceTier=OPENAI_SERVICE_TIER;

    const streamProvider=async(provider, controller, onDelta)=>{
      const body=provider==='cerebras'
        ? cerebrasChatBody({instructions,input:prepared.prompt,maxTokens,stream:true,effort:HYBRID_CEREBRAS_REASONING_EFFORT})
        : openAIResponseBody({model:LLM_DEFAULT_MODEL,instructions,input:prepared.prompt,effort:LLM_REASONING_EFFORT,maxTokens,verbosity:prepared.responseType==='spoken'?LLM_VERBOSITY:'medium',stream:true});
      const url=provider==='cerebras'?`${CEREBRAS_API_BASE}/chat/completions`:'https://api.openai.com/v1/responses';
      const key=provider==='cerebras'?CEREBRAS_API_KEY:OPENAI_API_KEY;
      const response=await fetch(url,{method:'POST',signal:controller.signal,headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body:JSON.stringify(body)});
      if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data?.error?.message||`${provider} request failed (${response.status})`)}
      const reader=response.body.getReader();
      const decoder=new TextDecoder();
      let buffer='';
      let complete='';
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        buffer+=decoder.decode(value,{stream:true});
        const blocks=buffer.split('\n\n');buffer=blocks.pop()||'';
        for(const block of blocks){
          const dataLines=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim());
          if(!dataLines.length)continue;
          const raw=dataLines.join('\n'); if(!raw||raw==='[DONE]')continue;
          let evt;try{evt=JSON.parse(raw)}catch(_){continue}
          const eventType=String(evt?.type||'');
          const delta=provider==='cerebras'?String(evt?.choices?.[0]?.delta?.content||''):(eventType==='response.output_text.delta'?String(evt?.delta||''):'');
          if(delta){complete+=delta;onDelta?.(delta)}
          if(provider==='openai'&&eventType==='response.completed'&&evt?.response?.service_tier)solServiceTier=String(evt.response.service_tier);
          if(eventType==='error'||evt?.error)throw new Error(evt?.error?.message||evt?.message||`${provider} stream error`);
          if(provider==='openai'&&eventType==='response.failed')throw new Error(evt?.response?.error?.message||'OpenAI response failed');
        }
      }
      return normalizeStructuredText(complete);
    };

    emit('meta',{model:`${CEREBRAS_MODEL} → ${LLM_DEFAULT_MODEL}`,modelTier:route.tier,phase:'hybrid-upgrade',status:'instant-draft'});
    const cerebrasPromise=streamProvider('cerebras',cerebrasController,(delta)=>{
      provisional+=delta;
      if(firstTokenMs===null)firstTokenMs=Date.now()-prepared.latency.startedAt;
      emit('delta',{delta});
    }).catch(err=>{cerebrasError=err;console.warn('[Hybrid] Cerebras provisional failed:',err.message);return ''});
    const solPromise=streamProvider('openai',solController,null).catch(err=>{solError=err;console.warn('[Hybrid] Sol upgrade failed:',err.message);return ''});

    try {
      emit('meta',{model:LLM_DEFAULT_MODEL,modelTier:route.tier,phase:'hybrid-upgrade',status:'sol-finalizing'});
      const timeout=new Promise(resolve=>setTimeout(()=>resolve('__HYBRID_TIMEOUT__'),HYBRID_SOL_UPGRADE_TIMEOUT_MS));
      const solResult=await Promise.race([solPromise,timeout]);
      if(solResult==='__HYBRID_TIMEOUT__'){
        try{solController.abort('hybrid-upgrade-timeout')}catch(_){}
        const cerebrasDone=await cerebrasPromise;
        finalAnswer=normalizeStructuredText(cerebrasDone||provisional||'');
      } else {
        finalAnswer=normalizeStructuredText(solResult||'');
        if(finalAnswer){try{cerebrasController.abort('sol-final-ready')}catch(_){}}
        else {
          const cerebrasDone=await cerebrasPromise;
          finalAnswer=normalizeStructuredText(cerebrasDone||provisional||'');
        }
      }
      if(finalAnswer && !solError && solResult!=='__HYBRID_TIMEOUT__'){
        const conformance=await ensureModeConformance({answer:finalAnswer,responseType:prepared.responseType,prompt:prepared.prompt,model:LLM_DEFAULT_MODEL,effort:LLM_REASONING_EFFORT,provider:'openai'});
        finalAnswer=conformance.answer;
      }
      if(!finalAnswer)throw (solError||cerebrasError||new Error('Both hybrid providers returned no answer'));
      const immutableFinal=normalizeStructuredText(provisional)||finalAnswer;
      if(firstTokenMs===null){firstTokenMs=Date.now()-prepared.latency.startedAt;emit('delta',{delta:immutableFinal})}
      if(!clientClosed&&prepared.session)addTurn(prepared.session,prepared.intentQuestion||text,immutableFinal,prepared.retrieved,prepared.responseType);
      const usedSol=!solError&&solResult!=='__HYBRID_TIMEOUT__'&&!!String(solResult||'').trim();
      const latency={embeddingMs:prepared.latency.embeddingMs,retrievalMs:prepared.latency.retrievalMs,retrievalMode:prepared.latency.retrievalMode,promptReadyMs:prepared.latency.promptReadyMs,firstTokenMs,llmMs:Date.now()-llmStart,totalMs:Date.now()-prepared.latency.startedAt,attempts:1};
      console.log(`[LLM hybrid] ${email} provisional=${CEREBRAS_MODEL} final=${usedSol?LLM_DEFAULT_MODEL:CEREBRAS_MODEL} first=${firstTokenMs??'-'}ms total=${latency.totalMs}ms`);
      emit('meta',{model:usedSol?LLM_DEFAULT_MODEL:CEREBRAS_MODEL,modelTier:route.tier,serviceTier:usedSol?solServiceTier:CEREBRAS_SERVICE_TIER,phase:'complete',latency,retrieved:prepared.retrieved.map(c=>({source:c.source,section:c.section,score:Number(c.score.toFixed(3))}))});
      emit('done',{answer:immutableFinal,model:usedSol?LLM_DEFAULT_MODEL:CEREBRAS_MODEL,modelTier:route.tier,serviceTier:usedSol?solServiceTier:CEREBRAS_SERVICE_TIER,latency});
    } catch(err) {
      console.error('[LLM hybrid] Error:',err.message);
      emit('error',{error:err.message||'Hybrid LLM stream failed'});
    } finally {
      try{cerebrasController.abort('hybrid-finished')}catch(_){};try{solController.abort('hybrid-finished')}catch(_){};
      return res.end();
    }
  }

  const llmStart = Date.now();
  let firstTokenMs = null;
  let answer = '';
  const immutableGate=createImmutableOpeningGate(delta=>emit('delta',{delta}));
  let streamAttempt = 0;
  let providerServiceTier = '';
  let providerRequestAtMs = null;
  let providerHeadersMs = null;
  let firstProviderDeltaAfterRequestMs = null;
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
        const cerebrasQuality = route.provider==='cerebras' ? `

CEREBRAS QUALITY CALIBRATION:
- Match the maturity, relevance and technical precision of a strong senior-engineer interview answer. Do not compensate for uncertainty with extra high-level architecture or invented implementation details.
- Current-question intent outranks prior-turn context. Answer only the scope actually asked.
- For experience questions, use first-person details only when RETRIEVED EVIDENCE supports them; otherwise keep the technical explanation generic and truthful.
- Prefer 1 direct answer plus 2-5 concise explanatory points over broad generic prose.
- Do not introduce technologies, patterns, metrics, files, pipelines or tools merely because they are plausible.
- For finite concept lists, be complete on the first response when practical.` : '';
        const instructions=`${COPILOT_INSTRUCTIONS}${cerebrasQuality}

${strictModeInstructions(prepared.responseType)}`;
        const maxTokens=answerTokenBudget(text,false,prepared.responseType);
        const streamBody=route.provider==='cerebras'
          ? cerebrasChatBody({instructions,input:prepared.prompt,maxTokens,stream:true,effort:route.effort})
          : route.provider==='gemini'
            ? geminiInteractionBody({instructions,input:prepared.prompt,maxTokens,stream:true})
            : openAIResponseBody({model:route.model,instructions,input:prepared.prompt,effort:route.effort,maxTokens,verbosity:prepared.responseType==='spoken'?LLM_VERBOSITY:'medium',stream:true});
        const upstreamUrl=route.provider==='cerebras'?`${CEREBRAS_API_BASE}/chat/completions`:route.provider==='gemini'?`${GEMINI_API_BASE}/interactions`:'https://api.openai.com/v1/responses';
        const upstreamKey=route.provider==='cerebras'?CEREBRAS_API_KEY:route.provider==='gemini'?GEMINI_API_KEY:OPENAI_API_KEY;
        if(!upstreamKey)throw new Error(route.provider==='cerebras'?'CEREBRAS_API_KEY missing on backend':route.provider==='gemini'?'GEMINI_API_KEY missing on backend':'OPENAI_API_KEY missing on backend');
        providerRequestAtMs = Date.now() - prepared.latency.startedAt;
        const providerFetchStartedAt = Date.now();
        upstream = await fetch(upstreamUrl, {
          method:'POST', signal:upstreamController.signal,
          headers:route.provider==='gemini'?{'content-type':'application/json','x-goog-api-key':upstreamKey}:{'content-type':'application/json', authorization:`Bearer ${upstreamKey}`},
          body:JSON.stringify(streamBody)
        });
        providerHeadersMs = Date.now() - providerFetchStartedAt;
        if (!upstream.ok) {
          clearTimeout(firstTokenTimer);
          const data = await upstream.json().catch(() => ({}));
          const upstreamError = new Error(data?.error?.message || `${route.provider==='cerebras'?'Cerebras':route.provider==='gemini'?'Gemini':'OpenAI'} request failed (${upstream.status})`);
          upstreamError.retryable = route.provider==='gemini' && [429,503].includes(upstream.status);
          throw upstreamError;
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
            const delta=route.provider==='cerebras'
              ? String(evt?.choices?.[0]?.delta?.content||'')
              : route.provider==='gemini'
                ? (String(evt?.event_type||'')==='step.delta' && evt?.delta?.type==='text' ? String(evt?.delta?.text||'') : '')
                : (eventType==='response.output_text.delta' ? String(evt?.delta||'') : '');
            if (delta) {
              if (firstTokenMs === null) {
                firstTokenMs = Date.now() - prepared.latency.startedAt;
                firstProviderDeltaAfterRequestMs = Date.now() - providerFetchStartedAt;
                clearTimeout(firstTokenTimer);
              }
              immutableGate.push(delta);
            }
            if (eventType==='error' || evt?.error) throw new Error(evt?.error?.message || evt?.message || `${route.provider==='cerebras'?'Cerebras':route.provider==='gemini'?'Gemini':'OpenAI'} stream error`);
            if (route.provider==='openai' && eventType==='response.completed' && evt?.response?.service_tier) providerServiceTier=String(evt.response.service_tier);
            if (route.provider==='openai' && eventType==='response.failed') throw new Error(evt?.response?.error?.message || 'OpenAI response failed');
          }
        }
        clearTimeout(firstTokenTimer);
        break;
      } catch (attemptErr) {
        clearTimeout(firstTokenTimer);
        const timedOut = upstreamController.signal.aborted && firstTokenMs === null;
        if ((timedOut || attemptErr?.retryable) && streamAttempt < 2) {
          if(attemptErr?.retryable) await new Promise(resolve=>setTimeout(resolve,750));
          console.warn(timedOut ? `[LLM stream] first-token timeout after ${firstTokenTimeoutMs}ms; retrying once` : '[LLM stream] Gemini temporary capacity/rate-limit response; retrying once');
          emit('meta', { model:route.model, modelTier:route.tier, phase:'retry', reason:timedOut?'provider first-token timeout':'Gemini temporary capacity/rate limit' });
          continue;
        }
        throw attemptErr;
      }
    }
    immutableGate.flush();
    answer=immutableGate.text();
    // Once a delta is visible, the wording is immutable for this turn. Do not run a
    // second-pass LLM formatter or send a replacement payload at completion.
    const conformance=await ensureModeConformance({answer,responseType:prepared.responseType,prompt:prepared.prompt,model:route.model,effort:route.effort,provider:route.provider,allowRepair:false});
    answer=conformance.answer;
    if (!clientClosed && prepared.session && answer) addTurn(prepared.session,hasImage?`[Captured window${captureSource?`: ${captureSource}`:''}] ${prepared.intentQuestion||text}`:prepared.intentQuestion||text,answer,prepared.retrieved,prepared.responseType);
    const latency = { ...prepared.latency, providerRequestAtMs, providerHeadersMs, firstProviderDeltaAfterRequestMs, firstTokenMs, llmMs:Date.now()-llmStart, totalMs:Date.now()-prepared.latency.startedAt, attempts:streamAttempt };
    providerServiceTier=providerServiceTier||(route.provider==='cerebras'?CEREBRAS_SERVICE_TIER:route.provider==='gemini'?'standard':OPENAI_SERVICE_TIER);
    console.log(`[PERF] ${email} model=${route.model} clickToBackend=${latency.userActionToBackendMs ?? '-'}ms clientToBackend=${latency.clientToBackendMs ?? '-'}ms intent=${latency.intentMs ?? '-'}ms retrieval=${latency.retrievalMs ?? '-'}ms mode=${latency.retrievalMode} prompt=${latency.promptBuildMs ?? '-'}ms promptChars=${latency.promptChars ?? '-'} providerHeaders=${latency.providerHeadersMs ?? '-'}ms providerFirstDelta=${latency.firstProviderDeltaAfterRequestMs ?? '-'}ms firstToken=${latency.firstTokenMs ?? '-'}ms total=${latency.totalMs ?? '-'}ms`);
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
