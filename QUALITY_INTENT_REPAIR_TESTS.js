// Deterministic tests for local speech-intent repair (no model call). Phrases come from real Topper transcripts.
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(__dirname+'/backend/server.js','utf8');
const a=src.indexOf('function normalizeText('),b=src.indexOf('function fallbackProfile(');
const c={};vm.createContext(c);vm.runInContext(src.slice(a,b),c);
const skills=['Playwright','Selenium','Java','TestNG','Cucumber','Salesforce','SOQL','Postman','Jenkins','GitHub','Jira','Lightning','regression','defects','sandbox'];
const sess=(turns=[])=>({profile:{primarySkills:skills,domainVocabulary:skills},turns:turns.map(question=>({question}))});
const fix=(q,prior)=>c.resolveCanonicalQuestion(sess(prior||[]),q).corrected;
// the four reported cases plus the defect life cycle
assert(/explain defect life cycle\?/.test(fix('Okay. Can I explain difficult life cycle?')));
assert(fix('Yeah. Okay. Name name the order period level access levels. How').includes('object, field and record level access levels'));
assert(fix('Okay. What I look up on master retail relationships?').includes('What is the difference between lookup and master-detail relationships?'));
assert(fix('Okay. What is record on security?').includes('What is record level security?'));
assert(fix('What is object cloud security?').includes('What is object level security?'));
// technology names split or misheard by STT
assert(fix('hands on experience working on PlayRate').includes('working on Playwright'));
assert(fix('Manual user case in the post mail. What is authorization?').includes('in the Postman.'));
const m=fix('We use test ng and play right with sand box and git hub actions');
assert(m.includes('TestNG')&&m.includes('Playwright')&&/sandbox/i.test(m)&&m.includes('GitHub'));
assert(fix('What is a smoking test?').includes('smoke test?')&&fix('What is a digression testing?').includes('regression testing'));
assert(fix('Okay. What is implicit rate?').includes('implicit wait')&&fix('What are profiles and roads?').includes('profiles and roles'));
assert(fix('What is junction object or function objects in Salesforce').includes('junction object or junction objects'));
// must NOT change: cloud-provider context, ordinary English, correct terms
for(const [q,prior] of [['What is object storage security in S3?'],['Explain object cloud security for my S3 bucket',['How do I secure AWS S3 buckets?']],['That was a difficult question about life'],['What is the page object model?'],['What is record level security?'],['We use the post office API']])assert.strictEqual(fix(q,prior),q,q);
// context gates: no Salesforce or QA context in the CV/JD => no Salesforce/QA repairs
const bare={profile:{primarySkills:['Python','Spark'],domainVocabulary:['Python','Spark']},turns:[]};
assert.strictEqual(c.resolveCanonicalQuestion(bare,'What is a function object?').corrected,'What is a function object?');
assert.strictEqual(c.resolveCanonicalQuestion(bare,'What is a smoking test?').corrected,'What is a smoking test?');
// repaired words are not re-mangled by the vocabulary fuzzy-match
assert(!/objects level|defects life/.test(fix('Okay. What is record on security?')+fix('Can I explain difficult life cycle?')));
// the model is told what was repaired (heard -> intended); unchanged when nothing was repaired
const rep=c.resolveCanonicalQuestion(sess(),'Okay. What is record on security?');
const prepared={correctedQuestion:rep.corrected,canonicalReplacements:rep.replacements,session:{role:'Automation Engineer',yearsExperience:6.8,profile:{candidateSummary:'QA'},turns:[],chunks:[]},retrieved:[]};
const inp=c.deepseekSpokenInput(prepared);
assert(inp.startsWith('LATEST INTERVIEWER SPEECH (answer only the substantive request):\nOkay. What is record level security?\n(Speech repairs already applied, heard -> intended; answer the intended wording: record on security -> record level security)'));
assert(!c.deepseekSpokenInput({...prepared,canonicalReplacements:[]}).includes('Speech repairs already applied'));
// commands/statements guidance added without changing the format rules
const sys=c.providerInterviewInstructions('deepseek','spoken','q','');
assert(sys.includes('put the exact command, statement, API call, setting or short code in backticks')&&sys.includes('COMMANDS STAY ON TOPIC'));
assert(sys.includes('never write a heading, a "Label:" prefix or bold text')&&sys.includes('starting with "- I"'));
assert(c.providerInterviewInstructions('gpt4o','spoken','q','')===sys);
console.log('PASS: intent repair (reported phrases, split tech terms, context gates, no false positives), repair hint, on-topic commands rule');
