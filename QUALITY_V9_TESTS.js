const fs=require('fs');const vm=require('vm');const assert=require('assert');
const source=fs.readFileSync(__dirname+'/backend/server.js','utf8');
const block=source.slice(source.indexOf('function chatProviderQuestionFocus('),source.indexOf('function cerebrasAnswerBudget('));
const sandbox={};vm.createContext(sandbox);
vm.runInContext(block.replace(/function providerInterviewInput\(provider,prepared\) \{[\s\S]*$/,''),sandbox);
const focus=sandbox.chatProviderQuestionFocus;
const tests=[
  [{intentQuestion:'What are the type of like... Okay. Fine. What is on load, what is on save, and what is on change?',correctedQuestion:'What are the type of like... Okay. Fine. What is on load, what is on save, and what is on change?'},'onLoad, onSave, and onChange',false],
  [{intentQuestion:'So what exactly is that and what’s your role and what you did in that?',correctedQuestion:'So what exactly is that and what’s your role and what you did in that?'},'what exactly is that',false],
  [{intentQuestion:'How does the payload start from Dataverse through Azure Service Bus to a third party?',correctedQuestion:'How does the payload start from Dataverse through Azure Service Bus to a third party?'},'Dataverse',true],
  [{intentQuestion:'How do I register a plugin?',correctedQuestion:'How do I register a plugin?'},'register a plugin',false]
];
for(const [p,phrase,flow] of tests){const result=focus(p);assert(result.question.toLowerCase().includes(phrase.toLowerCase()));assert.strictEqual(result.flow,flow);}
assert(focus(tests[0][0]).note.includes('NOT a separate question'));
assert(focus(tests[1][0]).note.includes('Never define the word'));
assert(block.includes('Never say \'from my CV\''));
assert(block.includes('END-TO-END FLOW FORMAT'));
console.log('PASS v9: abandoned STT false start, referential follow-up, arrow flow, standalone question, spoken CV phrasing');
