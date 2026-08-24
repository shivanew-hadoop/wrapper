const $ = id => document.getElementById(id);
const accountEmail=$('accountEmail'),accountCredits=$('accountCredits'),licenseStatus=$('licenseStatus'),portalBtn=$('portalBtn');
const resumeInput=$('resume'),jdInput=$('jd'),jdText=$('jdText'),years=$('years'),role=$('role'),prepareBtn=$('prepareBtn');
const progress=$('progress'),progressTitle=$('progressTitle'),progressText=$('progressText'),errorEl=$('error');
const MAX_FILE_BYTES=6*1024*1024;let currentAccount=null;

years.value=localStorage.getItem('yearsExperience')||'';role.value=localStorage.getItem('targetRole')||'';
const minutes=seconds=>`${Math.floor(Math.max(0,Number(seconds)||0)/60)} min`;
function showError(message){errorEl.textContent=message;errorEl.classList.toggle('hidden',!message)}
function showAccount(account){currentAccount=account||null;accountEmail.textContent=account?.email||'Not connected';accountCredits.textContent=account?minutes(account.remainingSeconds):'--';licenseStatus.className=`status ${account?'ok':'err'}`;licenseStatus.textContent=account?'Account connected securely through the Topper portal.':'Launch Topper from the customer portal to connect this device.';prepareBtn.disabled=!account;portalBtn.classList.toggle('hidden',!!account)}
async function loadAccount(){const result=await window.electronAPI.getDesktopAccount().catch(err=>({success:false,error:err.message}));if(result?.success)showAccount(result.account);else{showAccount(null);if(result?.error)licenseStatus.textContent=result.error}}
window.electronAPI.onDesktopAccountUpdated(showAccount);window.electronAPI.onDesktopAccountError(message=>{showAccount(null);licenseStatus.textContent=message});
portalBtn.onclick=()=>window.electronAPI.openCustomerPortal();loadAccount();

function fileMeta(input,target){const f=input.files?.[0];if(f)target.textContent=`${f.name} · ${(f.size/1024).toFixed(0)} KB`}
resumeInput.addEventListener('change',()=>fileMeta(resumeInput,$('resumeMeta')));jdInput.addEventListener('change',()=>fileMeta(jdInput,$('jdMeta')));
async function fileToPayload(file){if(!file)return null;if(file.size>MAX_FILE_BYTES)throw new Error(`${file.name} is larger than 6 MB.`);const bytes=new Uint8Array(await file.arrayBuffer());let binary='';const block=0x8000;for(let i=0;i<bytes.length;i+=block)binary+=String.fromCharCode(...bytes.subarray(i,i+block));return{name:file.name,type:file.type||'application/octet-stream',base64:btoa(binary)}}

prepareBtn.onclick=async()=>{showError('');const resumeFile=resumeInput.files?.[0],jdFile=jdInput.files?.[0],pastedJd=jdText.value.trim(),exp=Number(years.value);
  if(!currentAccount)return showError('Launch Topper from the customer portal first.');
  if(!resumeFile)return showError('Upload your resume. Common formats including PDF, DOC, DOCX, RTF and text-based files are supported.');
  if(!jdFile&&!pastedJd)return showError('Upload a job description or paste the JD text.');
  if(!Number.isFinite(exp)||exp<0||exp>60)return showError('Enter a valid number of years of experience.');
  prepareBtn.disabled=true;progress.classList.remove('hidden');progressTitle.textContent='Preparing interview context…';progressText.textContent='Reading resume and job description…';
  try{const[resume,jd]=await Promise.all([fileToPayload(resumeFile),fileToPayload(jdFile)]);progressText.textContent='Parsing, summarizing and creating vectors. This is done only once before listening…';const result=await window.electronAPI.prepareContext({licenseEmail:currentAccount.email,resume,jd,jdText:pastedJd,yearsExperience:exp,role:role.value.trim()});if(!result.success)throw new Error(result.error||'Context preparation failed.');localStorage.setItem('yearsExperience',String(exp));localStorage.setItem('targetRole',role.value.trim());progressTitle.textContent='Interview context ready';progressText.textContent=`${result.chunkCount||0} searchable chunks prepared. Opening live overlay…`;await new Promise(r=>setTimeout(r,250));const opened=await window.electronAPI.openOverlayAfterSetup();if(!opened?.success)throw new Error(opened?.error||'Account validation failed before opening the listening screen.');}
  catch(err){progress.classList.add('hidden');showError(err.message||'Context preparation failed.');prepareBtn.disabled=!currentAccount;}
};
