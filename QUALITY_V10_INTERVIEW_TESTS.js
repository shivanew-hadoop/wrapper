const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(__dirname+'/backend/server.js','utf8');
const start=source.indexOf('function interviewPrecisionFocus('),end=source.indexOf('function chatProviderQuestionFocus(',start);
const ctx={};vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
const focus=ctx.interviewPrecisionFocus;
const sqlHistory={session:{turns:[{question:'Which type of SQL queries are you using?'}]}};
const cases=[
 ['What new challenge you will see that will be of a biggest challenge that you have faced',{},'biggest challenge you faced'],
 ['Can you explain me a query? I mean, its parameters. You can inquiry any small query you',sqlHistory,'Write one small working SQL query'],
 ['Been fetching, fetching a data from one table. So how will you write like that?',sqlHistory,'SQL SELECT query fetching data from one table'],
 ['In your current project, you were having core or database and a client validation. Everything was handled by CD only',{},'handled internally or by external'],
 ['CT only, or you were having third parties to handle client onboarding and then database',{},'handled internally or by external'],
 ['Or you have referred something and then generate it', {session:{turns:[{question:'Have you created API from scratch?'}]}},'Did you generate APIs'],
 ['Are you familiar with Swagger YAML files?',{},null],
 ['How will you map the client fields to different core APIs?',{},null]
];
for(const [question,extra,expected] of cases){const result=focus({correctedQuestion:question,...extra});assert.strictEqual(result?.question?.includes(expected)||false,!!expected,question);}
assert(source.includes('For SQL example requests, give executable SQL'));
console.log('PASS v10: 8 interview intent/ownership checks; prompt SQL execution policy');
