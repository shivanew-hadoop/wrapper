const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(__dirname+'/backend/server.js','utf8');
const a=src.indexOf('function activeInterviewSubject('),b=src.indexOf('function cerebrasAnswerBudget(',a);
assert(a>0&&b>a);
const ctx=vm.createContext({});vm.runInContext(src.slice(a,b),ctx);
const resume='Workday Studio, EIB, Core Connectors, Workday Extend, REST APIs, SOAP, XML, XSLT, SFTP. CVS Health: Developed employee interfaces using Workday Studio.';
const chunks=[{source:'resume',text:resume},{source:'jd',text:'Strong hands-on Boomi, Python, C#, AWS, and SQL development required.'}];
const prompt='CANDIDATE PROFILE\nWorkday developer. Boomi preferred by JD.\n\nJOB ALIGNMENT\nBoomi, Python and AWS\n\nRETRIEVED EVIDENCE\n[R1 Resume] Workday Studio\n\nRECENT INTERVIEW CONTEXT\nNone\n\nUSER INSTRUCTIONS FOR THIS INTERVIEW SESSION\nShort, direct\n\nINPUT SOURCE\nvoice';
const prepared=q=>({intentQuestion:q,correctedQuestion:q,prompt,session:{chunks,turns:[]},followupInfo:{isFollowup:false}});
for(const provider of ['deepseek','cerebras']){
  for(const term of ['Boomi','Python','C#','AWS','SQL']){
    const text=ctx.providerInterviewInput(provider,prepared(`Have you worked with ${term} in production?`));
    assert(text.includes(`${term}: NOT ESTABLISHED in CV`),`${provider} must not claim ${term}`);
    assert(text.includes('ORIGINAL RESUME TEXT'),`${provider} experience requires CV`);
    assert(!text.includes('ORIGINAL RESUME TEXT (authoritative; JD is not evidence of past work):\n'+chunks[1].text));
  }
  const grounded=ctx.providerInterviewInput(provider,prepared('Have you worked with Workday Studio?'));
  assert(grounded.includes('Workday Studio'));
  assert(ctx.providerInterviewInput(provider,prepared('What is a REST API?')).includes('PERSONAL EXPERIENCE VERIFICATION'));
}
assert.equal(ctx.providerInterviewInput('openai',prepared('Have you worked with Boomi?')),prompt);
assert(src.includes('transient ${status} before first token; retrying once'));
assert(src.includes('transient network failure before first token; retrying once'));
assert(src.includes('streamAttempt<2'));
console.log('PASS: 10 unsupported-skill cases across both providers, CV evidence, Sol isolation, transient retry guards');
