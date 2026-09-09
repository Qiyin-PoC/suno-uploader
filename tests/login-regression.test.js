'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {EventEmitter}=require('node:events');
// Exercise the actual registered login handler with a controlled worker, so
// missing dependencies in this route fail before a real browser is needed.
function fixture() {
  const source=fs.readFileSync(require.resolve('../electron/main/main.js'),'utf8');
  const start=source.indexOf('ipcMain.handle("app:login",');
  const end=source.indexOf('ipcMain.handle("app:logout",',start);
  const job=new EventEmitter(), events=[], starts=[];
  let handler;
  const context={currentJob:null,sunoOperation:false,
    ipcMain:{handle:(_channel,fn)=>{handler=fn;}},
    isUploadBatchActive:()=>false,
    getSunoAccounts:()=>({selectedId:'2',stopPairing:async()=>{}}),
    sunoEnv:id=>({TEST_ACCOUNT:id}),
    runBackend:(args,options)=>{starts.push({args,options});return job;},
    emitSunoAccounts:()=>events.push('accounts'),send:(...args)=>events.push(args)};
  vm.runInNewContext(source.slice(start,end),context);
  return {handler,context,job,events,starts};
}
test('Suno login starts worker for selected account and releases busy state on exit',async()=>{
  const f=fixture();
  assert.equal((await f.handler()).ok,true);
  assert.equal(f.starts.length,1);
  assert.equal(f.starts[0].args[0],'--login-only');
  assert.equal(f.starts[0].options.env.TEST_ACCOUNT,'2');
  assert.equal(f.context.currentJob,f.job);
  assert.equal(f.context.sunoOperation,false);
  assert.equal((await f.handler()).ok,false);
  f.job.emit('close',1);
  assert.equal(f.context.currentJob,null);
  assert.ok(f.events.some(e=>Array.isArray(e)&&e[1].type==='idle'));
});
test('failed worker startup unlocks login for retry',async()=>{
  const f=fixture(); f.context.runBackend=()=>{throw Error('missing runtime');};
  await assert.rejects(f.handler(),/missing runtime/);
  assert.equal(f.context.sunoOperation,false);
  assert.equal(f.context.currentJob,null);
});
