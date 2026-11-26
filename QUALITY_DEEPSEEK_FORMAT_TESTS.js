// Deterministic prompt/routing tests for the DeepSeek + GPT-4o spoken path (not live-model tests).
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(__dirname+'/backend/server.js','utf8');
const grab=(a,b)=>{const s=source.indexOf(a),e=source.indexOf(b,s+a.length);assert(s>=0&&e>s,'slice '+a);return source.slice(s,e);};
const ctx={};vm.createContext(ctx);
vm.runInContext(grab('function normalizeText(','function fallbackProfile('),ctx);
vm.runInContext(grab('function isInterviewLogisticsQuestion(','\nfunction ',),ctx);

// ---- format: plain by default, bullets only for real multi-part answers, plain words + real terms
const sys=ctx.providerInterviewInstructions('deepseek','spoken','How does state work?','');
assert(sys.includes('DEFAULT is 3–5 short spoken lines with NO bullets and NO headings'));
assert(sys.includes('Yes/no, status, opinion, behavioural, introduction and wrap-up answers are plain lines, never bullets or labels'));
assert(sys.includes('PLAIN WORDS, REAL TERMS')&&sys.includes('bind_tools()')&&sys.includes('interrupt()'));
assert(sys.includes('No stock closing "I validate by..." line'));
assert(sys.includes('STAY CONSISTENT')&&sys.includes('never state'.slice(0,0)+'Facts the resume does not state'));
assert(sys.includes('never say "I haven\'t worked hands-on" about those')&&sys.includes('NEVER mention the CV, resume, JD'));
assert(!sys.includes('not five bullets by default')&&!sys.includes('not established in the CV and explain'));
// GPT-4o gets exactly the same instructions as DeepSeek; Cerebras and code mode are untouched
assert.strictEqual(ctx.providerInterviewInstructions('gpt4o','spoken','q',''),ctx.providerInterviewInstructions('deepseek','spoken','q',''));
assert(!ctx.providerInterviewInstructions('cerebras','spoken','q','').includes('DEEPSEEK ANSWER FORMAT'));
assert(!ctx.providerInterviewInstructions('deepseek','code','q','').includes('DEEPSEEK ANSWER FORMAT'));

// ---- transcript regressions: MCP optional, project status, no invented rollout
const mcp=ctx.interviewTopic('Do you think we can perform tool calling only MCP?','');
assert(mcp.includes('TOOL CALLING vs MCP')&&mcp.includes('Start with "No"')&&mcp.includes('bind_tools()'));
assert(ctx.interviewTopic('How do I call a tool with LangChain?','')==='');
const status=ctx.interviewTopic("So this AI chatbot has been yet or it's in the production",'');
assert(status.includes('PROJECT STATUS')&&status.includes('Do not say "it is live" or "it is a pilot"'));
assert(ctx.interviewTopic('Deployment phase yet. What is the number of anticipated users','').includes('PROJECT STATUS'));
assert(!ctx.interviewTopic('How would you do a canary rollout for Terraform modules?','').includes('PROJECT STATUS'));

// ---- acknowledgement-only speech needs no answer (no model call); real questions still do
for(const a of ['ok','Okay.','Yeah, yeah.','Thank you','mhmm','Got it, thanks'])assert.strictEqual(ctx.isInterviewLogisticsQuestion(a),true,a);
for(const q of ['ok so how does state work','Do you use LangGraph?','thanks, now walk me through the RAG flow'])assert.strictEqual(ctx.isInterviewLogisticsQuestion(q),false,q);

// ---- input: earlier answers kept for consistency, screen + speech kept apart, STT repairs, CV-listed tools
const make=(q,prior=[],chunks=[])=>({correctedQuestion:q,session:{role:'Forward Deployed AI Engineer',yearsExperience:6,profile:{candidateSummary:'agentic AI banking'},turns:prior.map(([question,answer])=>({question,answer})),chunks},retrieved:[{source:'resume',text:'LangGraph agents'},{source:'jd',text:'Forward-deployed'}]});
const skills={source:'resume',text:'Cloud Platforms AWS (S3, Lambda), Azure'},env={source:'resume',text:'Environment: Python, FastAPI, LangGraph'};
const two=ctx.deepseekSpokenInput(make('Deployment phase yet. Number of anticipated users?',[['Is it in production?','It was built for production use with CI quality gates and tracing.']],[skills,env]));
assert(two.includes('EARLIER ANSWERS ALREADY GIVEN')&&two.includes('built for production use with CI quality gates'));
assert(two.indexOf('LATEST INTERVIEWER SPEECH')===0&&two.includes('CV-LISTED TOOLS')&&two.includes('Environment: Python, FastAPI, LangGraph'));
assert(two.includes('JD TARGET ONLY (not experience):\nForward-deployed'));
const merged=ctx.deepseekSpokenInput(make('--- SCREEN CAPTURE 1 ---\nDefine a class Bird with image and fact\n\n--- SPOKEN QUESTION / FOLLOW-UP ---\nYou have less than eight years. How do you prioritize two competing tasks?'));
assert(merged.startsWith('LATEST INTERVIEWER SPEECH (answer only the substantive request):\nYou have less than eight years.'));
assert(merged.includes('SCREEN CAPTURE (a separate problem on screen; solve it only if the speech asks, otherwise ignore it):\n--- SCREEN CAPTURE 1 ---\nDefine a class Bird'));
const stt=ctx.deepseekSpokenInput(make('You landed it in s three. Snow pipe or stage? next scale?'));
assert(stt.includes('S3')&&stt.includes('Snowpipe')&&stt.includes('next stage'));
assert(two.length<9800,'prompt too large '+two.length);

// ---- GPT-4o route: same messages/limits/streaming as DeepSeek, local retrieval, no extra calls
const rctx={DEEPSEEK_MODEL:'deepseek-chat',DEEPSEEK_API_KEY:'d',DEEPSEEK_API_BASE:'https://api.deepseek.com',CEREBRAS_API_BASE:'c',CEREBRAS_API_KEY:'c',CEREBRAS_MODEL:'c',CEREBRAS_SERVICE_TIER:'x',OPENAI_API_KEY:'o',OPENAI_SERVICE_TIER:'default',GPT4O_MODEL:'gpt-4o',fetch:()=>{}};
vm.createContext(rctx);vm.runInContext(grab('function deepseekChatBody(','async function embedTexts('),rctx);
const g=rctx.gpt4oChatBody({instructions:'I',input:'U',maxTokens:650,stream:true}),d=rctx.deepseekChatBody({instructions:'I',input:'U',maxTokens:650,stream:true});
assert.deepStrictEqual(g.messages,d.messages);assert.strictEqual(g.max_tokens,d.max_tokens);assert.strictEqual(g.stream,true);assert.strictEqual(g.model,'gpt-4o');
assert(!('reasoning_effort' in g)&&!('service_tier' in g)&&!('tools' in g));
assert(!('max_tokens' in rctx.gpt4oChatBody({instructions:'I',input:'U',maxTokens:null})));
assert.strictEqual(rctx.providerStreamUrl('gpt4o'),'https://api.openai.com/v1/chat/completions');
assert.strictEqual(rctx.providerApiKey('gpt4o'),'o');assert.strictEqual(rctx.isChatProvider('gpt4o'),true);assert.strictEqual(rctx.providerServiceTierFor('gpt4o'),'standard');
assert.strictEqual(rctx.providerStreamUrl('deepseek'),'https://api.deepseek.com/chat/completions');
assert(source.includes("if(selected==='gpt4o') return {provider:'gpt4o'"));
assert(source.includes("['openai','terra','luna','cerebras','deepseek','gpt4o'].includes(requestedProvider)"));
assert(fs.readFileSync(__dirname+'/setup/index.html','utf8').includes('<option value="gpt4o">'));
assert((fs.readFileSync(__dirname+'/main.js','utf8').match(/'deepseek','gpt4o'/g)||[]).length===2);

// ---- role from CV + JD (previously "Lead" and "AI ENGINEER")
const cv1='Venkata Raja\nPROFESSIONAL EXPERIENCE:\nClient: Epic Systems Oct 2023 - Till now\nRole: Lead Data Scientist / AI-ML / GenAI Engineer / Agentic AI \nResponsibilities:\nBuilt RAG';
const jd1='Job Description\nConversational AI Data Engineer\n\nLooking for a hands-on and dynamic engineer who will work closely with client stakeholders.\n\nKey responsibilities\n* Configure Google CCAI';
assert.strictEqual(ctx.inferTargetRoleFromDocuments(cv1,jd1),'Lead GenAI Engineer');
assert.strictEqual(ctx.extractExplicitRoleFromJD(jd1),'Conversational AI Data Engineer');
const cv2='TEJASWI\nFORWARD DEPLOYED AI ENGINEER | ENTERPRISE AI SOLUTIONS ARCHITECT\nTampa, FL\nPROFESSIONAL SUMMARY\nForward Deployed AI Engineer with 6+ years';
const jd2='Role: Forward-Deployed AI Engineer — Enterprise AI\nLocation: New York City\nExperience Level: 8+ years';
assert.strictEqual(ctx.inferTargetRoleFromDocuments(cv2,jd2),'Forward Deployed AI Engineer');
assert.strictEqual(ctx.extractExplicitRoleFromJD(jd2),'Forward-Deployed AI Engineer');
assert.strictEqual(ctx.inferTargetRoleFromDocuments('Name\nSkills: Java','Role: Senior QA Automation Engineer'),'Senior QA Automation Engineer');
console.log('PASS: plain-by-default format, real terms, consistency memory, MCP/status checks, ack guard, screen split, GPT-4o parity, CV+JD role');
