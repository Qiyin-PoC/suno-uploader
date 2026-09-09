'use strict';
const $ = id => document.getElementById(id);
const {invoke} = window.__TAURI__.core;
function openAccount() {
  $('account-dialog').hidden=false;
  $('email').focus();
}
function closeAccount() {
  $('account-dialog').hidden=true;
  $('show-account').focus();
}
$('account-dialog').addEventListener('keydown',e=>{
  if(e.key==='Escape'){e.preventDefault();closeAccount();}
  if(e.key==='Tab'){
    const fields=[...$('account-dialog').querySelectorAll('button,input')].filter(el=>!el.disabled);
    const first=fields[0],last=fields[fields.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
    if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  }
});
let busy = false;
let resultLines = [];
let finishTask=null, activeItem=null, stopRequested=false;
let queues={upload:[],download:[]}, downloadKey='';
function notice(text, error=false) { $('notice').textContent=text; $('notice').classList.toggle('error',error); }
function setBusy(value) {
  busy=value;
  for (const id of ['suno-login','upload-start','download-start','lyrics-start','history-refresh','pick-audio','pick-folder','upload-retry','download-retry','upload-resume','download-resume','title','url','format']) $(id).disabled=value;
  $('stop').disabled=!value;
  if(!value)$('title').disabled=queues.upload.length>1;
}
function log(text) { resultLines.push(text); resultLines=resultLines.slice(-12); $('result').textContent=resultLines.join('\n'); }
function executeTask(task) {
  return new Promise(resolve=>{
    finishTask=resolve;
    invoke('start',{task}).then(()=>{
      if(stopRequested)invoke('cancel').catch(e=>notice(String(e),true));
    }).catch(e=>{finishTask=null;resolve({status:'failed',message:String(e),fatal:true});});
  });
}
async function run(task) {
  if(busy)return;
  setBusy(true);stopRequested=false;resultLines=[];$('result').textContent='';
  $('job-status').textContent=task.kind==='suno_login'?'正在打开 Suno 登录浏览器…':'正在检查权限…';
  try {const r=await executeTask(task);$('job-status').textContent=r.message||r.status;notice(r.message||({'succeeded':'任务完成','failed':'任务未完成','cancelled':'任务已停止'}[r.status]),r.status==='failed');}
  finally{setBusy(false);}
}
function renderQueue(kind){
  const items=queues[kind],list=$(kind+'-queue');list.replaceChildren();
  const counts={succeeded:0,failed:0,pending:0,running:0,cancelled:0};
  const labels={pending:'等待中',running:'处理中',succeeded:'已完成',failed:'失败',cancelled:'已停止'};
  for(const item of items){
    counts[item.status]++;
    const li=document.createElement('li');li.className='batch-item '+item.status;
    const name=document.createElement('strong');name.textContent=item.name;
    const status=document.createElement('span');status.textContent=labels[item.status]+(typeof item.progress==='number'?' · '+Math.round(item.progress)+'%':'');
    const detail=document.createElement('p');detail.textContent=item.output||item.message||'';
    li.append(name,status,detail);list.append(li);
  }
  $(kind+'-summary').textContent=items.length?`共 ${items.length} 首 · 完成 ${counts.succeeded} · 失败 ${counts.failed} · 待处理 ${counts.pending} · 停止 ${counts.cancelled}`:'尚未添加歌曲';
}
async function runQueue(kind,mode='pending'){
  if(busy)return;
  const items=queues[kind];
  if(!items.length){notice('请先添加歌曲。',true);return;}
  const selected=items.filter(x=>mode==='retry'?x.status==='failed':mode==='resume'?['pending','cancelled'].includes(x.status):x.status==='pending');
  for(const item of selected){item.status='pending';item.output='';}
  if(!selected.length){notice('没有待处理歌曲；失败项可以点击重试。');return;}
  setBusy(true);stopRequested=false;resultLines=[];$('result').textContent='';
  try{
    await QiyinBatch.processQueue(selected,async item=>{activeItem=item;return executeTask(item.task);},()=>stopRequested,()=>renderQueue(kind));
    const failed=items.filter(x=>x.status==='failed').length;
    const pending=items.filter(x=>['pending','cancelled'].includes(x.status)).length;
    const summary=`${kind==='upload'?'上传':'下载'}队列：完成 ${items.filter(x=>x.status==='succeeded').length}/${items.length}，失败 ${failed}，未完成 ${pending}`;
    $('job-status').textContent=summary;notice(summary,failed>0);
  }finally{activeItem=null;setBusy(false);renderQueue(kind);}
}
async function account(action) {
  const message=$('account-message'); message.textContent='正在处理…';
  try {
    const value=await invoke('account',{action,email:$('email').value,password:$('password').value});
    if (value.ok===false) throw new Error(value.message||'账号操作未完成');
    message.textContent=value.message|| (action==='register'?'注册成功，请登录并联系管理员开通。':'账号验证完成');
    if (action==='login'||action==='status') {
      $('show-account').textContent=$('email').value || '期音账号';
      notice(value.valid===false?'已登录，账号尚未开通或已到期':'已登录；每次任务启动前会重新检查使用权限。');
      if(action==='login') closeAccount();
    }
    if(action==='logout') {$('show-account').textContent='登录期音账号';notice(value.message);}
  } catch(e) {message.textContent=String(e);if(action==='login')$('show-account').textContent='登录期音账号';}
  finally {if(action==='login'||action==='register')$('password').value='';}
}
for(const btn of document.querySelectorAll('.nav'))btn.addEventListener('click',()=>{
  for(const p of document.querySelectorAll('.page'))p.hidden=p.id!==btn.dataset.page;
  for(const n of document.querySelectorAll('.nav'))n.classList.toggle('active',n===btn);
  $('page-title').textContent=btn.textContent.slice(2);
});
$('show-account').onclick=()=>openAccount();
$('close-account').onclick=()=>closeAccount();
$('account-form').onsubmit=e=>{e.preventDefault();account('login');};
$('register').onclick=()=>{if($('account-form').reportValidity())account('register');};
$('account-refresh').onclick=()=>account('status');
$('logout').onclick=()=>account('logout');
for(const [id,kind,target] of [['pick-audio','audio','audio-path'],['pick-folder','folder','folder-path']])$(id).onclick=async()=>{
  if(busy)return;
  try{
    const paths=await invoke('choose',{kind});if(!paths?.length)return;
    if(kind==='folder'){$(target).textContent=paths[0];downloadKey='';return;}
    queues.upload=paths.map((path,index)=>{const name=path.split(/[\\/]/).pop().replace(/\.[^.]+$/,'');return {name,status:'pending',task:{kind:'upload',title:name,index}};});
    $(target).textContent=`已选择 ${paths.length} 首歌曲`;
    $('title').value=paths.length===1?queues.upload[0].name:'';
    $('title').disabled=paths.length>1;renderQueue('upload');
  }catch(e){notice(String(e),true);}
};
$('suno-login').onclick=()=>run({kind:'suno_login'});
$('upload-start').onclick=()=>{if(queues.upload.length===1){queues.upload[0].task.title=$('title').value;queues.upload[0].name=$('title').value||queues.upload[0].name;}runQueue('upload');};
$('download-start').onclick=()=>{
  try{
    const urls=QiyinBatch.downloadUrls($('url').value),format=$('format').value,key=JSON.stringify([urls,format,$('folder-path').textContent]);
    if(key!==downloadKey){queues.download=urls.map(url=>({name:url,status:'pending',task:{kind:'download',url,format}}));downloadKey=key;}
    renderQueue('download');runQueue('download');
  }catch(e){notice(String(e),true);}
};
for(const kind of ['upload','download']){
  $(kind+'-retry').onclick=()=>runQueue(kind,'retry');
  $(kind+'-resume').onclick=()=>runQueue(kind,'resume');
}
$('lyrics-start').onclick=()=>run({kind:'lyrics',mode:$('lyrics-mode').value,text:$('lyrics-input').value});
$('history-refresh').onclick=()=>run({kind:'history'});
$('stop').onclick=async()=>{stopRequested=true;try{await invoke('cancel');$('job-status').textContent='正在停止…';}catch(e){notice(String(e),true);}};
$('update').onclick=async()=>{try{await invoke('check_update');}catch(e){notice(String(e),true);}};
(async()=>{
  await window.__TAURI__.event.listen('worker',({payload})=>{
    if(payload.finished){
      const status=payload.status;
      const resolve=finishTask;finishTask=null;
      if(resolve)resolve({status,message:status==='succeeded'?'已完成':status==='cancelled'?'已停止':(activeItem?.message||'任务失败，请检查登录、网络或文件')});
      return;
    }
    const e=payload.event;
    if(activeItem){
      if(e.message)activeItem.message=e.message;
      if(typeof e.progress==='number')activeItem.progress=Math.max(0,Math.min(100,e.progress));
      for(const k of ['songUrl','localAudioPath','outputPath','filename'])if(e[k])activeItem.output=e[k];
      renderQueue(activeItem.task.kind);
    }
    if(e.message)$('job-status').textContent=e.message;
    if(typeof e.text==='string')$('lyrics-output').value=e.text;
    if(e.loginOk)log('Suno 登录已通过在线验证。');
    for(const k of ['songUrl','localAudioPath','outputPath','filename'])if(e[k])log(e[k]);
    if(e.type==='failed'&&e.message)log(e.message);
    if(Array.isArray(e.items)){
      $('history-list').replaceChildren();
      if(!e.items.length)$('history-list').textContent='还没有上传记录。';
      for(const item of e.items){const p=document.createElement('p');p.textContent=[item.title,item.created_at,item.status,item.url].filter(Boolean).join(' · ');$('history-list').append(p);}
    }
  });
  const v=await invoke('info');
  $('build-info').textContent=`v${v.version} · ${v.architecture}`;
  notice(v.runtime?(v.localPreview?'本机验证包 · 已内置音频引擎，使用本机测试账号服务。':'音频引擎就绪，请登录期音账号。'):'音频引擎缺失，请重新构建。',!v.runtime);
})().catch(e=>notice('初始化失败：'+String(e),true));
