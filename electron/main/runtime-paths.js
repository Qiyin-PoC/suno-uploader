'use strict';
const path = require('node:path');
const fs = require('node:fs');
function pythonExecutable(root, {platform=process.platform, arch=process.arch, packaged=false, override=process.env.QIYIN_PYTHON || process.env.GAOBAI_PYTHON, exists=fs.existsSync}={}) {
  if (override && !packaged) return override;
  const name = platform === 'win32' ? 'python.exe' : 'bin/python3';
  const candidates = [path.join(root, 'python-embed', `${platform}-${arch}`, name), path.join(root, 'python-embed', name)];
  if (!packaged) candidates.push(path.join(root, '.venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  const found = candidates.find(exists);
  if (found) return found;
  if (packaged) throw new Error('安装包缺少当前平台的 Python 运行环境，请联系发行方');
  return platform === 'win32' ? 'python' : 'python3';
}
module.exports = {pythonExecutable};
