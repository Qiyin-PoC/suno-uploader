const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const SESSION_MS=8*60*60*1000;
const MAX_BODY=65536;
const newSecret=()=>crypto.randomBytes(24).toString('base64url');
const matches=(value,secret)=>{
  const a=Buffer.from(String(value||'')),b=Buffer.from(String(secret||''));
  return b.length>0 && a.length===b.length && crypto.timingSafeEqual(a,b);
};

class SunoAccounts {
  constructor(root,{seal,unseal,onState}={}) {
    this.root=root;
    this.file=path.join(root,'suno-accounts.json');
    this.selectedId='1';
    try {this.selectedId=this.id(JSON.parse(fs.readFileSync(this.file,'utf8')).selectedId);}catch{}
    this.pairing=null;this.connections=new Map();this.records=new Map();this.states=new Map();
    this.connectionGenerations=new Map();this.restoreGeneration=0;
    this.connectionFile=path.join(root,'suno-connections.json');
    this.seal=seal;this.unseal=unseal;this.onState=onState;
  }
  id(value) {
    const id=String(value);
    if(!['1','2','3'].includes(id))throw new Error('请选择账号 1、2 或 3。');
    return id;
  }
  select(value) {
    this.selectedId=this.id(value);fs.mkdirSync(this.root,{recursive:true});
    fs.writeFileSync(this.file,JSON.stringify({selectedId:this.selectedId}));return this.snapshot();
  }
  paths(value) {
    const id=this.id(value),root=id==='1'?this.root:path.join(this.root,'suno-accounts',id);
    return {token:path.join(root,'network/current_browser_token.json'),profile:path.join(root,'browser-profile')};
  }
  info(value) {
    const id=this.id(value);let saved={};
    try{saved=JSON.parse(fs.readFileSync(this.paths(id).token,'utf8'));}catch{}
    let userId=String(saved.account?.userId||'');
    if(!userId && saved.token)try{userId=String(JSON.parse(Buffer.from(saved.token.split('.')[1],'base64url').toString()).sub||'');}catch{}
    const displayName=[saved.account?.username,saved.account?.email].find(value=>typeof value==='string' && value.trim() && !value.trim().startsWith('user_'))?.trim()||'';
    const state=this.states.get(id)||{};
    return {displayName,id,label:`账号 ${id}`,userId,loginMethod:saved.loginMethod||'browser',hasCredentials:Boolean(saved.token),verifiedAt:Number(saved.captured_at)||0,
      connectionState:state.connectionState||'saved',extensionVersion:state.extensionVersion||'',protocolVersion:state.protocolVersion||0,lastRefreshAt:state.lastRefreshAt||0};
  }
  snapshot(){return {selectedId:this.selectedId,accounts:['1','2','3'].map(id=>this.info(id))};}
  env(value,workRoot) {
    const id=this.id(value),files=this.paths(id);
    return {GAOBAI_SUNO_ACCOUNT_ID:id,GAOBAI_SUNO_ACCOUNT_USER_ID:this.info(id).userId,GAOBAI_SUNO_LOGIN_METHOD:this.info(id).loginMethod,
      GAOBAI_SUNO_TOKEN_FILE:files.token,GAOBAI_BROWSER_PROFILE:files.profile,GAOBAI_CDP_PORT:String(24922+(Number(id)-1)*2),
      GAOBAI_SUNO_WORK_DIR:id==='1'?workRoot:path.join(workRoot,`account-${id}`)};
  }
  state(id,patch) {
    this.states.set(id,{...this.states.get(id),...patch});
    try{this.onState?.(this.snapshot());}catch{}
  }
  persist() {
    if(!this.records.size){try{fs.unlinkSync(this.connectionFile);}catch{}return true;}
    if(typeof this.seal!=='function' || typeof this.unseal!=='function')return false;
    let temporary;
    try {
      const ciphertext=this.seal(JSON.stringify({version:2,connections:[...this.records.values()]}));
      if(!ciphertext || !Buffer.byteLength(ciphertext))return false;
      fs.mkdirSync(this.root,{recursive:true});temporary=`${this.connectionFile}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary,JSON.stringify({version:2,sealed:Buffer.from(ciphertext).toString('base64')}),{mode:0o600});
      fs.renameSync(temporary,this.connectionFile);return true;
    }catch{return false;}finally{if(temporary)try{fs.unlinkSync(temporary);}catch{}}
  }
  record(pending) {
    this.records.set(pending.id,{id:pending.id,port:pending.port,userId:pending.userId,reconnectSecret:pending.reconnectSecret,
      origin:pending.origin,issuedAt:pending.issuedAt,extensionVersion:pending.extensionVersion,protocolVersion:pending.protocolVersion});
    return this.persist();
  }
  async restoreConnections(refreshToken) {
    if(typeof refreshToken!=='function')return this.snapshot();
    const restoreGeneration=this.restoreGeneration;
    if(!this.records.size && typeof this.unseal==='function') {
      try {
        if(fs.statSync(this.connectionFile).size>65536)throw new Error('metadata too large');
        const saved=JSON.parse(fs.readFileSync(this.connectionFile,'utf8'));
        const decoded=JSON.parse(this.unseal(Buffer.from(saved.sealed,'base64')));
        if(decoded.version!==2 || !Array.isArray(decoded.connections) || decoded.connections.length>3)throw new Error('bad metadata');
        for(const record of decoded.connections) {
          if(!['1','2','3'].includes(record.id) || !Number.isInteger(record.port) || record.port<1024 || record.port>65535 ||
             !/^[A-Za-z0-9_-]{32}$/.test(record.reconnectSecret) || typeof record.userId!=='string' || !record.userId ||
             !Number.isFinite(record.issuedAt) || record.issuedAt<=0 || record.issuedAt>Date.now()+30000 ||
             (record.origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(record.origin)))continue;
          this.records.set(record.id,record);
        }
      }catch{}
    }
    for(const [id,record] of this.records) {
      if(restoreGeneration!==this.restoreGeneration)break;
      if(this.connections.has(id))continue;
      const connectionGeneration=this.connectionGenerations.get(id)||0;
      const saved=this.info(id);
      if(saved.userId!==record.userId || saved.loginMethod!=='extension' || !saved.hasCredentials){this.records.delete(id);this.persist();continue;}
      this.state(id,{connectionState:'reconnect_required',extensionVersion:record.extensionVersion,protocolVersion:record.protocolVersion});
      const pending={...record,secret:'',refreshSecret:'',expiresAt:0,busy:false,active:true,refreshToken};
      try{
        await this.listen(pending,record.port);
        if(restoreGeneration!==this.restoreGeneration || connectionGeneration!==(this.connectionGenerations.get(id)||0) || this.records.get(id)!==record){
          pending.active=false;pending.reconnectSecret='';
          pending.server.closeAllConnections?.();await new Promise(resolve=>pending.server.close(resolve));
          continue;
        }
        this.connections.set(id,pending);
      }
      catch{pending.active=false;pending.server?.close();}
    }
    return this.snapshot();
  }
  requestRefresh(value) {
    const id=this.id(value),pending=this.connections.get(id);
    if(!pending)return {ok:false,connectionState:this.info(id).connectionState};
    pending.requestedAt=Date.now();
    this.state(id,{connectionState:pending.refreshSecret?'refreshing':'reconnect_required'});
    pending.statusReply?.();
    return {ok:true,requestedAt:pending.requestedAt,connectionState:this.info(id).connectionState};
  }
  async stopPairing() {
    const pending=this.pairing;this.pairing=null;if(!pending)return;
    pending.active=false;pending.secret='';clearTimeout(pending.timer);
    pending.server.closeAllConnections?.();await new Promise(resolve=>pending.server.close(resolve));
  }
  async stopConnection(value,{preserve=false}={}) {
    const id=this.id(value),pending=this.connections.get(id);
    this.connectionGenerations.set(id,(this.connectionGenerations.get(id)||0)+1);
    if(!preserve){this.records.delete(id);this.persist();this.state(id,{connectionState:'saved',extensionVersion:'',protocolVersion:0,lastRefreshAt:0});}
    if(!pending)return;
    this.connections.delete(id);pending.active=false;pending.refreshSecret='';pending.reconnectSecret='';pending.statusReply?.();
    clearTimeout(pending.timer);pending.server.closeAllConnections?.();await new Promise(resolve=>pending.server.close(resolve));
  }
  async stopConnections(options={}) {
    this.restoreGeneration++;
    await Promise.all([...new Set([...this.connections.keys(),...this.records.keys()])].map(id=>this.stopConnection(id,options)));
  }
  async startPairing(value,importToken,refreshToken) {
    const id=this.id(value);await this.stopPairing();await this.stopConnection(id);
    const pending={id,secret:newSecret(),busy:false,active:true,expiresAt:Date.now()+300000,importToken,refreshToken};
    await this.listen(pending,0);this.pairing=pending;
    pending.timer=setTimeout(()=>{if(this.pairing===pending)this.stopPairing().catch(()=>{});},300000);pending.timer.unref?.();
    return {ok:true,accountId:id,code:`${pending.port}:${pending.secret}`,expiresAt:pending.expiresAt,protocolVersion:2};
  }
  rotate(pending) {
    pending.refreshSecret=newSecret();pending.expiresAt=Date.now()+SESSION_MS;pending.lastSeenAt=Date.now();clearTimeout(pending.timer);
    const check=()=>{
      if(!pending.active)return;
      if(Date.now()-pending.lastSeenAt>90000 || Date.now()>=pending.expiresAt)this.state(pending.id,{connectionState:'reconnect_required'});
      pending.timer=setTimeout(check,30000);pending.timer.unref?.();
    };
    pending.timer=setTimeout(check,30000);pending.timer.unref?.();
  }
  credentials(pending) {
    return {ok:true,accountId:pending.id,protocolVersion:2,refresh:{port:pending.port,secret:pending.refreshSecret,userId:pending.userId,expiresAt:pending.expiresAt},
      ...(pending.reconnectSecret?{reconnect:{port:pending.port,secret:pending.reconnectSecret,userId:pending.userId,issuedAt:pending.issuedAt}}:{})};
  }
  async listen(pending,port) {
    const id=pending.id;
    pending.server=http.createServer(async(req,res)=>{
      const origin=String(req.headers.origin||'');
      const allowedOrigin=(!origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) && (!pending.origin || origin===pending.origin);
      if(allowedOrigin && origin)res.setHeader('Access-Control-Allow-Origin',origin);
      res.setHeader('Access-Control-Allow-Headers','content-type,x-jifeng-pairing');res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');res.setHeader('Cache-Control','no-store');
      const reply=(status,body)=>{if(res.destroyed || res.writableEnded)return;res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
      if(!allowedOrigin || req.headers.host!==`127.0.0.1:${pending.port}`)return reply(403,{ok:false,code:'forbidden'});
      if(req.method==='OPTIONS')return reply(204,{});
      const connecting=req.url==='/connect',resuming=req.url==='/resume',status=req.url==='/status',challenge=req.url==='/challenge';
      const secret=connecting?pending.secret:resuming?pending.reconnectSecret:pending.refreshSecret;
      if(!pending.active || !['/connect','/refresh','/resume','/status','/challenge'].includes(req.url) || req.method!=='POST' ||
         (challenge?!pending.reconnectSecret:((!resuming && Date.now()>=pending.expiresAt) || !matches(req.headers['x-jifeng-pairing'],secret))))return reply(403,{ok:false,code:'reconnect_required'});
      if(pending.busy && !status && !challenge)return reply(409,{ok:false,code:'busy',message:'正在验证，请稍候。'});
      if(!status && !challenge)pending.busy=true;
      let timedOut=false;
      const timeout=setTimeout(()=>{timedOut=true;reply(408,{ok:false,code:'timeout'});req.destroy();},30000);timeout.unref?.();
      const active=()=>!timedOut && pending.active && (connecting?this.pairing===pending && Boolean(pending.secret):this.connections.get(id)===pending);
      try {
        let bytes=0;const chunks=[];
        for await(const chunk of req){bytes+=chunk.length;if(bytes>MAX_BODY){reply(413,{ok:false,code:'body_too_large'});req.destroy();return;}chunks.push(chunk);}
        const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!payload || typeof payload!=='object' || Array.isArray(payload))return reply(400,{ok:false,code:'bad_payload'});
        if(!active())return reply(403,{ok:false});
        if(challenge) {
          if(typeof payload.nonce!=='string' || !/^[a-f0-9]{64}$/.test(payload.nonce))return reply(400,{ok:false,code:'bad_nonce'});
          return reply(200,{ok:true,protocolVersion:2,proof:crypto.createHmac('sha256',pending.reconnectSecret).update(`gaobai-suno-bridge-v2:${payload.nonce}`).digest('hex')});
        }
        if(status) {
          pending.lastSeenAt=Date.now();
          if(['reconnect_required','refreshing'].includes(payload.connectionState))this.state(id,{connectionState:payload.connectionState});
          const send=()=>reply(200,{ok:pending.active,protocolVersion:2,refreshRequested:Boolean(pending.requestedAt),...this.states.get(id)});
          if(payload.wait===true && !pending.requestedAt) {
            if(pending.statusReply)return reply(409,{ok:false,code:'busy'});
            await new Promise(resolve=>{
              let wait;
              const finish=()=>{clearTimeout(wait);if(pending.statusReply===finish)pending.statusReply=null;send();resolve();};
              pending.statusReply=finish;wait=setTimeout(finish,20000);wait.unref?.();res.once('close',finish);
            });
          }else send();
          return;
        }
        if(!connecting) {
          if(payload.account?.userId!==pending.userId)return reply(409,{ok:false,code:'account_changed'});
          const saved=this.info(id);
          if(resuming && (saved.userId!==pending.userId || !saved.hasCredentials || saved.loginMethod!=='extension'))return reply(403,{ok:false,code:'revoked'});
          this.state(id,{connectionState:'refreshing'});
          const result=await pending.refreshToken(id,pending.userId,payload,active);
          if(!active())return reply(403,{ok:false,code:'revoked'});
          if(!result?.ok){this.state(id,{connectionState:'reconnect_required'});return reply(400,{ok:false,code:result?.code||'verification_failed'});}
          if(resuming)this.rotate(pending);
          pending.lastSeenAt=Date.now();pending.requestedAt=0;this.state(id,{connectionState:'connected',lastRefreshAt:Date.now()});
          return reply(200,resuming?this.credentials(pending):{ok:true});
        }
        const result=await pending.importToken(id,payload,active);
        if(!result?.ok)return reply(400,{ok:false,message:'Suno 登录验证未通过，请重新登录后连接。'});
        if(!active())return reply(403,{ok:false});
        pending.secret='';
        if(pending.refreshToken && result.account?.userId) {
          this.pairing=null;clearTimeout(pending.timer);pending.userId=result.account.userId;pending.origin=origin;pending.issuedAt=Date.now();
          pending.extensionVersion=typeof payload.extensionVersion==='string'?payload.extensionVersion.slice(0,32):'legacy';pending.protocolVersion=payload.protocolVersion===2?2:1;
          if(pending.protocolVersion===2)pending.reconnectSecret=newSecret();
          this.rotate(pending);this.connections.set(id,pending);if(pending.reconnectSecret)this.record(pending);
          this.state(id,{connectionState:'connected',extensionVersion:pending.extensionVersion,protocolVersion:pending.protocolVersion,lastRefreshAt:Date.now()});
          reply(200,this.credentials(pending));
        }else{
          reply(200,{ok:true,accountId:id});setImmediate(()=>{if(this.pairing===pending)this.stopPairing().catch(()=>{});});
        }
      }catch{
        if(!connecting && active())this.state(id,{connectionState:'reconnect_required'});
        reply(400,{ok:false,message:'连接失败，请确认 Suno 登录状态与网络后重试。'});
      }finally{clearTimeout(timeout);if(!status && !challenge)pending.busy=false;}
    });
    pending.server.requestTimeout=10000;pending.server.headersTimeout=10000;pending.server.maxConnections=8;pending.server.maxHeadersCount=32;
    await new Promise((resolve,reject)=>{pending.server.once('error',reject);pending.server.listen(port,'127.0.0.1',resolve);});
    pending.port=pending.server.address().port;
  }
}
module.exports={SunoAccounts};
