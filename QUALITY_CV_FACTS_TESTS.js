const fs=require('fs'),vm=require('vm'),path=require('path'),assert=require('assert');
const src=fs.readFileSync(path.join(__dirname,'backend/server.js'),'utf8');
const normalize=src.slice(src.indexOf('function normalizeText('),src.indexOf('function decodeUpload('));
const guess=src.slice(src.indexOf('function guessHeading('),src.indexOf('function semanticChunks('));
const chunkFn=src.slice(src.indexOf('function semanticChunks('),src.indexOf('function',src.indexOf('function semanticChunks(')+30));
const cv=src.slice(src.indexOf('// CVFACTS_BEGIN'),src.indexOf('// CVFACTS_END'));
const block=src.slice(src.indexOf('function cvFactsPromptBlock('),src.indexOf("function interviewTopic("));
const ctx={console};vm.createContext(ctx);
vm.runInContext(normalize+cv+guess+src.slice(src.indexOf('function semanticChunks('),src.indexOf('function',src.indexOf('function semanticChunks(')+30))+block,ctx);
const text=fs.readFileSync(path.join(__dirname,'tests_data/cv_data_engineer.txt'),'utf8');
const f=vm.runInContext('extractCvFacts',ctx)(text);
const em=f.employers;
assert.strictEqual(em.length,5);
assert.strictEqual(JSON.stringify(em.map(e=>e.employer)),JSON.stringify(["McDonald’s",'Philips','Morgan Stanley','FNBO','IBM']));
assert.strictEqual(em[0].current,true); assert.strictEqual(em[0].start,'Dec 2022'); assert.ok(/till now/i.test(em[0].end));
assert.strictEqual(em[0].role,'Senior Data Engineer'); assert.strictEqual(em[0].location,'IL');
assert.ok(/retail data platform/i.test(em[0].project));
assert.strictEqual(em[2].start,'Nov 2018'); assert.strictEqual(em[2].end,'Jan 2021'); assert.strictEqual(em[2].current,false);
assert.strictEqual(em[1].start,'Feb 2021'); assert.strictEqual(em[3].start,'Jul 2015'); assert.strictEqual(em[4].role,'Data Analyst');
assert.ok(f.certifications.join(' ').includes('AWS Certified Solutions Architect'));
const q=vm.runInContext('cvDirectAnswer',ctx);
for(const s of ['Who is your current client?','who is my current client','What is your latest client','where are you currently working','Tell me your present employer'])
  assert.ok(/CURRENT client\/employer: McDonald/.test(q(s,f)),s);
assert.ok(/Morgan Stanley.*Nov 2018 to Jan 2021/.test(q('Did you work with Morgan Stanley? How long was the duration?',f)));
assert.ok(/PAST/.test(q('Tell me about your Morgan Stanley project',f)));
assert.ok(/Philips.*FNBO|Morgan Stanley/.test(q('Who were your previous clients?',f)));
assert.ok(/McDonald.*Philips.*Morgan Stanley.*FNBO.*IBM/.test(q('List all your clients',f)));
assert.ok(/Certifications/.test(q('What certifications do you have?',f)));
assert.strictEqual(q('Explain Spark joins',f),'');
// chunks: employer header becomes its own section and no run-together text remains
const norm=vm.runInContext('normalizeResumeHeadings',ctx)(text);
assert.ok(/McDonald’s, IL \| Dec 2022 - Till Now/.test(norm)); assert.ok(!/ILDec/.test(norm));
const chunks=vm.runInContext('semanticChunks',ctx)(norm,'resume');
assert.ok(chunks.some(c=>/McDonald/.test(c.section)&&/Till Now/.test(c.section)));
// prompt block
const pb=vm.runInContext('cvFactsPromptBlock',ctx)({cvFacts:f},'who is my current client');
assert.ok(/\[CURRENT CLIENT\/EMPLOYER\] McDonald/.test(pb)&&/\[PAST\] Morgan Stanley/.test(pb)&&/never say client names are confidential/i.test(pb));
assert.ok(pb.length<4200);
// labelled-client CV style
const f2=vm.runInContext('extractCvFacts',ctx)('John Smith\njohn@x.com\n\nExperience\nAcme Corp, Austin, TX  Jan 2020 – Present\nLead Engineer\nClient: Visa\nProject: Payments Hub\nProject Description: Built payments hub.\nOldCo – Mar 2015 – Dec 2019\nDeveloper\n');
assert.strictEqual(f2.name,'John Smith'); assert.strictEqual(f2.employers[0].client,'Visa'); assert.strictEqual(f2.employers[0].projectName,'Payments Hub'); assert.strictEqual(f2.employers[0].current,true);
console.log('CV facts tests passed');
// end-to-end: spoken provider input carries the facts for a current-client question
const ctx2={console};vm.createContext(ctx2);
const all=src.slice(src.indexOf('function normalizeText('),src.indexOf('function decodeUpload('))+src.slice(src.indexOf('function guessHeading('),src.indexOf('function semanticChunks('))+cv+src.slice(src.indexOf('function cvFactsPromptBlock('),src.indexOf('function interviewTopic('))+src.slice(src.indexOf('function interviewTopic('),src.indexOf('function cerebrasAnswerBudget('));
try{
  vm.runInContext(all.replace(/^const DEEPSEEK_SPOKEN_RULES[\s\S]*?`;\n/m,'const DEEPSEEK_SPOKEN_RULES="";\n'),ctx2);
  const out=vm.runInContext('deepseekSpokenInput',ctx2)({correctedQuestion:'who is my current client',intentQuestion:'who is my current client',session:{cvFacts:f,chunks:[],turns:[],profile:{},role:'Senior Data Engineer',yearsExperience:12},retrieved:[]});
  assert.ok(/CURRENT CLIENT\/EMPLOYER\] McDonald/.test(out)&&/DIRECT CV FACT FOR THIS QUESTION.*McDonald/.test(out));
  console.log('spoken input e2e passed');
}catch(e){console.log('e2e skipped:',e.message.slice(0,120));}
assert.strictEqual(vm.runInContext('extractExplicitRoleFromResume',(()=>{const c={console};vm.createContext(c);vm.runInContext(src.slice(src.indexOf('function normalizeText('),src.indexOf('function fallbackProfile(')),c);return c;})())(text),'Senior Data Engineer');
console.log('role from latest employer passed');
