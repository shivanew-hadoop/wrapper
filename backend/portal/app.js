const $=id=>document.getElementById(id);
let token=localStorage.getItem('topperToken')||'',current=null,showAllHistory=false,activity=[],interviewSessions=[];
const api=async(path,options={})=>{const r=await fetch(path,{...options,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}) ,...(options.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||`Request failed (${r.status})`);return d};
const apiBlob=async(path)=>{const r=await fetch(path,{headers:{...(token?{authorization:`Bearer ${token}`}:{})}});if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error||`Request failed (${r.status})`)}return r.blob()};
const mins=s=>`${Math.floor(Math.max(0,Number(s)||0)/60)} min`;
const used=s=>{const n=Math.max(0,Math.abs(Number(s)||0));return n<60?`${Math.max(1,Math.round(n))} sec`:`${Math.ceil(n/60)} min`};
const when=value=>{if(!value)return'';const normalized=/Z$|[+-]\d\d:?\d\d$/.test(value)?value:String(value).replace(' ','T')+'Z';const d=new Date(normalized);return Number.isNaN(d.valueOf())?value:d.toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})};
const esc=value=>String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
function message(text,bad=false){$('authMsg').textContent=text;$('authMsg').className=bad?'bad':'good'}

function buildActivity(data){
  const items=data.orders.map(order=>({type:'purchase',title:order.status==='paid'?'Credits purchased':'Payment '+order.status,detail:`${mins(order.credits_seconds)} · ₹${(order.amount_paise/100).toFixed(0)}`,amount:order.status==='paid'?`+${mins(order.credits_seconds)}`:order.status,date:order.paid_at||order.created_at,sort:order.paid_at||order.created_at}));
  const usage=new Map();
  for(const row of data.ledger){
    if(row.reason==='purchase')continue;
    if(row.reason==='usage'){
      const key=row.reference||`legacy-${row.created_at}`;const existing=usage.get(key)||{seconds:0,date:row.created_at};existing.seconds+=Math.abs(Number(row.delta_seconds)||0);if(String(row.created_at)>String(existing.date))existing.date=row.created_at;usage.set(key,existing);continue;
    }
    const positive=Number(row.delta_seconds)>0;
    items.push({type:'adjustment',title:positive?'Credits added':'Credit adjustment',detail:row.reason==='admin_adjustment'?'Admin adjustment':String(row.reason||'Adjustment').replaceAll('_',' '),amount:`${positive?'+':''}${mins(row.delta_seconds)}`,date:row.created_at,sort:row.created_at});
  }
  for(const session of usage.values())items.push({type:'usage',title:'Interview session',detail:`${used(session.seconds)} used`,amount:`−${used(session.seconds)}`,date:session.date,sort:session.date});
  return items.sort((a,b)=>String(b.sort).localeCompare(String(a.sort)));
}
function renderHistory(){
  const target=$('history');if(!activity.length){target.innerHTML='<div class="emptyActivity">No activity yet.</div>';return}
  const visible=showAllHistory?activity:activity.slice(0,5);
  target.innerHTML=`<div class="activityList">${visible.map(item=>`<div class="activityItem ${esc(item.type)}"><span class="activityIcon">${item.type==='purchase'?'＋':item.type==='usage'?'◷':'↕'}</span><span><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></span><span class="activityAmount">${esc(item.amount)}</span><time>${esc(when(item.date))}</time></div>`).join('')}</div>${activity.length>5?`<button id="historyToggle" class="historyToggle">${showAllHistory?'Show recent only':`View all ${activity.length} activities`}</button>`:''}`;
  const toggle=$('historyToggle');if(toggle)toggle.onclick=()=>{showAllHistory=!showAllHistory;renderHistory()};
}
function sessionWhen(ms){const d=new Date(Number(ms)||0);return Number.isNaN(d.valueOf())?'':d.toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function turnTime(ms){const d=new Date(Number(ms)||0);return Number.isNaN(d.valueOf())?'':d.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function renderInterviewHistory(){
  const target=$('interviewHistory');if(!target)return;
  if(!interviewSessions.length){target.innerHTML='<div class="emptyActivity">No saved interview sessions yet. Stop an interview session in Topper to save it here.</div>';return}
  target.innerHTML=interviewSessions.map((session,index)=>`<article class="savedSession"><div class="savedSessionSummary"><div><strong>${esc(sessionWhen(session.endedAt))}</strong><small>${Number(session.turnCount)||0} question${Number(session.turnCount)===1?'':'s'} · ${esc(session.summary?.level||'completed session')}</small>${session.summary?.overview?`<p class="sessionOverview">${esc(session.summary.overview)} ${esc(session.summary.assessment||'')}</p>`:''}</div><div class="savedSessionActions"><button class="historyToggle viewTranscript" data-index="${index}">View</button><button class="historyToggle downloadTranscript" data-id="${esc(session.id)}">Download PDF</button></div></div><div class="savedTurns hidden" id="savedTurns-${index}">${(session.turns||[]).map((turn,turnIndex)=>`<div class="savedTurn"><time>${esc(turnTime(turn.askedAt))}</time><strong>Q${turnIndex+1}. ${esc(turn.question)}</strong><p>${esc(turn.answer)}</p><div class="savedDots">· · · · · · · · · · · ·</div></div>`).join('')}</div></article>`).join('');
  document.querySelectorAll('.viewTranscript').forEach(button=>button.onclick=()=>{const pane=$(`savedTurns-${button.dataset.index}`);const opening=pane.classList.contains('hidden');pane.classList.toggle('hidden');button.textContent=opening?'Hide':'View'});
  document.querySelectorAll('.downloadTranscript').forEach(button=>button.onclick=async()=>{const original=button.textContent;try{button.disabled=true;button.textContent='Preparing…';const blob=await apiBlob(`/api/interview-transcripts/${encodeURIComponent(button.dataset.id)}/pdf`);const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='Topper-Interview-Transcript.pdf';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(e){alert(e.message)}finally{button.disabled=false;button.textContent=original}});
}
async function loadInterviewHistory(){try{const d=await api('/api/interview-transcripts');interviewSessions=Array.isArray(d.sessions)?d.sessions:[];renderInterviewHistory()}catch(e){interviewSessions=[];renderInterviewHistory()}}
async function load(){if(!token)return;try{const d=await api('/api/account');current=d.user;document.body.classList.add('authenticated');$('auth').classList.add('hidden');$('account').classList.remove('hidden');$('logout').classList.remove('hidden');$('remaining').textContent=mins(current.remainingSeconds);$('profile').textContent=`${current.name||''} · ${current.email} · Status: ${current.status}`;activity=buildActivity(d);renderHistory();await loadInterviewHistory();if(current.role==='admin')loadAdmin();const returnedOrder=new URLSearchParams(location.search).get('phonepeOrder');if(returnedOrder){history.replaceState(null,'',location.pathname);setTimeout(()=>verifyPhonePeOrder(returnedOrder),0)}}catch(e){localStorage.removeItem('topperToken');token='';document.body.classList.remove('authenticated');message(e.message,true)}}
async function auth(kind){try{const d=await api(`/api/auth/${kind}`,{method:'POST',body:JSON.stringify({name:$('name').value,email:$('email').value,password:$('password').value})});token=d.token;localStorage.setItem('topperToken',token);history.replaceState(null,'',location.pathname);await load()}catch(e){message(e.message,true)}}
$('login').onclick=()=>auth('login');$('register').onclick=()=>auth('register');$('logout').onclick=()=>{localStorage.removeItem('topperToken');location.href='/'};
// Standard portal keyboard behaviour: Enter submits login from any auth field.
for(const id of ['name','email','password'])$(id).addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&!event.repeat){event.preventDefault();auth('login')}});
async function verifyPhonePeOrder(merchantOrderId){
  if(!merchantOrderId)return;
  try{
    const d=await api('/api/payments/verify',{method:'POST',body:JSON.stringify({merchantOrderId})});
    if(d.status==='paid')await load();
    else if(d.status==='pending')alert('Payment is still processing. Please check again shortly.');
    else alert(`Payment ${d.status||'could not be confirmed'}.`);
  }catch(e){alert(e.message)}
}
$('buy').onclick=async()=>{
  try{
    const d=await api('/api/payments/order',{method:'POST',body:'{}'});
    const finish=async response=>{
      if(response==='CONCLUDED')await verifyPhonePeOrder(d.merchantOrderId);
    };
    if(window.PhonePeCheckout&&window.PhonePeCheckout.transact){
      window.PhonePeCheckout.transact({tokenUrl:d.checkoutUrl,callback:finish,type:'IFRAME'});
    }else{
      location.href=d.checkoutUrl;
    }
  }catch(e){alert(e.message)}
};
$('launch').onclick=async()=>{const button=$('launch'),status=$('launchStatus');try{button.disabled=true;status.textContent='Opening Topper…';const d=await api('/api/desktop/launch-token',{method:'POST',body:'{}'});location.href=d.launchUrl;setTimeout(()=>{status.textContent='Topper did not open? Install it once, then click Launch Topper again.';button.disabled=false},2200)}catch(e){status.textContent=e.message||'Unable to launch Topper.';button.disabled=false}};
async function loadAdmin(){const d=await api('/api/admin/dashboard');$('admin').classList.remove('hidden');$('stats').textContent=`Users: ${d.stats.users||0} · Active listening: ${d.stats.active||0} · With credits: ${d.stats.credited||0} · No credits: ${d.stats.pending||0}`;$('users').innerHTML=d.users.map(user=>`<div class="user"><span>${esc(user.email)}</span><span>${esc(user.status)}</span><span>${mins(user.credit_seconds)}</span><span>${esc(user.created_at)}</span></div>`).join('')}
$('addCredits').onclick=async()=>{try{await api('/api/admin/credits',{method:'POST',body:JSON.stringify({email:$('creditEmail').value,minutes:Number($('creditMinutes').value)})});await loadAdmin()}catch(e){alert(e.message)}};
for(const id of ['creditEmail','creditMinutes'])$(id).addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&!event.repeat){event.preventDefault();$('addCredits').click()}});
load();
