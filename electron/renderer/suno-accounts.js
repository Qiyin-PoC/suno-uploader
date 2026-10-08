(() => {
  const api=window.gaobai;
  const select=document.getElementById('sunoAccountSelect');
  if (!select || !api.getSunoAccounts) return;
  const hint=document.getElementById('sunoAccountHint');
  const panel=document.getElementById('sunoExtensionPanel');
  const code=document.getElementById('sunoPairingCode');
  let snapshot={selectedId:'1',accounts:[]};
  let expiryTimer;
  let lastConnectionState='';
  window.sunoAccountBinding=()=>({accountId:snapshot.selectedId,
    accountUserId:snapshot.accounts.find(a=>a.id===snapshot.selectedId)?.userId || ''});
  const hidePairing=()=>{panel.hidden=true;code.value='';clearTimeout(expiryTimer);};
  window.refreshSunoConnectionUi=()=>render(snapshot);
  function render(value) {
    if (!value?.accounts) return;
    snapshot=value;
    select.replaceChildren(...value.accounts.map(account=>{
      const option=document.createElement('option');
      option.value=account.id;
      const labels={connected:'已连接',refreshing:'正在恢复',reconnect_required:'需要连接助手'};
      option.textContent=`${account.label} · ${labels[account.connectionState] || (account.hasCredentials?'已保存登录':'未登录')}`;
      return option;
    }));
    select.value=value.selectedId;
    const account=value.accounts.find(a=>a.id===value.selectedId);
    hint.textContent=account?.displayName ? `当前身份：${account.displayName}。新任务绑定此账号。` : (account?.hasCredentials ? '当前账号已保存登录；重新登录后可更新 Suno ID 或邮箱。' : '三个账号独立保存，新任务绑定当前所选账号。');
    if(account?.hasCredentials && account.loginMethod==='extension') {
      const oldHelper=!account.extensionVersion || account.extensionVersion!=='5.0.4' || Number(account.protocolVersion || 0)<2;
      if(oldHelper)hint.textContent+=' 请从“扩展登录”打开新版助手目录，加载 5.0.4 助手并重新配对一次；通常无需退出 Suno。';
      else if(account.connectionState==='reconnect_required')hint.textContent+=' 连接助手暂不可用，请打开原账号网页；若仍未恢复，请重新配对。';
      else if(account.connectionState==='refreshing')hint.textContent+=' 正在自动恢复连接，登录资料已保留。';
    }
    const connectionKey=`${account?.id}:${account?.connectionState || ''}`;
    const mayUpdateStatus=!state.currentStatusText || /^(Suno|已登录 Suno|准备就绪|等待开始)/.test(state.currentStatusText);
    if(account?.loginMethod==='extension' && connectionKey!==lastConnectionState && !state.busy && mayUpdateStatus) {
      if(account.connectionState==='connected') {
        setStatus('Suno 已连接');setUploadNotice('Suno 连接正常，登录助手会自动续期。','success');
        document.getElementById('loginBtn').style.display='none';document.getElementById('logoutBtn').style.display='';
      } else if(['refreshing','reconnect_required'].includes(account.connectionState)) {
        setStatus('Suno 连接待恢复');
        setUploadNotice(account.connectionState==='refreshing'?'正在恢复 Suno 连接，请保持原账号网页打开。':'请打开原账号的 Suno 网页或重新连接助手，登录资料已保留。','warn');
      }
      lastConnectionState=connectionKey;
    }
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
