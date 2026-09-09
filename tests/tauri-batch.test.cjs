const {test}=require('node:test');const assert=require('node:assert/strict');
const {downloadUrls,processQueue}=require('../tauri-preview/ui/batch.js');
test('downloads reject a mixed invalid batch and deduplicate',()=>{
 const u='https://suno.com/song/abc-123';
 assert.deepEqual(downloadUrls(u+'\n\n'+u),[u]);
 for(const bad of ['https://evil.com/song/abc','https://suno.com/explore','https://suno.com@evil.com/song/abc',''])assert.throws(()=>downloadUrls(bad));
 assert.throws(()=>downloadUrls(Array.from({length:101},(_,i)=>u+i).join('\n')));
});
test('queue waits for each worker, keeps success and continues after item failure',async()=>{
 const items=[0,1,2].map(n=>({n,status:'pending'}));let running=0,order=[];
 await processQueue(items,async x=>{assert.equal(running++,0);await new Promise(r=>setTimeout(r,5));order.push(x.n);running--;return{status:x.n===1?'failed':'succeeded'};},()=>false,()=>{});
 assert.deepEqual(order,[0,1,2]);assert.deepEqual(items.map(x=>x.status),['succeeded','failed','succeeded']);
 items[1].status='pending';order=[];
 await processQueue(items,async x=>{order.push(x.n);return{status:'succeeded'};},()=>false,()=>{});
 assert.deepEqual(order,[1]);
});
test('stop prevents later uploads and launch authorization failures halt queue',async()=>{
 const items=[0,1].map(n=>({n,status:'pending'}));
 await processQueue(items,async()=>({status:'cancelled'}),()=>false,()=>{});
 assert.deepEqual(items.map(x=>x.status),['cancelled','pending']);
 items[0].status='pending';
 await processQueue(items,async()=>{throw Error('membership expired');},()=>false,()=>{});
 assert.deepEqual(items.map(x=>x.status),['failed','pending']);
});
