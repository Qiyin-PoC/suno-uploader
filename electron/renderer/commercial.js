/* UI receives public account data only; credentials are exchanged by the main process. */
(() => {
  const $ = id => document.getElementById(id);
  const api = window.gaobai;
  const dialog = $('commercialDialog');
  let current = {loggedIn:false, valid:false};
  let orderId = '';
  let orderTimer;
  let requestBusy = false;
  const message = value => { $('commercialMessage').textContent = value || ''; };
  function apply(result) {
    current = result;
    updateLicenseUI(result);
    $('accountName').textContent = result.user?.email || '期音账号';
    $('accountMeta').textContent = result.valid ? '授权有效' : (result.loggedIn ? '尚未开通 / 已到期' : '未登录');
    $('commercialSummary').textContent = result.loggedIn
      ? `${result.user?.email || '已登录'} · ${result.valid ? '有效至 '+new Date(result.expires_at).toLocaleString('zh-CN') : '尚未开通或授权已到期'}`
      : result.message || '请登录期音账号';
    $('commercialForm').hidden = Boolean(result.loggedIn);
    $('commercialMember').hidden = !result.loggedIn;
  }
  async function status() { const result = await api.licenseStatus(); apply(result); return result; }
  async function plans() {
    const result = await api.commercialPlans();
    const plan = result.plans?.[0];
    $('commercialPlan').textContent = plan ? `${plan.name} · ¥${(plan.amount/100).toFixed(2)} · 最多 2 台设备` : '套餐尚未上架，请联系管理员';
    $('commercialWechat').hidden = !plan || !result.providers?.includes('wechat');
    $('commercialAlipay').hidden = !plan || !result.providers?.includes('alipay');
    if (plan && !result.providers?.length) $('commercialPlan').textContent += ' · 在线支付尚未开通';
  }
  async function open() {
    message('');
    if (!dialog.open) dialog.showModal();
    await status();
    if (current.loggedIn) await plans();
  }
  async function busy(fn) {
    if (requestBusy) return;
    requestBusy = true;
    dialog.setAttribute('aria-busy','true');
    const buttons = [...dialog.querySelectorAll('button')].filter(b => b.id !== 'commercialClose');
    buttons.forEach(b => {b.disabled=true;});
    try { await fn(); } catch { message('操作失败，请稍后重试'); }
    finally { requestBusy=false; dialog.removeAttribute('aria-busy'); buttons.forEach(b => {b.disabled=false;}); }
  }
  async function credentials(register) {
    if (!$('commercialForm').reportValidity()) return;
    const payload = {email:$('commercialEmail').value.trim(), password:$('commercialPassword').value};
    const result = await (register ? api.accountRegister(payload) : api.accountSubmitLogin(payload));
    $('commercialPassword').value = '';
    message(result.message);
    if (!register && result.ok) {
      apply(result);
      await plans();
      if (!result.remembered) message('已登录。系统密钥存储不可用，关闭软件后需重新登录。');
    }
  }
  async function checkOrder() {
    if (!orderId) return;
    const result = await api.commercialOrderStatus(orderId);
    if (result.order?.state === 'paid') {
      clearInterval(orderTimer);
      $('commercialPayment').hidden=true;
      orderId='';
      await status();
      message('支付已确认，授权已更新');
    } else message(result.ok ? '尚未收到到账确认，请稍后刷新；已付款请勿重复支付' : result.message);
  }
  async function purchase(provider) {
    clearInterval(orderTimer);
    $('commercialPayment').hidden=true;
    const result = await api.commercialOrder({provider});
    if (!result.ok) { message(result.message); return; }
    orderId=result.order_id;
    $('commercialQr').src=result.qrImage;
    $('commercialOrderInfo').textContent=`订单 ${orderId} · ¥${(result.amount/100).toFixed(2)} · 请在 15 分钟内付款`;
    $('commercialPayment').hidden=false;
    message('请用对应支付应用扫码');
    orderTimer=setInterval(() => busy(checkOrder), 5000);
  }
  $('commercialOpen').onclick=() => busy(open);
  $('commercialClose').onclick=() => dialog.close();
  dialog.addEventListener('close', () => {clearInterval(orderTimer); $('commercialPassword').value='';});
  window.addEventListener('commercial-open', () => busy(open));
  api.onCommercialOpen?.(() => busy(open));
  api.onCommercialEvent?.(apply);
  $('commercialForm').onsubmit=e => {e.preventDefault(); busy(() => credentials(false));};
  $('commercialRegister').onclick=() => busy(() => credentials(true));
  $('commercialRefresh').onclick=() => busy(async () => {await status(); message(current.message);});
  $('commercialLogout').onclick=() => busy(async () => {
    clearInterval(orderTimer); orderId=''; $('commercialPayment').hidden=true;
    const result=await api.accountLogout(); apply(result); message(result.message);
  });
  $('commercialWechat').onclick=() => busy(() => purchase('wechat'));
  $('commercialAlipay').onclick=() => busy(() => purchase('alipay'));
  $('commercialCheckOrder').onclick=() => busy(checkOrder);
  $('commercialDevices').onclick=() => busy(async () => {
    const result=await api.accountDevices();
    const list=$('commercialDeviceList'); list.replaceChildren();
    if (!result.ok) {message(result.message); return;}
    for (const device of result.devices || []) {
      const row=document.createElement('p');
      const text=document.createElement('span'); text.textContent=`${device.name}${device.device===result.current ? '（本机）' : ''} `;
      const button=document.createElement('button'); button.textContent='移除此设备';
      button.onclick=() => busy(async () => {
        const removed=await api.accountUnbindDevice(device.device);
        message(removed.ok ? '已移除，此设备需重新登录' : removed.message);
        if (removed.ok) row.remove();
        await status();
      });
      row.append(text,button); list.append(row);
    }
    if (!result.devices?.length) list.textContent='尚未绑定设备，首次使用付费功能时绑定。';
  });
  // Periodic display refresh; every paid operation independently verifies on the server.
  setInterval(() => {if (!requestBusy) status().catch(() => {});}, 60000);
  status().catch(() => {});
})();
