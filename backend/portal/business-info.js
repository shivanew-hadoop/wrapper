(()=>{
  const byField=(name)=>document.querySelectorAll(`[data-business-field="${name}"]`);
  const setField=(name,value)=>byField(name).forEach(node=>{
    const text=String(value||'').trim();
    if(text){node.textContent=text;node.closest('[data-business-row]')?.classList.remove('businessMissing');}
    else if(node.hasAttribute('data-business-required')){node.textContent='Configure before payment-gateway review';node.closest('[data-business-row]')?.classList.add('businessMissing');}
    else{node.closest('[data-business-row]')?.classList.add('hidden');}
  });
  const setHref=(kind,value)=>document.querySelectorAll(`[data-business-link="${kind}"]`).forEach(node=>{
    const text=String(value||'').trim();
    if(!text){node.closest('[data-business-row]')?.classList.add('hidden');return;}
    node.href=kind==='phone'?`tel:${text.replace(/\s+/g,'')}`:`mailto:${text}`;
    node.textContent=text;
  });
  fetch('/api/public/business-profile',{cache:'no-store'})
    .then(r=>r.ok?r.json():Promise.reject(new Error(`Business profile ${r.status}`)))
    .then(data=>{
      const b=data?.business||{};
      for(const key of ['brandName','legalName','businessType','supportEmail','supportPhone','address','gstin','udyam'])setField(key,b[key]);
      setHref('email',b.supportEmail);
      setHref('phone',b.supportPhone);
      document.querySelectorAll('[data-business-profile-warning]').forEach(node=>node.classList.toggle('hidden',Boolean(b.profileComplete)));
      document.documentElement.dataset.businessProfileComplete=b.profileComplete?'true':'false';
    })
    .catch(()=>document.querySelectorAll('[data-business-profile-warning]').forEach(node=>node.classList.remove('hidden')));
})();
