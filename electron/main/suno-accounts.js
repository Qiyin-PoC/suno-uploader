const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

class SunoAccounts {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'suno-accounts.json');
    this.selectedId = '1';
    try { this.selectedId = this.id(JSON.parse(fs.readFileSync(this.file,'utf8')).selectedId); } catch {}
    this.pairing = null;
  }
  id(value) {
    const id = String(value);
    if (!['1','2','3'].includes(id)) throw new Error('请选择账号 1、2 或 3。');
    return id;
  }
  select(value) {
    this.selectedId = this.id(value);
    fs.mkdirSync(this.root,{recursive:true});
    fs.writeFileSync(this.file, JSON.stringify({selectedId:this.selectedId}));
    return this.snapshot();
  }
  paths(value) {
    const id = this.id(value);
    const root = id === '1' ? this.root : path.join(this.root,'suno-accounts',id);
    return {token:path.join(root,'network/current_browser_token.json'), profile:path.join(root,'browser-profile')};
  }
  info(value) {
    const id = this.id(value);
    let saved = {};
    try { saved=JSON.parse(fs.readFileSync(this.paths(id).token,'utf8')); } catch {}
    let userId = String(saved.account?.userId || '');
    if (!userId && saved.token) {
      try {userId=String(JSON.parse(Buffer.from(saved.token.split('.')[1],'base64url').toString()).sub || '')} catch {}
    }
    const displayName = [saved.account?.username, saved.account?.email].find(value => typeof value === 'string' && value.trim() && !value.trim().startsWith('user_'))?.trim() || '';
    return {displayName,id,label:`账号 ${id}`,userId,hasCredentials:Boolean(saved.token),verifiedAt:Number(saved.captured_at)||0};
  }
  snapshot() { return {selectedId:this.selectedId,accounts:['1','2','3'].map(id=>this.info(id))}; }
  env(value, workRoot) {
    const id=this.id(value), files=this.paths(id);
    return {
      GAOBAI_SUNO_ACCOUNT_ID:id,
      GAOBAI_SUNO_ACCOUNT_USER_ID:this.info(id).userId,
      GAOBAI_SUNO_TOKEN_FILE:files.token,
      GAOBAI_BROWSER_PROFILE:files.profile,
      GAOBAI_CDP_PORT:String(24922+(Number(id)-1)*2),
      GAOBAI_SUNO_WORK_DIR:id==='1'?workRoot:path.join(workRoot,`account-${id}`),
    };
  }
  async stopPairing() {
    const pending=this.pairing;
    this.pairing=null;
    if (!pending) return;
    pending.secret='';
    clearTimeout(pending.timer);
    pending.server.closeAllConnections?.();
    await new Promise(resolve=>pending.server.close(resolve));
  }
  async startPairing(value, importToken) {
    const id=this.id(value);
    await this.stopPairing();
    const pending={id,secret:crypto.randomBytes(24).toString('base64url'),busy:false,expiresAt:Date.now()+300000};
    pending.server=http.createServer(async(req,res)=>{
      const origin=String(req.headers.origin||'');
      const allowedOrigin=!origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
      if (allowedOrigin && origin) res.setHeader('Access-Control-Allow-Origin',origin);
      res.setHeader('Access-Control-Allow-Headers','content-type,x-jifeng-pairing');
      res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
      res.setHeader('Cache-Control','no-store');
      const reply=(status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body))};
      if (!allowedOrigin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host||'')) return reply(403,{ok:false});
      if (req.method==='OPTIONS') return reply(204,{});
      const supplied=Buffer.from(String(req.headers['x-jifeng-pairing']||''));
      const secret=Buffer.from(pending.secret);
      if (req.url!=='/connect' || req.method!=='POST' || !secret.length || Date.now()>pending.expiresAt ||
          supplied.length!==secret.length || !crypto.timingSafeEqual(supplied,secret)) return reply(403,{ok:false});
      if (pending.busy) return reply(409,{ok:false,message:'正在验证，请稍候。'});
      pending.busy=true;
      try {
        let raw='';
        for await (const chunk of req) {
          raw+=chunk.toString('utf8');
          if (Buffer.byteLength(raw)>65536) return reply(413,{ok:false});
        }
        const result=await importToken(id,JSON.parse(raw));
        if (!result?.ok) return reply(400,{ok:false,message:'Suno 登录验证未通过，请重新登录后连接。'});
        pending.secret='';
        reply(200,{ok:true,accountId:id});
        setImmediate(()=>this.stopPairing().catch(()=>{}));
      } catch (_) {
        reply(400,{ok:false,message:'连接失败，请确认 Suno 登录状态与网络后重试。'});
      } finally {pending.busy=false;}
    });
    pending.server.requestTimeout=10000;
    await new Promise((resolve,reject)=>{pending.server.once('error',reject);pending.server.listen(0,'127.0.0.1',resolve)});
    this.pairing=pending;
    pending.timer=setTimeout(()=>this.stopPairing().catch(()=>{}),300000);
    pending.timer.unref?.();
    return {ok:true,accountId:id,code:`${pending.server.address().port}:${pending.secret}`,expiresAt:pending.expiresAt};
  }
}
module.exports={SunoAccounts};
