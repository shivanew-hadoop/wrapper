const $=id=>document.getElementById(id);
let token=localStorage.getItem('topperToken')||'',current=null,showAllHistory=false,activity=[];
const api=async(path,options={})=>{const r=await fetch(path,{...options,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}) ,...(options.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||`Request failed (${r.status})`);return d};
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
async function load(){if(!token)return;try{const d=await api('/api/account');current=d.user;document.body.classList.add('authenticated');$('auth').classList.add('hidden');$('account').classList.remove('hidden');$('logout').classList.remove('hidden');$('remaining').textContent=mins(current.remainingSeconds);$('profile').textContent=`${current.name||''} · ${current.email} · Status: ${current.status}`;activity=buildActivity(d);renderHistory();if(current.role==='admin')loadAdmin()}catch(e){localStorage.removeItem('topperToken');token='';document.body.classList.remove('authenticated');message(e.message,true)}}
async function auth(kind){try{const d=await api(`/api/auth/${kind}`,{method:'POST',body:JSON.stringify({name:$('name').value,email:$('email').value,password:$('password').value})});token=d.token;localStorage.setItem('topperToken',token);history.replaceState(null,'',location.pathname);await load()}catch(e){message(e.message,true)}}
$('login').onclick=()=>auth('login');$('register').onclick=()=>auth('register');$('logout').onclick=()=>{localStorage.removeItem('topperToken');location.href='/'};
$('buy').onclick=async()=>{try{const d=await api('/api/payments/order',{method:'POST',body:'{}'});new Razorpay({key:d.keyId,amount:d.order.amount,currency:'INR',name:'Topper',description:'60 interview credits',order_id:d.order.id,prefill:{email:current.email,name:current.name},handler:async payment=>{await api('/api/payments/verify',{method:'POST',body:JSON.stringify(payment)});await load()}}).open()}catch(e){alert(e.message)}};
$('launch').onclick=async()=>{const button=$('launch'),status=$('launchStatus');try{button.disabled=true;status.textContent='Opening Topper…';const d=await api('/api/desktop/launch-token',{method:'POST',body:'{}'});location.href=d.launchUrl;setTimeout(()=>{status.textContent='Topper did not open? Install it once, then click Launch Topper again.';button.disabled=false},2200)}catch(e){status.textContent=e.message||'Unable to launch Topper.';button.disabled=false}};
async function loadAdmin(){const d=await api('/api/admin/dashboard');$('admin').classList.remove('hidden');$('stats').textContent=`Users: ${d.stats.users||0} · Active listening: ${d.stats.active||0} · With credits: ${d.stats.credited||0} · No credits: ${d.stats.pending||0}`;$('users').innerHTML=d.users.map(user=>`<div class="user"><span>${esc(user.email)}</span><span>${esc(user.status)}</span><span>${mins(user.credit_seconds)}</span><span>${esc(user.created_at)}</span></div>`).join('')}
$('addCredits').onclick=async()=>{try{await api('/api/admin/credits',{method:'POST',body:JSON.stringify({email:$('creditEmail').value,minutes:Number($('creditMinutes').value)})});await loadAdmin()}catch(e){alert(e.message)}};
load();
