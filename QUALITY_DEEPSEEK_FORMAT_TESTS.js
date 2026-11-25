// Deterministic prompt tests for the DeepSeek spoken path (not live-model tests).
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(__dirname+'/backend/server.js','utf8');
const grab=(a,b)=>{const s=source.indexOf(a),e=source.indexOf(b,s);assert(s>=0&&e>s,'slice '+a);return source.slice(s,e);};
const ctx={};vm.createContext(ctx);
vm.runInContext(grab('function interviewTopic(','function activeInterviewSubject('),ctx);
vm.runInContext(grab('function deepseekSpokenInput(','function providerInterviewInput('),ctx);
const sys=ctx.providerInterviewInstructions('deepseek','spoken','How do you schedule the Lambda?','');
// ChatGPT-style format: labelled bullets, first person, no CV/JD talk, no denial of CV-listed tools
assert(sys.includes('- **Label:** one specific detail'));
assert(sys.includes('ANSWER THE LAYER ASKED')&&sys.includes('NEVER mention the CV, resume, JD'));
assert(sys.includes('never say "I haven\'t worked hands-on" about them'));
assert(!sys.includes('not five bullets by default')&&!sys.includes('headings, or final summary'));
assert(!sys.includes('not established in the CV and explain'));
// Cerebras/OpenAI routes are unchanged
assert(!ctx.providerInterviewInstructions('cerebras','spoken','q','').includes('DEEPSEEK ANSWER FORMAT'));
assert(!ctx.providerInterviewInstructions('deepseek','code','q','').includes('DEEPSEEK ANSWER FORMAT'));
const make=(q,prior=[],chunks=[])=>({correctedQuestion:q,session:{role:'Lead',yearsExperience:12,profile:{candidateSummary:'GenAI healthcare'},turns:prior.map(question=>({question})),chunks},retrieved:[{source:'resume',text:'RAG at Epic'},{source:'jd',text:'Dialogflow CX'}]});
const skills={source:'resume',text:'Cloud Platforms AWS (S3, SageMaker, Redshift, Kendra, Lambda), GCP, Azure'};
const env={source:'resume',text:'Environment: Python, Snowflake, Databricks, AWS (S3, Lambda)'};
const inp=ctx.deepseekSpokenInput(make('So what was the next scale? You landed it in s three. Snow pipe or stage?',['Orchestration tools for the pipeline?'],[skills,env]));
assert(inp.includes('S3')&&!/\bs three\b/i.test(inp)&&inp.includes('Snowpipe')&&inp.includes('next stage'));
assert(inp.includes('CV-LISTED TOOLS')&&inp.includes('AWS (S3, SageMaker, Redshift, Kendra, Lambda)')&&inp.includes('Environment: Python, Snowflake'));
assert(inp.includes('JD TARGET ONLY (not experience):\nDialogflow CX'));
assert(inp.includes('never mention the CV, resume or JD'));
// bounded size: prompt must not grow materially (latency guard)
assert(inp.length<9500,'input too large '+inp.length);
console.log('PASS: DeepSeek ChatGPT-style format, layer disambiguation, CV-listed tools, STT repairs, provider scope');
