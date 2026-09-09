'use strict';
const statusText=document.getElementById('service-status');
const dot=document.getElementById('status-dot');
const button=document.getElementById('refresh');
async function check(){
 button.disabled=true;statusText.textContent='正在检查账号服务…';dot.className='dot';
 try{
  const res=await fetch('health',{cache:'no-store',signal:AbortSignal.timeout(7000)});
  const data=await res.json();
  if(!res.ok||data.ok!==true)throw new Error('unavailable');
  statusText.textContent='账号测试服务在线';dot.className='dot ok';
 }catch{statusText.textContent='账号服务暂不可用，请稍后重试';dot.className='dot error';}
 finally{button.disabled=false;}
}
button.addEventListener('click',check);check();
