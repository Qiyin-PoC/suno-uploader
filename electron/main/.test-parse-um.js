// 集成测试 - parseUmError
function parseUmError(stderr, fileName) {
  const text = String(stderr || '');
  if (/mmkv vault not loaded/i.test(text)) {
    return '❌ ' + fileName + ' 解密失败:MMKV vault 未加载。\n可能原因:\n  1. 该歌曲未在 QQ 音乐中播放过(最常见)\n  2. MMKV 路径配置错误';
  }
  if (/no any decoder can resolve/i.test(text)) {
    return '❌ ' + fileName + ' 解密失败:所有解码器都无法识别此文件格式。\n可能原因:\n  1. 这是 QQ 音乐 v20+ 加密的 .mgg/.mflac,需要 Frida 注入';
  }
  if (/wasmResult is not defined/i.test(text)) {
    return '❌ ' + fileName + ' 解密失败:WASM 模块异常。';
  }
  return text || 'um.exe 解码失败';
}

const cases = [
  ['{"error":"mmkv vault not loaded"}', 'test1.mgg', 'vault 未加载'],
  ['{"error":"no any decoder can resolve the file"}', 'test2.mflac', 'no any decoder'],
  ['ReferenceError: wasmResult is not defined', 'test3.mgg', 'wasmResult'],
  ['', 'test4.mgg', 'um.exe 解码失败'],
  ['some other error', 'test5.mgg', 'some other error'],
];
let pass = 0, fail = 0;
for (const [stderr, file, expected] of cases) {
  const result = parseUmError(stderr, file);
  if (result.includes(expected)) {
    console.log('✓ ' + expected);
    pass++;
  } else {
    console.log('✗ ' + expected + ' => ' + result.slice(0, 80));
    fail++;
  }
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);