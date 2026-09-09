// Optional integration against the local QA service. Never uses customer accounts.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {CommercialClient}=require('../electron/main/commercial-client');
test('real HTTP desktop client register/login/unpaid/logout', {skip:!process.env.QIYIN_TEST_URL},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qiyin-http-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const client=new CommercialClient({dataDir:dir,baseUrl:process.env.QIYIN_TEST_URL});
  const input={email:`test-${Date.now()}@example.test`,password:'Qiyin-test-password-2026'};
  assert.equal((await client.register(input)).ok,true);
  const result=await client.login(input);
  assert.equal(result.loggedIn,true);
  assert.equal(result.valid,false);
  assert.equal(result.token,undefined);
  assert.equal((await client.status()).loggedIn,true);
  assert.equal((await client.authorize('suno_upload')).ok,false);
  await client.logout();
  assert.equal((await client.status()).loggedIn,false);
});
