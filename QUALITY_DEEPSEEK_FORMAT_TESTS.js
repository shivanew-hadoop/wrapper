// Deterministic prompt/routing tests for the DeepSeek + GPT-4o spoken path (not live-model tests).
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(__dirname+'/backend/server.js','utf8');
const grab=(a,b)=>{const s=source.indexOf(a),e=source.indexOf(b,s+a.length);assert(s>=0&&e>s,'slice '+a);return source.slice(s,e);};
const ctx={};vm.createContext(ctx);
vm.runInContext(grab('function normalizeText(','function fallbackProfile('),ctx);
vm.runInContext(grab('function isInterviewLogisticsQuestion(','\nfunction '),ctx);

// ---- v14.9.23 format kept, but bullets are "I" sentences with no headings, labels or bold
const sys=ctx.providerInterviewInstructions('deepseek','spoken','How does ingestion flow?','');
assert(sys.includes('follow with 4–6 bullets, each on its own line starting with "- I"'));
assert(sys.includes('never write a heading, a "Label:" prefix or bold text')&&sys.includes('No bold text, headings or section labels anywhere'));
assert(!sys.includes('**Label:**')&&!sys.includes('Bold only the bullet labels')&&!sys.includes('own bold label'));
assert(sys.includes('definition ("what is / what are")'));
assert(sys.includes('Lead with 1–2 lines that directly answer')&&sys.includes('Bulleted answers run about 70–130 words'));
// v23 grounding rules still present
assert(sys.includes('ANSWER THE LAYER ASKED')&&sys.includes('CV-LISTED TOOLS')&&sys.includes('NEVER mention the CV, resume, JD'));
// technology asked = technology answered
assert(sys.includes('TECHNOLOGY ASKED = TECHNOLOGY ANSWERED')&&sys.includes('never Salesforce SOQL unless the interviewer says SOQL or Salesforce'));
assert(sys.includes('implicit rate = implicit wait, joints = joins, optics in Salesforce = objects'));
// providers: GPT-4o identical to DeepSeek; Cerebras and non-spoken untouched
assert.strictEqual(ctx.providerInterviewInstructions('gpt4o','spoken','q',''),ctx.providerInterviewInstructions('deepseek','spoken','q',''));
assert(!ctx.providerInterviewInstructions('cerebras','spoken','q','').includes('DEEPSEEK ANSWER FORMAT'));
assert(!ctx.providerInterviewInstructions('deepseek','code','q','').includes('DEEPSEEK ANSWER FORMAT'));

// ---- transcript regressions: SQL is not SOQL
const sql=ctx.interviewTopic('What are joints in SQL?','');
assert(sql.startsWith('STANDARD SQL')&&sql.includes('Do NOT answer with SOQL'));
assert(ctx.interviewTopic('What are joins in SQL?','').startsWith('STANDARD SQL'));
assert(!ctx.interviewTopic('How do relationship queries work in SOQL joins?','').startsWith('STANDARD SQL'));
assert(!ctx.interviewTopic('SQL joins in Salesforce reports?','').startsWith('STANDARD SQL'));
// ---- mishearings are repaired before the model sees them
const make=(q,prior=[],chunks=[])=>({correctedQuestion:q,session:{role:'Automation Engineer',yearsExperience:6.8,profile:{candidateSummary:'Salesforce automation'},turns:prior.map(question=>({question,answer:'OLD ANSWER'})),chunks},retrieved:[{source:'resume',text:'Selenium Playwright Salesforce'},{source:'jd',text:'Automation'}]});
const latest=(q)=>ctx.deepseekSpokenInput(make(q)).split('\n\nRECENT')[0];
assert(latest('What are joints in SQL?').includes('joins in SQL')&&!/joints/.test(latest('What are joints in SQL?')));
assert(latest('Okay. What is implicit rate?').includes('implicit wait'));
assert(latest('What are optics in Salesforce?').includes('objects in Salesforce'));
assert(latest('What are profiles and roads?').includes('profiles and roles'));
assert(latest('What are objects in Salesforce?')==='LATEST INTERVIEWER SPEECH (answer only the substantive request):\nWhat are objects in Salesforce?');
assert(latest('Explain the road map for Salesforce')==='LATEST INTERVIEWER SPEECH (answer only the substantive request):\nExplain the road map for Salesforce');
// v23 input shape unchanged: questions only (no earlier answers), CV-listed tools, JD target only
const inp=ctx.deepseekSpokenInput(make('How do you handle waits?',['What is Selenium?'],[{source:'resume',text:'Environment: Java, Selenium, Playwright'}]));
assert(!inp.includes('OLD ANSWER')&&inp.includes('CV-LISTED TOOLS')&&inp.includes('Environment: Java, Selenium, Playwright'));
assert(inp.includes('JD TARGET ONLY (not experience):\nAutomation')&&inp.length<9000);

// ---- carried over, format-neutral: MCP optional, project status, acknowledgement guard
assert(ctx.interviewTopic('Do you think we can perform tool calling only MCP?','').includes('Start with "No"'));
assert(ctx.interviewTopic("this AI chatbot has been yet or it's in the production",'').includes('PROJECT STATUS'));
assert(!ctx.interviewTopic('How would you do a canary rollout for Terraform modules?','').includes('PROJECT STATUS'));
for(const a of ['ok','Okay.','Yeah, yeah.','Thank you','mhmm'])assert.strictEqual(ctx.isInterviewLogisticsQuestion(a),true,a);
for(const q of ['ok so how does state work','Do you use Playwright?'])assert.strictEqual(ctx.isInterviewLogisticsQuestion(q),false,q);

// ---- GPT-4o route: same messages/limits/streaming as DeepSeek, local retrieval, no extra calls
const rctx={DEEPSEEK_MODEL:'deepseek-chat',DEEPSEEK_API_KEY:'d',DEEPSEEK_API_BASE:'https://api.deepseek.com',CEREBRAS_API_BASE:'c',CEREBRAS_API_KEY:'c',CEREBRAS_MODEL:'c',CEREBRAS_SERVICE_TIER:'x',OPENAI_API_KEY:'o',OPENAI_SERVICE_TIER:'default',GPT4O_MODEL:'gpt-4o',fetch:()=>{}};
vm.createContext(rctx);vm.runInContext(grab('function deepseekChatBody(','async function embedTexts('),rctx);
const g=rctx.gpt4oChatBody({instructions:'I',input:'U',maxTokens:650,stream:true}),d=rctx.deepseekChatBody({instructions:'I',input:'U',maxTokens:650,stream:true});
assert.deepStrictEqual(g.messages,d.messages);assert.strictEqual(g.max_tokens,d.max_tokens);assert.strictEqual(g.stream,true);assert.strictEqual(g.model,'gpt-4o');
assert(!('reasoning_effort' in g)&&!('service_tier' in g)&&!('tools' in g));
assert.strictEqual(rctx.providerStreamUrl('gpt4o'),'https://api.openai.com/v1/chat/completions');
assert.strictEqual(rctx.providerApiKey('gpt4o'),'o');assert.strictEqual(rctx.isChatProvider('gpt4o'),true);
assert.strictEqual(rctx.providerStreamUrl('deepseek'),'https://api.deepseek.com/chat/completions');
assert(source.includes("if(selected==='gpt4o') return {provider:'gpt4o'"));
assert(fs.readFileSync(__dirname+'/setup/index.html','utf8').includes('<option value="gpt4o">'));

// ---- carried over: role from CV + JD
const cv1='Venkata Raja\nPROFESSIONAL EXPERIENCE:\nClient: Epic Systems Oct 2023 - Till now\nRole: Lead Data Scientist / AI-ML / GenAI Engineer / Agentic AI \nResponsibilities:\nBuilt RAG';
const jd1='Job Description\nConversational AI Data Engineer\n\nLooking for a hands-on and dynamic engineer who will work closely with client stakeholders.\n\nKey responsibilities\n* Configure Google CCAI';
assert.strictEqual(ctx.inferTargetRoleFromDocuments(cv1,jd1),'Lead GenAI Engineer');
assert.strictEqual(ctx.inferTargetRoleFromDocuments('TEJASWI\nFORWARD DEPLOYED AI ENGINEER | ENTERPRISE AI SOLUTIONS ARCHITECT\nTampa','Role: Forward-Deployed AI Engineer — Enterprise AI'),'Forward Deployed AI Engineer');
console.log('PASS: v23 format kept with I-bullets and no headings; SQL is not SOQL; mishearing repairs; GPT-4o parity; role; ack guard');
