const $ = id => document.getElementById(id);
const email = $('email');
const verifyBtn = $('verifyBtn');
const licenseStatus = $('licenseStatus');
const resumeInput = $('resume');
const jdInput = $('jd');
const jdText = $('jdText');
const years = $('years');
const role = $('role');
const prepareBtn = $('prepareBtn');
const progress = $('progress');
const progressTitle = $('progressTitle');
const progressText = $('progressText');
const errorEl = $('error');
const MAX_FILE_BYTES = 6 * 1024 * 1024;
let licenseVerified = false;

const savedEmail = localStorage.getItem('licenseEmail');
if (savedEmail) email.value = savedEmail;
years.value = localStorage.getItem('yearsExperience') || '';
role.value = localStorage.getItem('targetRole') || '';

if (savedEmail) {
  setTimeout(async () => {
    const result = await window.electronAPI.validateLicense({ licenseEmail: savedEmail }).catch(() => null);
    if (result?.success) {
      licenseVerified = true;
      setLicenseStatus(`Verified${result.validTill ? ` · valid through ${result.validTill}` : ''}.`, 'ok');
    } else if (result) {
      licenseVerified = false;
      setLicenseStatus(result.error || 'Saved license is no longer valid.', 'err');
    }
  }, 80);
}

function setLicenseStatus(text, cls='') {
  licenseStatus.className = `status${cls ? ` ${cls}` : ''}`;
  licenseStatus.textContent = text;
}
function showError(message) {
  errorEl.textContent = message;
  errorEl.classList.toggle('hidden', !message);
}
function fileMeta(input, target) {
  const f = input.files?.[0];
  if (!f) return;
  target.textContent = `${f.name} · ${(f.size / 1024).toFixed(0)} KB`;
}
resumeInput.addEventListener('change', () => fileMeta(resumeInput, $('resumeMeta')));
jdInput.addEventListener('change', () => fileMeta(jdInput, $('jdMeta')));
email.addEventListener('input', () => { licenseVerified = false; setLicenseStatus('License not verified.'); });

verifyBtn.onclick = async () => {
  const value = email.value.trim().toLowerCase();
  if (!value) return setLicenseStatus('Enter your license email.', 'err');
  verifyBtn.disabled = true;
  setLicenseStatus('Verifying…');
  const result = await window.electronAPI.validateLicense({ licenseEmail: value }).catch(err => ({ success:false, error:err.message }));
  verifyBtn.disabled = false;
  if (!result.success) { licenseVerified = false; return setLicenseStatus(result.error || 'License verification failed.', 'err'); }
  licenseVerified = true;
  localStorage.setItem('licenseEmail', value);
  setLicenseStatus(`Verified${result.validTill ? ` · valid through ${result.validTill}` : ''}.`, 'ok');
};

async function fileToPayload(file) {
  if (!file) return null;
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than 6 MB.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const block = 0x8000;
  for (let i = 0; i < bytes.length; i += block) binary += String.fromCharCode(...bytes.subarray(i, i + block));
  return { name:file.name, type:file.type || 'application/octet-stream', base64:btoa(binary) };
}

prepareBtn.onclick = async () => {
  showError('');
  const licenseEmail = email.value.trim().toLowerCase();
  const resumeFile = resumeInput.files?.[0];
  const jdFile = jdInput.files?.[0];
  const pastedJd = jdText.value.trim();
  const exp = Number(years.value);

  if (!licenseEmail) return showError('Enter and verify your license email.');
  if (!licenseVerified) {
    const check = await window.electronAPI.validateLicense({ licenseEmail }).catch(err => ({ success:false, error:err.message }));
    if (!check.success) return showError(check.error || 'License verification failed.');
    licenseVerified = true;
  }
  if (!resumeFile) return showError('Upload your resume. Common formats including PDF, DOC, DOCX, RTF and text-based files are supported.');
  if (!jdFile && !pastedJd) return showError('Upload a job description or paste the JD text.');
  if (!Number.isFinite(exp) || exp < 0 || exp > 60) return showError('Enter a valid number of years of experience.');

  prepareBtn.disabled = true;
  verifyBtn.disabled = true;
  progress.classList.remove('hidden');
  progressTitle.textContent = 'Preparing interview context…';
  progressText.textContent = 'Reading resume and job description…';

  try {
    const [resume, jd] = await Promise.all([fileToPayload(resumeFile), fileToPayload(jdFile)]);
    progressText.textContent = 'Parsing, summarizing and creating vectors. This is done only once before listening…';
    const result = await window.electronAPI.prepareContext({
      licenseEmail, resume, jd, jdText:pastedJd, yearsExperience:exp, role:role.value.trim()
    });
    if (!result.success) throw new Error(result.error || 'Context preparation failed.');
    localStorage.setItem('licenseEmail', licenseEmail);
    localStorage.setItem('yearsExperience', String(exp));
    localStorage.setItem('targetRole', role.value.trim());
    progressTitle.textContent = 'Interview context ready';
    progressText.textContent = `${result.chunkCount || 0} searchable chunks prepared. Opening live overlay…`;
    await new Promise(r => setTimeout(r, 250));
    const opened = await window.electronAPI.openOverlayAfterSetup();
    if (!opened?.success) throw new Error(opened?.error || 'License validation failed before opening the listening screen.');
  } catch (err) {
    progress.classList.add('hidden');
    showError(err.message || 'Context preparation failed.');
    prepareBtn.disabled = false;
    verifyBtn.disabled = false;
  }
};
