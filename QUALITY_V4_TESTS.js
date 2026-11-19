const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(__dirname+'/Topper-v14.7.15-Memory-Bold/backend/server.js','utf8');
const start=src.indexOf('function interviewTopic('),end=src.indexOf('function cerebrasAnswerBudget(',start);
const ctx={copilotInstructions:()=> 'OPENAI ORIGINAL'};vm.createContext(ctx);vm.runInContext(src.slice(start,end),ctx);
const cases=[
 ['Two engineers execute data home simultaneously against same infrastructure; how prevent problems?', 'previous Terraform environments discussion', 'TERRAFORM CONCURRENCY'],
 ['Suppose you design a highly available AWS platform for millions of events per day. How ensure disaster recovery?', 'earlier Spark skew discussion','AWS HA/DR'],
 ['ISPAC job processes 500 GB daily in 30 minutes, now takes three hours. Investigate data skew.', '', 'SPARK PERFORMANCE'],
 ['Kubernetes pod CPU throttling and latency at peak traffic. How resolve?', '', 'KUBERNETES CPU'],
 ['How do you structure Terraform for dev stage and prod environments?', '', 'TERRAFORM ENVIRONMENTS'],
 ['How do you implement a Terraform pipe that validates changes before deploying production?', '', 'TERRAFORM CI/CD'],
 ['Give basic syntax for this cluster', 'previous EKS setup', 'EKS BASIC SYNTAX'],
 ['Department users must see only their records not sensitive customer fields', 'AWS security and least privilege previous interview question', 'AWS DEPARTMENT ACCESS'],
 ['Department users must see only their records in BigQuery', 'AWS security previous question', 'DEPARTMENT DATA ACCESS'],
 ['How do you implement least privilege across AWS infrastructure?', '', 'AWS GOVERNANCE'],
 ['Tell me a production issue incident you solved', '', 'PRODUCTION INCIDENT'],
 ['Our production pipeline intermittently fails and breaches SLA; how handle incident?', '', 'PRODUCTION INCIDENT'],
];
for(const [q,c,expected] of cases)assert(ctx.interviewTopic(q,c).startsWith(expected),`${q} expected ${expected}, got ${ctx.interviewTopic(q,c)}`);
for(const provider of ['cerebras','deepseek']){
  const prompt='CANDIDATE PROFILE\nSenior engineer\n\nJOB ALIGNMENT\nJD\n\nRETRIEVED EVIDENCE\nVerified resume\n\nRECENT INTERVIEW CONTEXT\nold Spark answer\n\nUSER INSTRUCTIONS FOR THIS INTERVIEW SESSION\nBe concise\n\nINPUT SOURCE\nSTT';
  const p={prompt,intentQuestion:'Terraform concurrent apply?',correctedQuestion:'Terraform concurrent apply?',followupInfo:{isFollowup:false}};
  const result=ctx.providerInterviewInput(provider,p);
  assert(!result.includes('old Spark answer'),`${provider} old answer contamination`);
  assert(result.includes('Verified resume'),`${provider} evidence missing`);
  assert(result.includes('Be concise'),`${provider} preferences missing`);
  assert(ctx.providerInterviewInstructions(provider,'spoken','Terraform state locking','').includes('LATEST complete interviewer request'));
  assert.strictEqual(ctx.providerInterviewInput('openai',p),prompt);
}
assert.strictEqual(ctx.providerInterviewInstructions('openai','spoken','q',''), 'OPENAI ORIGINAL');
console.log(`PASS ${cases.length} intent cases, both provider inputs, OpenAI isolation`);
