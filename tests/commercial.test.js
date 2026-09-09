'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {CommercialClient,trustedBase} = require('../electron/main/commercial-client');
const {pythonExecutable} = require('../electron/main/runtime-paths');
const {SunoDownloadController} = require('../electron/main/suno-download');
const {PersistentUploadBatchQueue} = require('../electron/main/upload-batch-queue');

function temp(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qiyin-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const response = value => new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
test('only HTTPS in packaged builds, no credential-bearing URLs', () => {
  assert.throws(()=>trustedBase('http://127.0.0.1:8800',true));
  assert.throws(()=>trustedBase('https://user:pass@example.com',false));
  assert.throws(()=>trustedBase('https://example.com/redirect',false));
  assert.equal(trustedBase('http://127.0.0.1:8800',false),'http://127.0.0.1:8800');
});
test('denies offline/unconfigured use and never exposes token to renderer', async t => {
  let calls=0;
  const client=new CommercialClient({dataDir:temp(t),baseUrl:'https://qiyin.example',request:async()=>{calls++;return response({ok:true,token:'test-session-secret',valid:true});}});
  assert.equal((await client.authorize('suno_upload')).ok,false);
  assert.equal(calls,0);
  const result=await client.login({email:'test@example.com',password:'password-long'});
  assert.equal(result.token,undefined);
  assert.equal(result.remembered,false);
  assert.equal(fs.existsSync(client.file),false);
  client.request=async()=>{throw Error('offline')};
  assert.equal((await client.authorize('suno_upload')).ok,false);
  assert.equal((await client.logout()).ok,true);
  assert.equal(client.token,'');
});
test('logout invalidates a pending authorization response', async t => {
  let done;
  const client=new CommercialClient({dataDir:temp(t),baseUrl:'https://qiyin.example',request:()=>new Promise(resolve=>{done=resolve;})});
  client.token='session';
  const waiting=client.authorize('suno_upload');
  client.clear();
  done(response({ok:true,valid:true}));
  assert.equal((await waiting).ok,false);
});
test('every action calls server, rejection does not reuse previous valid state', async t => {
  let calls=0;
  const client=new CommercialClient({dataDir:temp(t),baseUrl:'https://qiyin.example',request:async()=>response(++calls===1 ? {ok:true,valid:true} : {ok:false,valid:false})});
  client.token='session';
  assert.equal((await client.authorize('suno_upload')).ok,true);
  assert.equal((await client.authorize('suno_upload')).ok,false);
  assert.equal(calls,2);
});
for (const [platform,arch] of [['win32','x64'],['darwin','arm64'],['darwin','x64'],['linux','x64']]) {
  test(`runtime resolves ${platform}-${arch} and fails on missing packaged runtime`,()=>{
    const expected=path.join('/project','python-embed',`${platform}-${arch}`,platform==='win32'?'python.exe':'bin/python3');
    assert.equal(pythonExecutable('/project',{platform,arch,packaged:true,exists:p=>p===expected}),expected);
    assert.throws(()=>pythonExecutable('/project',{platform,arch,packaged:true,exists:()=>false}));
    assert.equal(pythonExecutable('/project',{platform,arch,packaged:false,override:'/custom/python',exists:()=>false}),'/custom/python');
  });
}
test('unpaid downloads never spawn a worker, including simultaneous clicks',async t=>{
  let spawned=0,resolve;
  const controller=new SunoDownloadController({dataDir:temp(t),defaultOutputDir:temp(t),authorize:()=>new Promise(r=>{resolve=r}),spawnProcess:()=>{spawned++;},onState:()=>{}});
  const payload={url:'https://suno.com/song/12345678-1234-1234-1234-123456789abc',format:'mp3'};
  const first=controller.start(payload);
  assert.equal((await controller.start(payload)).errorCode,'BUSY');
  resolve({ok:false,needActivate:true,message:'unpaid'});
  assert.equal((await first).ok,false);
  assert.equal(spawned,0);
  assert.equal(controller.active,null);
});
test('queue restart preserves files and requires explicit resume', t=>{
  const file=path.join(temp(t),'queue.json');
  const queue=new PersistentUploadBatchQueue(file);
  queue.replace([{audioPath:'/audio/你好.wav',title:'原曲',accountId:'2'}]);
  const id=queue.state.items[0].id;
  queue.updateItem(id,{status:'uploading',progress:50});
  queue.updateQueue({status:'running',currentItemId:id});
  const restored=new PersistentUploadBatchQueue(file);
  assert.equal(restored.state.status,'paused');
  assert.equal(restored.state.items[0].status,'pending');
  assert.equal(restored.state.items[0].accountId,'2');
});
test('batch download accepts original audio and forwards its format to the worker', async()=>{
  const {SunoDownloadBatch}=require('../electron/main/suno-download-batch');
  const calls=[];
  class Worker {
    constructor(options){this.options=options;this.outputDirectory='/tmp';}
    snapshot(){return {ok:true};}
    async start(payload){calls.push(payload);this.options.onState({status:'succeeded',filename:'original.m4a'});return {taskId:'test'};}
  }
  const batch=new SunoDownloadBatch({},Worker,value=>value);
  const result=await batch.start({url:'https://suno.com/song/test',format:'m4a'});
  assert.equal(result.ok,true);
  await batch.active?.done;
  assert.equal(calls[0].format,'m4a');
  assert.equal(batch.snapshot().status,'succeeded');
});
