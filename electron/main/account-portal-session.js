// A live device heartbeat does not guarantee that its separate Sanctum token is valid.
// Verify website access independently without replacing the active device session.
async function verifiedPortalToken({manager, request, credentials}) {
  const current=manager.session;
  if (!current) return '';
  const userId=String(current.user?.id || '');
  if (!userId) throw new Error('无法确认当前账号，请重新登录软件。');
  const assertCurrent=()=>{
    if (manager.session!==current) throw new Error('当前账号已改变，请重新打开个人中心。');
  };
  const verify=async token=>{
    const result=await request('/api/account',{token});
    assertCurrent();
    if (result.ok) {
      if (String(result.body?.user?.id || '')!==userId) throw new Error('网页登录账号与软件账号不一致，请重新登录软件。');
      return true;
    }
    if (result.status!==401) throw new Error('个人中心连接暂时不可用，请稍后重试。');
    return false;
  };
  for (const token of new Set([current.portal_access_token,current.access_token].filter(Boolean))) {
    if (await verify(token)) return token;
  }
  const login=credentials || manager.loadLoginPreferences();
  if (!login?.password || !login.email || login.email.trim().toLowerCase()!==String(current.user?.email || '').trim().toLowerCase()) {
    throw new Error('网页登录已失效，请重新登录一次软件以恢复个人中心。');
  }
  const result=await request('/api/auth/login',{method:'POST',body:{email:login.email,password:login.password}});
  assertCurrent();
  if (!result.ok) throw new Error([401,422].includes(result.status)?'网页登录已失效，请重新登录软件。':'个人中心连接暂时不可用，请稍后重试。');
  const token=String(result.body?.token || result.body?.access_token || '');
  if (!token || !await verify(token)) throw new Error('网页登录验证未通过，请重新登录软件。');
  assertCurrent();
  current.portal_access_token=token;
  manager.saveSession(); // Encrypted with the existing software session; no password saved here.
  return token;
}
module.exports={verifiedPortalToken};
