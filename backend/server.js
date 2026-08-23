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
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || 'gpt-5.6-terra').trim();
// v13.4 quality mode: every generative/vision/profile request uses the same Terra model.
// Embeddings remain on text-embedding-3-small because they are vector generation, not answer generation.
const LLM_DEFAULT_MODEL = OPENAI_MODEL;
const LLM_PROFILE_MODEL = OPENAI_MODEL;
const LLM_VISION_EXTRACT_MODEL = OPENAI_MODEL;
const LLM_ROUTING_ENABLED = false;
const LLM_REASONING_EFFORT = String(process.env.LLM_REASONING_EFFORT || 'low').trim();
const LLM_VERBOSITY = String(process.env.LLM_VERBOSITY || 'low').trim();
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
console.log('[BOOT] OPENAI_API_KEY present:', !!OPENAI_API_KEY);
console.log('[BOOT] LLM model: Terra-only ->', LLM_DEFAULT_MODEL, '| profile:', LLM_PROFILE_MODEL, '| vision-extract:', LLM_VISION_EXTRACT_MODEL, '| embedding:', EMBEDDING_MODEL, '| dims:', EMBEDDING_DIMENSIONS);

const app = express();
const allowedOrigin = String(process.env.CORS_ORIGIN || '').trim();
app.use(cors({ origin:(origin,cb) => cb(null,!origin || !allowedOrigin || origin === allowedOrigin) }));
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
    const data = await openAIJson('https://api.openai.com/v1/responses', {
      model:LLM_PROFILE_MODEL,
      instructions:'Create a compact interview-grounding profile. Return JSON only, no markdown. Never invent facts absent from the resume/JD.',
      input:`Years of experience: ${yearsExperience}\nTarget role: ${role || 'not specified'}\n\nRESUME:\n${resumeText.slice(0, 30000)}\n\nJOB DESCRIPTION:\n${jdText.slice(0, 24000)}\n\nReturn JSON with keys candidateSummary (max 1800 chars), jdSummary (max 1200 chars), primarySkills (array max 25), projectHighlights (array max 8), domainVocabulary (array max 60 of exact technology/product/framework/domain terms appearing in the resume or JD, preserving canonical spelling such as LangGraph, LangChain, Kubernetes), targetRole, yearsExperience.`,
      reasoning:{ effort:'none' }, text:{ verbosity:'low' }, max_output_tokens:900
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
  if (/\b(it|that|this|those|these|earlier|above|same|one example|another example|more detail|what about|how about|using|in java|in python|in c#|in c\+\+|show code|give code|show me|convert it|rewrite it|same in|do it in|instead|another one)\b/.test(q)) return true;
  // A clear standalone topic question should not be attached to the prior turn just because it is short.
  if (/^(what|who|why|when|where|which)\s+(is|are|was|were|do|does|did|can|could|should|would)\b/.test(q)) return false;
  if (/^(explain|define|describe|compare|differentiate|tell me about|difference between)\b/.test(q)) return false;
  // Very short fragments such as "why?", "how?", "example?" normally depend on the previous turn.
  return words.length <= 3;
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
function answerTokenBudget(question, hasImage=false) {
  const q = String(question || '');
  if (hasImage || /\b(code|implement|program|algorithm|debug|fix|design|architecture|system design)\b/i.test(q)) return 700;
  if (/\b(introduce yourself|tell me about yourself|self[- ]introduction)\b/i.test(q)) return 450;
  if (wantsExpandedAnswer(q)) return 500;
  return 260;
}

function buildPrompt(session, question, retrieved, followupInfo=null, correctedQuestion=question) {
  const profile = session.profile || {};
  const history = session.turns.slice(-MAX_HISTORY_TURNS).map((t,i) => `Turn ${i+1}\nInterviewer: ${t.question}\nCandidate: ${t.answer}`).join('\n\n');
  const evidence = retrieved.map((c,i) => `[${i+1}] ${c.source.toUpperCase()} · ${c.section}\n${c.text.slice(0, 900)}`).join('\n\n');
  const info = followupInfo || resolveFollowupIntent(session, question);
  const followup = info.isFollowup
    ? `YES. Treat the current words as a continuation/modifier of the immediately previous interviewer request. Resolved intent:\n${info.resolvedQuestion}`
    : 'NO';
  return `CANDIDATE PROFILE\nYears: ${session.yearsExperience}\nTarget role: ${session.role || profile.targetRole || 'Not specified'}\n${profile.candidateSummary || ''}\nPrimary skills: ${(profile.primarySkills || []).join(', ')}\nCanonical resume/JD vocabulary: ${(profile.domainVocabulary || profile.primarySkills || []).join(', ')}\n\nJOB ALIGNMENT\n${profile.jdSummary || ''}\n\nRETRIEVED EVIDENCE\n${evidence || 'No prepared evidence matched.'}\n\nRECENT INTERVIEW CONTEXT\n${history || 'No previous turns.'}\n\nCONTEXTUAL FOLLOW-UP\n${followup}\n\nCURRENT INTERVIEWER WORDS (canonical terminology already resolved where confidence is high)\n${correctedQuestion}\n\nDEPTH\n${wantsExpandedAnswer(question) ? 'Expanded answer requested.' : 'Default: concise spoken answer.'}`;
}
const COPILOT_INSTRUCTIONS = `You are the candidate speaking in a live senior/lead engineer interview. Return only one answer I should say aloud. Never mention AI, ChatGPT, copilot, prompts, retrieval, resume, CV, JD, transcription correction, evidence matching, or how you inferred the question. Never say "based on my CV/JD", "the resume confirms", "not listed", or similar meta commentary.

UNDERSTAND THE INTERVIEWER, NOT THE RAW TRANSCRIPT:
The input is noisy live speech. Remove repetitions, fillers and false starts such as "okay", "basically", "you know", duplicated words and incomplete lead-ins. Infer the final intended technical question from the complete current utterance plus recent interview turns. Silently repair phonetic technology names from the canonical Resume/JD vocabulary and surrounding topic. Never say "you mean", "not X", "I assume", or ask for confirmation when one interpretation is clearly supported by context.

Treat adjacent/continued interviewer fragments as one intent only when they are clearly related. If the current fragment completes the prior question, answer the combined question. If one captured utterance contains two or more unrelated questions/topics, treat the LAST complete question as the intentional current request and ignore the earlier unrelated question(s). Combine multiple questions only when the interviewer explicitly asks to answer both/all of them or they are clearly parts of one request. Pronouns/modifiers such as "it", "that", "this", "those", "same", "using Java", "give one example", "give me two", "the second one", "what about security", and "how does that flow work" inherit the immediately preceding topic. Preserve explicit constraints exactly: requested count, language, format, scenario, flow, comparison, code contract, or output.

ANSWER PRIORITY AND SHAPE:
1. Answer exactly the last complete interviewer intent. First sentence must contain the answer I need to say; no acknowledgement, restatement, definition-first preamble, or generic setup.
2. Match LENGTH to the question, not to the phrase 'in detailed way'. That phrase means technically accurate/specific, never verbose. For a narrow follow-up, challenge, correction, role/permission question, 'why', 'what privilege', 'do you need X?', yes/no validation, or one-fact question, give a GUNSHOT answer: usually 1-3 short sentences, around 2-4 display lines. For a normal experience question, use 3-5 concise spoken sentences. Use roughly 30-45 seconds only when the question genuinely needs an end-to-end explanation. For coding/pseudocode, give the requested design/code and only the implementation points needed to explain it.
3. Prefer one natural compact answer like an experienced engineer speaking. Do NOT force bullets, headings, mini-essays, or multiple sections. Use bullets only when the interviewer explicitly asks for a list/count or the answer cannot be spoken clearly without them.
4. Strictly answer the boundary asked. Do not volunteer adjacent implementation details just because they are present in Resume/JD/history. Never add Key Vault, token validation, metadata filters, security, audit, observability, architecture variants, or generic best practices unless they directly answer the current question. If asked why Contributor is needed, explain only the write operations that require it and contrast runtime Reader briefly; do not expand into unrelated management-plane design unless asked.
5. Preserve concrete values/examples from the interviewer. Example: if balance changes from 30,000 to 50,000 and failure occurs before commit, explicitly say the next read still returns 30,000.
6. Sound like a senior engineer speaking naturally: concise, confident, practical, first-person where appropriate, and immediately speakable. Avoid textbook wording and jargon that does not help answer the question.
7. Do not repeat a stock answer across questions. Adapt every answer to the current intent, retrieved Resume evidence, JD domain, years of experience, target role and recent conversation without exposing those sources.
8. Prefer current production approaches; use legacy approaches only when asked or when the supplied experience requires them.

EXPERIENCE CLAIMS:
Use first-person production language such as "I use", "I implemented", "I own", "I handle", "in production I..." only when Resume evidence supports that experience. JD-only evidence guides relevance but is not proof of implementation. If the asked technology has no credible Resume evidence, do not discuss resume matching. Say once, naturally and briefly, "I haven't used <technology> in production." Then give 3-5 practical high-level/POC points showing how I would approach it, without pretending production ownership.

SELF INTRODUCTION:
If asked for self-introduction/introduction/about yourself, produce one natural approximately 2-minute spoken introduction using the candidate's actual experience, strongest role-relevant projects/skills, production ownership and current target direction. Do not say it is aligned to the Resume/JD and do not list every skill. It must sound spoken, not like a profile summary.

SCENARIO / SECURITY / ARCHITECTURE QUESTIONS:
Only when the interviewer gives a TRUE hypothetical scenario/problem that requires design choices (for example: 'suppose...', 'design...', 'how would you handle this situation...'), start with 1-2 short, useful clarification questions I can ask before the solution. Do NOT treat an experience question ('what challenges did you face?'), a security/architecture topic by itself, a narrow follow-up, a challenge/correction, or a direct 'why' question as scenario-based. For those, answer immediately. For a true scenario, format the opening exactly for easy reading: start the first clarification with 'Can you please clarify on ' followed by the single most important clarification question. If a second clarification is genuinely useful, start it with 'Kindly confirm on ' followed by the confirmation question. Do not say 'I would clarify', 'I would ask', 'before I proceed', or similar narration. After those 1-2 questions, continue directly with the concise implementation solution using the best reasonable assumptions and relevant prior context.
Answer the boundary actually asked. Trace the real request/token/data flow point-to-point where relevant. If asked for N scenarios, give exactly N. Mention technologies such as MCP, direct API, OBO, managed identity, client credentials, RBAC, Key Vault, queues, caches, etc. only when they directly explain the requested scenario or are supported by context. Give the implementation choice and operational reason, not a textbook definition.

CODING QUESTIONS:
Start with the approach in 1-2 concise lines, then give the complete production-oriented solution requested. Add concise inline comments to every meaningful logical statement so I can explain the code line by line. Preserve the requested language, method/class signatures and constraints. A language-only follow-up must preserve the previous coding task exactly and rewrite that solution in the requested language. If captured code contains visible line numbers, reference those line numbers when explaining what to modify. For an edit/fix, identify the exact lines/blocks to replace or add; when a complete solution is required, provide the full runnable program and clearly identify the changed/new section. Mention complexity/edge cases only when useful to the problem.

FORMAT:
Return plain text only. Do not use Markdown bold/italic markers, headings, decorative formatting, emphasis markup, or colour-oriented formatting. For coding answers, fenced code blocks are allowed only when needed to preserve runnable code; otherwise keep presentation plain. Do not give two competing responses or alternatives unless explicitly asked. Do not force headings or bullets. Avoid generic transitions such as 'First', 'Second', 'Finally' unless sequence itself matters. Prefer concrete production nouns, exact roles/operations and the reason they were used. If the request is unclear, corrupted, unrelated to an interview, or cannot be answered reliably from the question and supplied context, say that briefly and ask for a clearer interview question; never invent missing facts. The final output must be accurate, brief, question-specific and immediately speakable in a real interview. Before returning, silently remove every sentence that does not directly help answer the exact current question.

CALIBRATION EXAMPLES:
Interviewer: "Do you need Contributor at runtime?" Candidate: "No. Runtime only needs the least-privileged data-plane role required for reads. Contributor is needed only for deployment or management operations that change resources."
Interviewer: "Have you used ToolX in production?" Candidate: "I haven't used ToolX in production. I understand its core pattern and would validate it first with a small POC covering integration, failure handling, security, and observability."
Interviewer: "asdf asdf asdf" Candidate: "I’m not sure what you’re asking. Please rephrase the question."`
function selectAnswerRoute(_question, _prepared=null, _options={}) {
  // One quality path only. No Luna/Sol routing and no classifier/model-selection API call.
  return { model:LLM_DEFAULT_MODEL, effort:LLM_REASONING_EFFORT, tier:'terra', reason:'terra-only' };
}
function addTurn(session, question, answer, retrieved=[]) {
  session.turns.push({ question:normalizeText(question).slice(0,2000), answer:normalizeText(answer).slice(0,5000), retrieved:retrieved.slice(0, TOP_K).map(c => ({source:c.source, section:c.section, text:c.text, score:c.score})), at:Date.now() });
  if (session.turns.length > MAX_HISTORY_TURNS) session.turns = session.turns.slice(-MAX_HISTORY_TURNS);
}
async function prepareQuestion(email, question) {
  const startedAt = Date.now();
  const session = interviewSessions.get(email);
  const rejection = rejectLowConfidenceInput(question);
  let retrieved = [];
  let embeddingMs = 0, retrievalMs = 0;
  let retrievalMode = 'none';
  const canonical = session ? resolveCanonicalQuestion(session, question) : { corrected:question, replacements:[] };
  const correctedQuestion = canonical.corrected || question;
  const followupInfo = session ? resolveFollowupIntent(session, correctedQuestion) : { isFollowup:false, resolvedQuestion:correctedQuestion, previous:null };

  if (!rejection && session?.chunks?.length) {
    const previous = followupInfo.previous;
    const retrievalBase = followupInfo.isFollowup ? followupInfo.resolvedQuestion : correctedQuestion;
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
  const prompt = session ? buildPrompt(session, question, retrieved, followupInfo, correctedQuestion) : `INTERVIEWER QUESTION\n${question}\n\nDEPTH\n${wantsExpandedAnswer(question) ? 'Expanded answer requested.' : 'Default: concise spoken answer.'}`;
  return { session, prompt, retrieved, rejection, followupInfo, correctedQuestion, canonicalReplacements:canonical.replacements, latency:{ startedAt, embeddingMs, retrievalMs, retrievalMode, promptReadyMs:Date.now()-startedAt } };
}
app.get('/', (_req, res) => res.json({ ok:true, service:'Topper Backend', stt:'/stt', llm:'/ask', llmStream:'/ask/stream', prepare:'/prepare-context', llmModel:LLM_DEFAULT_MODEL, llmRouting:{enabled:false,mode:'terra-only',default:LLM_DEFAULT_MODEL}, embeddingModel:EMBEDDING_MODEL }));
app.get('/health', (_req, res) => res.json({ ok:true }));

app.post('/validate-license', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ ok:false, reason:'email required' });
  const result = isLicenseValid(email);
  return res.status(result.ok ? 200 : 401).json(result);
});

app.post('/prepare-context', async (req, res) => {
  const email = requireLicensedRequest(req, res); if (!email) return;
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
  const text = normalizeText(req.body.text || '');
  if (!email || !text) return res.status(400).json({ ok:false, error:'email and text are required' });
  const license = isLicenseValid(email); if (!license.ok) return res.status(401).json({ ok:false, error:license.reason || 'Invalid license' });
  if (!OPENAI_API_KEY) return res.status(500).json({ ok:false, error:'OPENAI_API_KEY missing on backend' });
  if (text.length > 12000) return res.status(400).json({ ok:false, error:'Transcript input too long' });
  try {
    const prepared = await prepareQuestion(email, text);
    if (prepared.rejection) return res.json({ ok:true, answer:prepared.rejection, model:'local-guard', modelTier:'local', contextPrepared:!!prepared.session, retrieved:[], latency:{...prepared.latency, llmMs:0, totalMs:Date.now()-prepared.latency.startedAt} });
    const route = selectAnswerRoute(text, prepared);
    const llmStart = Date.now();
    const data = await openAIJson('https://api.openai.com/v1/responses', {
      model:route.model, instructions:COPILOT_INSTRUCTIONS, input:prepared.prompt,
      reasoning:{ effort:route.effort }, text:{ verbosity:LLM_VERBOSITY }, max_output_tokens:answerTokenBudget(text)
    });
    const answer = outputText(data);
    if (prepared.session && answer) addTurn(prepared.session, text, answer, prepared.retrieved);
    const latency = { embeddingMs:prepared.latency.embeddingMs, retrievalMs:prepared.latency.retrievalMs, retrievalMode:prepared.latency.retrievalMode, promptReadyMs:prepared.latency.promptReadyMs, llmMs:Date.now()-llmStart, totalMs:Date.now()-prepared.latency.startedAt };
    console.log(`[LLM] ${email} model=${route.model} tier=${route.tier} total=${latency.totalMs}ms embed=${latency.embeddingMs}ms retrieve=${latency.retrievalMs}ms mode=${prepared.latency.retrievalMode} llm=${latency.llmMs}ms`);
    return res.json({ ok:true, answer, model:route.model, modelTier:route.tier, contextPrepared:!!prepared.session, retrieved:prepared.retrieved.map(c => ({source:c.source, section:c.section, score:Number(c.score.toFixed(3))})), latency });
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
  const instruction = normalizeText(`${text || 'Analyze and solve the captured screen.'}\n\nCAPTURE CONTEXT\n${captureSource ? `Window: ${captureSource}\n` : ''}${context ? `${context}\n` : ''}Rules for screen/code tasks:\n- Read the screenshot directly; do not ask me to transcribe visible code or question text.\n- Identify the exact task before answering.\n- For coding problems, provide a complete runnable solution in the language visible in the screenshot unless the screenshot explicitly asks for another language.\n- Preserve method/class signatures shown in the screenshot when they are part of the problem contract.\n- Cover edge cases and complexity briefly when relevant.\n- Add concise inline comments to meaningful code statements so the solution can be explained in an interview.\n- If the screenshot contains an error, diagnose the actual failing line/behavior and provide the corrected code.\n- Keep the answer practical, concise, and directly usable.`);
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
  const extractionRules = `Extract the useful visible content from this screenshot so it can be used as the next interview prompt. Return ONLY the extracted/normalized prompt text, no analysis and no markdown fences.\n- This can be code, a coding problem, architecture diagram text, error, technical question, meeting/chat text, requirements, or any other interview-relevant content.\n- Preserve code exactly enough to solve it, including identifiers, method/class signatures, error text and visible line numbers when present.\n- Preserve explicit constraints and requested output.\n- Ignore Topper UI text, browser chrome, taskbar, notifications and unrelated navigation.\n- If this is a continuation of earlier captured content, keep only what is visible now; the desktop app will append multiple captures.\n- Do not answer the content. Extract it only.\nRecent interview context for disambiguation only:\n${recent}`;
  try {
    const r = await fetch('https://api.openai.com/v1/responses', {method:'POST', headers:{'authorization':`Bearer ${OPENAI_API_KEY}`,'content-type':'application/json'}, body:JSON.stringify({model:LLM_VISION_EXTRACT_MODEL, instructions:extractionRules, input:[{role:'user',content:[{type:'input_text',text:'Extract the screen content.'},{type:'input_image',image_url:imageDataUrl,detail:'high'}]}], reasoning:{effort:'none'}, text:{verbosity:'low'}, max_output_tokens:1600})});
    const data = await r.json().catch(()=>({}));
    if (!r.ok) return res.status(r.status).json({ok:false,error:data?.error?.message || `Vision extraction failed (${r.status})`});
    const text = outputText(data).trim();
    return res.json({ok:true,text,captureMs:Date.now()-startedAt});
  } catch (err) { return res.status(502).json({ok:false,error:err.message || 'Vision extraction failed'}); }
});

app.post('/ask/stream', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const text = normalizeText(req.body.text || '');
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
      prepared = {
        session,
        prompt:buildVisionInput(text, imageDataUrl, session, captureSource),
        retrieved:[],
        latency:{ startedAt, embeddingMs:0, retrievalMs:0, retrievalMode:'vision-direct', promptReadyMs:Date.now()-startedAt }
      };
    } else {
      prepared = await prepareQuestion(email, text);
    }
  } catch (err) { return res.status(502).json({ ok:false, error:err.message || 'Retrieval failed' }); }

  const route = selectAnswerRoute(text, prepared, { hasImage });

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  let clientClosed = false;
  let activeUpstreamController = null;
  res.on('close', () => { clientClosed = true; try { activeUpstreamController?.abort('client-disconnected'); } catch (_) {} });
  const emit = (event, data) => { if (!clientClosed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  emit('meta', { model:route.model, modelTier:route.tier, routeReason:route.reason, phase:'retrieval', contextPrepared:!!prepared.session, embeddingMs:prepared.latency.embeddingMs, retrievalMs:prepared.latency.retrievalMs, promptReadyMs:prepared.latency.promptReadyMs, retrievalMode:prepared.latency.retrievalMode });

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
        upstream = await fetch('https://api.openai.com/v1/responses', {
          method:'POST', signal:upstreamController.signal,
          headers:{'content-type':'application/json', authorization:`Bearer ${OPENAI_API_KEY}`},
          body:JSON.stringify({ model:route.model, instructions:COPILOT_INSTRUCTIONS, input:prepared.prompt, reasoning:{effort:route.effort}, text:{verbosity:LLM_VERBOSITY}, max_output_tokens:answerTokenBudget(text, hasImage), stream:true })
        });
        if (!upstream.ok) {
          clearTimeout(firstTokenTimer);
          const data = await upstream.json().catch(() => ({}));
          throw new Error(data?.error?.message || `OpenAI request failed (${upstream.status})`);
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
            if (evt.type === 'response.output_text.delta' && evt.delta) {
              if (firstTokenMs === null) {
                firstTokenMs = Date.now() - prepared.latency.startedAt;
                clearTimeout(firstTokenTimer);
              }
              answer += evt.delta;
              emit('delta', { delta:evt.delta });
            } else if (evt.type === 'error') {
              throw new Error(evt.error?.message || evt.message || 'OpenAI stream error');
            }
          }
        }
        clearTimeout(firstTokenTimer);
        break;
      } catch (attemptErr) {
        clearTimeout(firstTokenTimer);
        const timedOut = upstreamController.signal.aborted && firstTokenMs === null;
        if (timedOut && streamAttempt < 2) {
          console.warn(`[LLM stream] first-token timeout after ${firstTokenTimeoutMs}ms; retrying once`);
          emit('meta', { model:route.model, modelTier:route.tier, phase:'retry', reason:'provider first-token timeout' });
          continue;
        }
        throw attemptErr;
      }
    }
    answer = normalizeText(answer);
    if (!clientClosed && prepared.session && answer) addTurn(prepared.session, hasImage ? `[Captured window${captureSource ? `: ${captureSource}` : ''}] ${text}` : text, answer, prepared.retrieved);
    const latency = { embeddingMs:prepared.latency.embeddingMs, retrievalMs:prepared.latency.retrievalMs, retrievalMode:prepared.latency.retrievalMode, promptReadyMs:prepared.latency.promptReadyMs, firstTokenMs, llmMs:Date.now()-llmStart, totalMs:Date.now()-prepared.latency.startedAt, attempts:streamAttempt };
    console.log(`[LLM stream] ${email} model=${route.model} tier=${route.tier} first=${firstTokenMs ?? '-'}ms total=${latency.totalMs}ms embed=${latency.embeddingMs}ms retrieve=${latency.retrievalMs}ms mode=${prepared.latency.retrievalMode} attempts=${streamAttempt}`);
    emit('meta', { model:route.model, modelTier:route.tier, phase:'complete', latency, retrieved:prepared.retrieved.map(c => ({source:c.source, section:c.section, score:Number(c.score.toFixed(3))})) });
    emit('done', { answer, model:route.model, modelTier:route.tier, latency });
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
