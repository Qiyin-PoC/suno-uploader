const REFRESH_PREFIX='studio-refresh-';
const PROTOCOL_VERSION=2;
const refreshing=new Set(),watching=new Map();
const storageWrites=new Map();
const metadata=()=>({protocolVersion:PROTOCOL_VERSION,extensionVersion:chrome.runtime.getManifest().version});
const sunoUrl=url=>{try{return ['https://suno.com','https://www.suno.com'].includes(new URL(url).origin);}catch{return false;}};
const validSecret=value=>typeof value==='string' && /^[A-Za-z0-9_-]{32}$/.test(value);
const validEntry=entry=>entry && Number.isInteger(entry.port) && entry.port>=1024 && entry.port<=65535 && typeof entry.userId==='string' && entry.userId.length>0 && entry.userId.length<=256 &&
  validSecret(entry.reconnectSecret) && Number.isFinite(entry.issuedAt) && entry.issuedAt>0 && entry.issuedAt<=Date.now()+30000;
// Local data is restricted to extension pages and this worker. Suno JWTs are never persisted here.
const storageReady=chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id || message?.type!=='connect')return;
  connect(message.code).then(reply).catch(error=>reply({ok:false,message:error.message || '无法完成连接，请确认 Suno 已登录且软件中的配对码有效。'}));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm=>{
  if(/^studio-refresh-[123]$/.test(alarm.name))refreshConnection(alarm.name.slice(REFRESH_PREFIX.length)).catch(()=>{});
});
chrome.runtime.onStartup.addListener(()=>recoverAlarms(true).catch(()=>{}));
chrome.runtime.onInstalled.addListener(()=>recoverAlarms(true).catch(()=>{}));
recoverAlarms(false).catch(()=>{});

async function request(port,route,secret,payload,timeout=20000,signal) {
  const response=await fetch(`http://127.0.0.1:${port}${route}`,{method:'POST',redirect:'error',cache:'no-store',
    headers:{'content-type':'application/json','x-jifeng-pairing':secret},body:JSON.stringify({...payload,...metadata()}),signal:signal || AbortSignal.timeout(timeout)});
  if(Number(response.headers.get('content-length'))>16384){await response.body?.cancel();throw new Error('本机连接响应过大，请重新启动软件。');}
  const reader=response.body?.getReader();let text='',bytes=0;const decoder=new TextDecoder();
  if(!reader)throw new Error('本机连接没有返回结果。');
  try {
    for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>16384)throw new Error('本机连接响应过大。');text+=decoder.decode(value,{stream:true});}
    text+=decoder.decode();
  }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  let body;try{body=JSON.parse(text);}catch{throw new Error('本机连接返回无效结果，请重试。');}
  if(!response.ok || body?.ok!==true){const error=new Error(body?.message || '连接验证未通过，请检查 Suno 登录状态后重试。');error.status=response.status;error.code=body?.code;throw error;}
  return body;
}
async function recoverAlarms(immediate) {
  await storageReady;
  const saved=await chrome.storage.local.get(null);
  for(const id of ['1','2','3']) {
    const key=REFRESH_PREFIX+id,entry=saved[key];if(!validEntry(entry))continue;
    if(!await chrome.alarms.get(key))await chrome.alarms.create(key,{periodInMinutes:0.5,delayInMinutes:0.5});
    if(immediate)refreshConnection(id).catch(()=>{});
    else watchStatus(id).catch(()=>{});
  }
}
async function authenticateBridge(entry) {
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  const nonce=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
  const challenge=await request(entry.port,'/challenge','',{nonce},4000);
  if(challenge.protocolVersion!==2 || typeof challenge.proof!=='string' || !/^[a-f0-9]{64}$/.test(challenge.proof))throw new Error('本机连接身份验证失败，请重新配对。');
  const encoder=new TextEncoder();
  const key=await crypto.subtle.importKey('raw',encoder.encode(entry.reconnectSecret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const signature=Uint8Array.from(challenge.proof.match(/../g),value=>parseInt(value,16));
  if(!await crypto.subtle.verify('HMAC',key,signature,encoder.encode(`gaobai-suno-bridge-v2:${nonce}`)))throw new Error('本机连接身份验证失败，请重新配对。');
}
function refreshDetails(response,port,userId) {
  const refresh=response.refresh;
  if(!refresh || refresh.port!==port || refresh.userId!==userId || !validSecret(refresh.secret) ||
     !Number.isFinite(refresh.expiresAt) || refresh.expiresAt<=Date.now() || refresh.expiresAt>Date.now()+8*60*60*1000+30000)throw new Error('本机连接凭据无效，请重新配对。');
  return {port,secret:refresh.secret,userId,expiresAt:refresh.expiresAt};
}
async function connect(code) {
  await storageReady;
  const match=/^(\d{1,5}):([A-Za-z0-9_-]{32})$/.exec(String(code||''));
  if(!match || +match[1]<1024 || +match[1]>65535)return {ok:false,message:'配对码格式不正确，请从软件复制完整配对码。'};
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id || !sunoUrl(tab.url))return {ok:false,message:'请切换到已经登录的 Suno 网页，再打开此助手。'};
  const payload=await readSunoTab(tab.id);
  if(!payload.account?.userId || !payload.tokenCandidates.some(item=>item.token))return {ok:false,message:'未读取到登录状态，请先在 Suno 完成登录。'};
  const connected=await request(+match[1],'/connect',match[2],payload,30000);
  if(!['1','2','3'].includes(connected.accountId))throw new Error('本机连接账号无效。');
  const session=refreshDetails(connected,+match[1],payload.account.userId),reconnect=connected.reconnect;
  if(connected.protocolVersion!==2 || !reconnect || reconnect.port!==+match[1] || reconnect.userId!==payload.account.userId ||
     !validSecret(reconnect.secret) || !Number.isFinite(reconnect.issuedAt) || reconnect.issuedAt<=0 || reconnect.issuedAt>Date.now()+30000)throw new Error('请将软件和登录助手更新至 5.0.4 后重新配对。');
  const key=REFRESH_PREFIX+connected.accountId;
  watching.get(connected.accountId)?.abort();
  await updateEntry(key,null,async()=>{
    await chrome.storage.local.set({[key]:{port:session.port,userId:session.userId,reconnectSecret:reconnect.secret,issuedAt:reconnect.issuedAt,
      tabId:tab.id,failures:0,nextRetryAt:0,connectionState:'connected',lastRefreshAt:Date.now()}});
    await chrome.storage.session.set({[key]:session});
  });
  await chrome.alarms.create(key,{periodInMinutes:0.5,delayInMinutes:0.5});
  watchStatus(connected.accountId).catch(()=>{});
  return {ok:true,accountId:connected.accountId};
}
async function readSunoTab(tabId,expectedUserId='',timeoutMs=10000) {
  const tab=await chrome.tabs.get(tabId);if(!sunoUrl(tab?.url))throw new Error('Suno tab unavailable');
  let timer;
  const output=await Promise.race([
    chrome.scripting.executeScript({target:{tabId},world:'MAIN',args:[expectedUserId],func:async expected=>{
      let fresh='',timer;const userId=window.Clerk?.user?.id || '';
      if(expected && userId!==expected)return {account:{userId},tokenCandidates:[]};
      try{fresh=await Promise.race([window.Clerk?.session?.getToken?.({skipCache:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Clerk timeout')),8000);})]) || '';}
      catch{}finally{clearTimeout(timer);}
      if(userId!==(window.Clerk?.user?.id || ''))throw new Error('Suno account changed');
      return {account:{userId,username:window.Clerk?.user?.username || '',email:window.Clerk?.user?.primaryEmailAddress?.emailAddress || ''},tokenCandidates:[{source:'clerk',token:fresh}]};
    }}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Suno page timeout')),Math.max(1,Math.min(10000,timeoutMs)));}),
  ]).finally(()=>clearTimeout(timer));
  const result=output?.[0]?.result;
  if(!result || !Array.isArray(result.tokenCandidates))throw new Error('Suno page did not respond');
  if(expectedUserId && result.account?.userId!==expectedUserId)return result;
  const cookies=await chrome.cookies.getAll({url:tab.url}).catch(()=>[]);
  for(const cookie of cookies.filter(item=>item.name==='__session'||item.name.startsWith('__session_')).slice(0,7))result.tokenCandidates.push({source:'cookie',token:cookie.value});
  result.tokenCandidates=result.tokenCandidates.filter(item=>typeof item.token==='string' && item.token.length<=16384).slice(0,8);
  return result;
}
async function findBoundTab(entry,timeoutMs=12000) {
  const deadline=performance.now()+Math.max(1,Math.min(12000,timeoutMs));
  const candidates=[entry.tabId];
  const tabs=await chrome.tabs.query({url:['https://suno.com/*','https://www.suno.com/*']});
  for(const tab of tabs.slice(0,8))if(!candidates.includes(tab.id))candidates.push(tab.id);
  for(const tabId of candidates){
    const remaining=deadline-performance.now();if(remaining<=0)break;
    try{const payload=await readSunoTab(tabId,entry.userId,remaining);if(payload.account?.userId===entry.userId && payload.tokenCandidates.some(item=>item.token))return {tabId,payload};}catch{}
  }
  throw new Error('请打开原配对账号的 Suno 网页并确认已登录。');
}
async function currentEntry(key,entry) {
  const latest=(await chrome.storage.local.get(key))[key];return latest?.reconnectSecret===entry.reconnectSecret?latest:null;
}
async function updateEntry(key,expected,write) {
  const before=storageWrites.get(key)||Promise.resolve();
  const operation=before.catch(()=>{}).then(async()=>{
    const latest=expected?await currentEntry(key,expected):null;
    if(expected && !latest)return false;
    await write(latest);return true;
  });
  storageWrites.set(key,operation);
  try{return await operation;}finally{if(storageWrites.get(key)===operation)storageWrites.delete(key);}
}
async function failure(key,entry,error) {
  await updateEntry(key,entry,async latest=>{
    const failures=Math.min(10,(latest.failures||0)+1),delay=Math.min(300000,30000*2**Math.min(failures-1,4));
    const revoked=error.code==='revoked';
    await chrome.storage.local.set({[key]:{...latest,failures,nextRetryAt:Date.now()+delay,connectionState:'reconnect_required',revoked}});
    if(revoked){await chrome.storage.session.remove(key);await chrome.alarms.clear(key);}
  });
}
async function refreshConnection(accountId) {
  if(!['1','2','3'].includes(accountId) || refreshing.has(accountId))return false;
  refreshing.add(accountId);const key=REFRESH_PREFIX+accountId;let entry;
  try {
    await storageReady;entry=(await chrome.storage.local.get(key))[key];
    if(!validEntry(entry) || entry.revoked){await chrome.alarms.clear(key);return false;}
    if(entry.nextRetryAt>Date.now() && entry.nextRetryAt<Date.now()+300001)return false;
    const session=(await chrome.storage.session.get(key))[key];
    await authenticateBridge(entry);
    const {tabId,payload}=await findBoundTab(entry);
    if(!await currentEntry(key,entry))return false;
    let response,nextSession;
    if(session?.secret && session.expiresAt>Date.now()+30000 && session.expiresAt<=Date.now()+8*60*60*1000+30000) {
      try{response=await request(entry.port,'/refresh',session.secret,payload);}
      catch(error){if(error.status!==403)throw error;}
    }
    if(!response) {
      response=await request(entry.port,'/resume',entry.reconnectSecret,payload);
      nextSession=refreshDetails(response,entry.port,entry.userId);
    }
    if(!await updateEntry(key,entry,async latest=>{
      if(nextSession)await chrome.storage.session.set({[key]:nextSession});
      await chrome.storage.local.set({[key]:{...latest,tabId,failures:0,nextRetryAt:0,connectionState:'connected',lastRefreshAt:Date.now()}});
    }))return false;
    watchStatus(accountId).catch(()=>{});return true;
  }catch(error){if(entry)await failure(key,entry,error);return false;}
  finally{refreshing.delete(accountId);}
}
async function watchStatus(accountId) {
  if(watching.has(accountId))return;
  const controller=new AbortController();watching.set(accountId,controller);const key=REFRESH_PREFIX+accountId;let entry;
  try {
    await storageReady;
    while(!controller.signal.aborted) {
      entry=(await chrome.storage.local.get(key))[key];const session=(await chrome.storage.session.get(key))[key];
      if(!validEntry(entry) || entry.revoked || !session?.secret || session.expiresAt<=Date.now())return;
      await authenticateBridge(entry);
      const status=await request(entry.port,'/status',session.secret,{wait:true,connectionState:entry.connectionState},25000,AbortSignal.any([controller.signal,AbortSignal.timeout(25000)]));
      if(!await currentEntry(key,entry))return;
      if(status.refreshRequested && !await refreshConnection(accountId))return;
    }
  }catch(error){if(entry && !controller.signal.aborted){
    if(error.status===403)await updateEntry(key,entry,()=>chrome.storage.session.remove(key));
    if(!refreshing.has(accountId))await failure(key,entry,error);
  }}finally{if(watching.get(accountId)===controller)watching.delete(accountId);}
}
