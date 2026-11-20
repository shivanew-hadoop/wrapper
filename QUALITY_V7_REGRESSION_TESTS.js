const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(__dirname+'/backend/server.js','utf8');
const a=src.indexOf('function activeInterviewSubject('),b=src.indexOf('function cerebrasAnswerBudget(',a);
assert(a>0&&b>a);
const ctx=vm.createContext({});
vm.runInContext(src.slice(a,b).replace('function providerInterviewInput(provider,prepared) {','function providerInterviewInput(provider,prepared) {'),ctx);
const turns=[{question:'How are Azure DevOps and the Azure tenant linked using a service connection?',answer:'I create an ARM service connection.'}];
function prepared(q){return {intentQuestion:q,correctedQuestion:q,session:{turns},followupInfo:{isFollowup:true,resolvedQuestion:q},prompt:'CANDIDATE PROFILE\nAzure Engineer\n\nJOB ALIGNMENT\nAzure\n\nRETRIEVED EVIDENCE\nNo prepared evidence matched.\n\nRECENT INTERVIEW CONTEXT\nContext\n\nUSER INSTRUCTIONS FOR THIS INTERVIEW SESSION\nShort answers\n\nINPUT SOURCE\nvoice'};}
const input=ctx.providerInterviewInput('deepseek',prepared('What is inside the service connection?'));
assert(input.includes('NOT ServiceNow'));assert(input.includes('AZURE DEVOPS ARM SERVICE CONNECTION'));assert(input.includes('NEW LINE'));
assert(!ctx.isGenuineYesNoQuestion('How do you route outbound traffic through the NVA?'));
assert(ctx.isGenuineYesNoQuestion('Can you attach WAF to Azure Load Balancer?'));
assert(ctx.isGenuineYesNoQuestion('Have you worked with Terraform modules?'));
assert(ctx.providerInterviewInput('openai',prepared('What is inside the service connection?'))===prepared('What is inside the service connection?').prompt);
const tf=ctx.activeInterviewSubject({intentQuestion:'At which step does Terraform download the module?',session:{turns:[{question:'Where do you store Terraform modules in JFrog Artifactory?'}]}});
assert(tf.includes('terraform init'));
console.log('PASS: Azure follow-up subject, yes/no classification, Terraform init, readable line breaks, Sol isolation');
