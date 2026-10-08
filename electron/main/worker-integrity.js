const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const PROTECTED = new Set(['backend','suno_download_cli','audio_editor','kugou_unlocker','qqmusic_frida_unlocker']);
const verified = new Map();
function fingerprint(file) {
  const s = fs.statSync(file, {bigint:true});
  if (!s.isFile()) throw new Error('执行组件不存在，请重新安装官方版本。');
  return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.birthtimeNs].join(':');
}

function verifyWorker(file) {
  if (!PROTECTED.has(path.basename(file).replace(/\.exe$/i, ''))) return file;
  const expected = require('./worker-manifest.json').workers[path.basename(file)];
  if (!expected) throw new Error('执行组件校验信息缺失，请重新安装官方版本。');
  const before = fingerprint(file);
  if (verified.get(file) === expected+':'+before) return file;
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024*1024);
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0,length));
  } finally { fs.closeSync(fd); }
  if (hash.digest('hex') !== expected || fingerprint(file) !== before)
    throw new Error('执行组件已被修改，请重新安装官方版本。');
  verified.set(file, expected+':'+before);
  return file;
}
module.exports = {verifyWorker};
