const fs=require('node:fs');
const crypto=require('node:crypto');

function claims(token) {
  try{return JSON.parse(Buffer.from(String(token).split('.')[1],'base64url').toString('utf8'));}
  catch{return {};}
}
async function refreshSunoCredential(file,userId,payload,{verify,isActive,now=()=>Date.now()/1000,timeoutMs=12000,signal}={}) {
  const active=()=>!signal?.aborted && typeof isActive==='function' && isActive();
  if(!active() || payload?.account?.userId!==userId)return {ok:false,code:'account_changed'};
  if(!Array.isArray(payload.tokenCandidates))return {ok:false,code:'bad_payload'};
  const candidates=payload.tokenCandidates.slice(0,8).filter(item=>item && typeof item.token==='string' && item.token.length<=16384)
    .sort((a,b)=>Number(b.source==='clerk')-Number(a.source==='clerk'));
  const deadline=performance.now()+Math.min(12000,Math.max(1,Number(timeoutMs)||12000)),seen=new Set();
  let attempts=0;
  for(const candidate of candidates) {
    if(!active())return {ok:false,code:'cancelled'};
    const token=candidate.token,info=claims(token),remaining=deadline-performance.now();
    if(remaining<=0)return {ok:false,code:'timeout'};
    if(seen.has(token) || info.sub!==userId || !Number.isFinite(info.exp) || info.exp<=now()+10 ||
       (info.iat!==undefined && (!Number.isFinite(info.iat) || info.iat>now()+30)) ||
       (info.nbf!==undefined && (!Number.isFinite(info.nbf) || info.nbf>now()+30)))continue;
    seen.add(token);if(attempts++>=3)break;
    const controller=new AbortController();let timer,abortListener;
    const timeout=Math.min(8000,remaining);
    let result;
    try {
      const stop=new Promise(resolve=>{
        timer=setTimeout(()=>{controller.abort();resolve({ok:false,code:'timeout'});},timeout);
        abortListener=()=>{controller.abort();resolve({ok:false,code:'cancelled'});};signal?.addEventListener('abort',abortListener,{once:true});
      });
      result=await Promise.race([Promise.resolve().then(()=>verify(token,{signal:controller.signal,timeoutMs:timeout})),stop]);
    }catch{return {ok:false,code:'network_error'};}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abortListener);}
    if(!active())return {ok:false,code:'cancelled'};
    if(result?.code==='timeout' || result?.code==='cancelled')return {ok:false,code:result.code};
    const verified=result===true || result?.ok===true;
    if(!verified) {
      const status=Number(result?.status_code);
      if(result && typeof result==='object' && (!status || status===408 || status===429 || status>=500))return {ok:false,code:'network_error'};
      continue;
    }
    let saved;try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return {ok:false,code:'missing_account'};}
    if(saved.account?.userId!==userId || saved.loginMethod!=='extension' || !active())return {ok:false,code:'account_changed'};
    // A verified older refresh must never replace a newer credential.
    if(Number(claims(saved.token).exp||0)>info.exp)return {ok:true};
    const account={...saved.account};
    for(const key of ['username','email']) {
      const value=String(payload.account[key]||'').trim().slice(0,254);
      if(value && !value.startsWith('user_'))account[key]=value;
    }
    const next={...saved,token,account,tokenSource:candidate.source==='cookie'?'cookie':'clerk',
      captured_at:Math.floor(now()),ts:Math.floor(now()*1000),tokenCheck:{ok:true,status_code:200,reason:'token_valid'}};
    const temporary=`${file}.refresh-${crypto.randomUUID()}`;
    try{fs.writeFileSync(temporary,JSON.stringify(next),'utf8');fs.renameSync(temporary,file);}
    finally{try{fs.unlinkSync(temporary);}catch{}}
    return {ok:true};
  }
  return {ok:false,code:'verification_failed'};
}
module.exports={refreshSunoCredential};
