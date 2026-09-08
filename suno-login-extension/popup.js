document.getElementById('connect').addEventListener('click',async()=>{
  const button=document.getElementById('connect'), status=document.getElementById('status');
  button.disabled=true;status.textContent='正在读取并验证 Suno 登录状态…';
  try {
    const result=await chrome.runtime.sendMessage({type:'connect',code:document.getElementById('pair').value.trim()});
    status.textContent=result?.ok?`账号 ${result.accountId} 已连接，可以返回 Studio 上传。`:(result?.message||'连接失败，请重新登录后重试。');
    if(result?.ok)document.getElementById('pair').value='';
  } catch {status.textContent='无法连接软件，请确认 Studio 已启动扩展登录。';}
  finally{button.disabled=false;}
});
