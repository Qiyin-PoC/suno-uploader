(() => {
  const api=window.gaobai;
  const select=document.getElementById('sunoAccountSelect');
  if (!select || !api.getSunoAccounts) return;
  const hint=document.getElementById('sunoAccountHint');
  const panel=document.getElementById('sunoExtensionPanel');
  const code=document.getElementById('sunoPairingCode');
  let snapshot={selectedId:'1',accounts:[]};
  let expiryTimer;
  window.sunoAccountBinding=()=>({accountId:snapshot.selectedId,
    accountUserId:snapshot.accounts.find(a=>a.id===snapshot.selectedId)?.userId || ''});
  const hidePairing=()=>{panel.hidden=true;code.value='';clearTimeout(expiryTimer);};
  function render(value) {
    if (!value?.accounts) return;
    snapshot=value;
    select.replaceChildren(...value.accounts.map(account=>{
      const option=document.createElement('option');
      option.value=account.id;
      option.textContent=`${account.label} · ${account.hasCredentials?'已保存登录':'未登录'}`;
      return option;
    }));
    select.value=value.selectedId;
    const account=value.accounts.find(a=>a.id===value.selectedId);
    hint.textContent=account?.displayName ? `当前身份：${account.displayName}。新任务绑定此账号。` : (account?.hasCredentials ? '当前账号已保存登录；重新登录后可更新 Suno ID 或邮箱。' : '三个账号独立保存，新任务绑定当前所选账号。');
    if (value.connectedId) {
      hidePairing();
      checkLoginStatus();
      setUploadNotice(`账号 ${value.connectedId} 扩展登录已验证并保存。`,'success');
    }
  }
  api.getSunoAccounts().then(render).catch(()=>{hint.textContent='账号列表读取失败，请重新打开软件。';});
  api.onSunoAccounts?.(render);
  select.addEventListener('change',async()=>{
    select.disabled=true;
    try {
      const result=await api.selectSunoAccount(select.value);
      if (!result.ok) {select.value=snapshot.selectedId;hint.textContent=result.message;return;}
      hidePairing();render(result);
      document.getElementById('loginBtn').style.display='';
      document.getElementById('logoutBtn').style.display='none';
      await checkLoginStatus();
    } finally {select.disabled=Boolean(state.busy);}
  });
  document.getElementById('sunoExtensionBtn').addEventListener('click',async()=>{
    const result=await api.startSunoExtension();
    if (!result.ok) {hint.textContent=result.message || '无法开始扩展连接';return;}
    code.value=result.code;
    panel.hidden=false;
    document.getElementById('sunoPairingTarget').textContent=`连接账号 ${result.accountId} · 配对码 5 分钟内有效`;
    clearTimeout(expiryTimer);
    expiryTimer=setTimeout(()=>{hidePairing();hint.textContent='配对已过期，请重新点击扩展登录。';},Math.max(0,result.expiresAt-Date.now()));
  });
  document.getElementById('sunoExtensionFolder').addEventListener('click',async()=>{
    const result=await api.openSunoExtensionFolder();
    if (!result.ok) hint.textContent='扩展目录未能打开，请从实验版文件夹中查找 suno-login-extension。';
  });
  document.getElementById('sunoPairingCancel').addEventListener('click',async()=>{await api.cancelSunoExtension();hidePairing();});
})();
