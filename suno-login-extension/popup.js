document.getElementById('connect').addEventListener('click',async()=>{
  const button=document.getElementById('connect'), status=document.getElementById('status');
  button.disabled=true;status.textContent='正在读取并验证 Suno 登录状态…';
  try {
    const result=await chrome.runtime.sendMessage({type:'connect',code:document.getElementById('pair').value.trim()});
    status.textContent=result?.ok?`账号 ${result.accountId} 已连接。上传时请保持原账号的 Suno 网页打开。软件或浏览器重启后，助手会自动恢复连接。`:(result?.message||'连接失败，请重新登录后重试。');
    if(result?.ok)document.getElementById('pair').value='';
  } catch {status.textContent='无法连接软件，请确认 Studio 已启动扩展登录。';}
  finally{button.disabled=false;}
});
