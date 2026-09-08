chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id || message?.type!=='connect')return;
  connect(message.code).then(reply).catch(()=>reply({ok:false,message:'无法完成连接，请确认当前标签页已登录 Suno，软件中的配对码仍有效。'}));
  return true;
});
async function connect(code){
  const match=/^(\d{1,5}):([A-Za-z0-9_-]{32})$/.exec(String(code||''));
  if(!match || +match[1]<1024 || +match[1]>65535)return {ok:false,message:'配对码格式不正确，请从软件复制完整配对码。'};
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id || !['https://suno.com','https://www.suno.com'].includes(new URL(tab.url).origin))return {ok:false,message:'请切换到已经登录的 Suno 网页，再打开此助手。'};
  const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:async()=>{
    let fresh='';
    try{fresh=await window.Clerk?.session?.getToken?.()||'';}catch{}
    return {account: {userId: window.Clerk?.user?.id || '', username: window.Clerk?.user?.username || '', email: window.Clerk?.user?.primaryEmailAddress?.emailAddress || ''}, tokenCandidates:[{source:'clerk',token:fresh}]};
  }});
  const cookies=await chrome.cookies.getAll({url:tab.url});
  for(const cookie of cookies.filter(item=>item.name==='__session'||item.name.startsWith('__session_'))){
    result.tokenCandidates.push({source:'cookie',token:cookie.value});
  }
  if(!result.tokenCandidates.some(item=>item.token))return {ok:false,message:'未读取到登录状态，请先在 Suno 完成登录。'};
  const response=await fetch(`http://127.0.0.1:${match[1]}/connect`,{method:'POST',
    headers:{'content-type':'application/json','x-jifeng-pairing':match[2]},body:JSON.stringify(result),signal:AbortSignal.timeout(90000)});
  return response.json();
}
