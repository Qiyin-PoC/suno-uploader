'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {trustedBase}=require('../electron/main/commercial-client');
function check(root,platform,arch) {
  const config=require(path.join(root,'electron/commercial-config.json'));
  if (!trustedBase(config.apiOrigin,true)) throw Error('请先配置期音正式授权服务域名');
  const runtime=path.join(root,'python-embed',`${platform}-${arch}`,platform==='win32'?'python.exe':'bin/python3');
  const ffmpeg=path.join(root,'vendor/ffmpeg',`${platform}-${arch}`,platform==='win32'?'ffmpeg.exe':'ffmpeg');
  for (const file of [runtime,ffmpeg]) if (!fs.existsSync(file)) throw Error('缺少发行依赖: '+file);
}
module.exports={check};
if (require.main===module) {
  try {check(path.resolve(__dirname,'..'),process.argv[2]||process.platform,process.argv[3]||process.arch);console.log('发行依赖检查通过');}
  catch(error) {console.error(error.message);process.exitCode=1;}
}
