'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const locked = (message = '请登录期音账号', code = 'account_not_logged_in') => ({ok:false, valid:false, loggedIn:false, reason_code:code, message});
function trustedBase(value, packaged) {
  if (!value) return '';
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('授权服务必须使用不带路径的 HTTPS 域名');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && !packaged && url.protocol === 'http:')) throw new Error('授权服务必须使用 HTTPS');
  return url.origin;
}
class CommercialClient {
  constructor({dataDir, baseUrl, packaged=false, safeStorage, request=globalThis.fetch}) {
    this.base = trustedBase(baseUrl, packaged);
    this.storage = safeStorage;
    this.request = request;
    this.token = '';
    this.generation = 0;
    this.file = path.join(dataDir, 'qiyin-session.enc');
    fs.mkdirSync(dataDir, {recursive:true});
    const deviceFile = path.join(dataDir, 'qiyin-device-id');
    try { this.device = fs.readFileSync(deviceFile, 'utf8').trim(); } catch {}
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(this.device || '')) {
      this.device = crypto.randomUUID();
      fs.writeFileSync(deviceFile, this.device, {mode:0o600});
    }
    try {
      if (this.canPersist()) {
        const saved = JSON.parse(this.storage.decryptString(fs.readFileSync(this.file)));
        // Tokens are never sent to a newly configured service.
        if (saved.base === this.base) this.token = saved.token || '';
      }
    } catch { /* Corrupt or unavailable OS keychain: require login. */ }
  }
  canPersist() {
    return Boolean(this.storage?.isEncryptionAvailable() && this.storage.getSelectedStorageBackend?.() !== 'basic_text');
  }
  clear() {
    this.generation++;
    this.token = '';
    try { fs.unlinkSync(this.file); } catch {}
  }
  async call(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
    if (!this.base) return locked('账号服务尚未配置，请联系发行方', 'service_unconfigured');
    const generation = this.generation;
    try {
      const response = await this.request(this.base+endpoint, {method, redirect:'error', signal:AbortSignal.timeout(20000),
        headers:{'Content-Type':'application/json', ...(this.token ? {Authorization:'Bearer '+this.token} : {})},
        ...(body !== undefined ? {body:JSON.stringify(body)} : {})});
      const text = await response.text();
      if (text.length > 65536) throw new Error('Oversized response');
      const result = JSON.parse(text);
      if (generation !== this.generation) return locked('账号状态已改变，请重试');
      if (response.status === 401) this.clear();
      if (!response.ok) return {...locked(result.message || '账号服务暂时不可用'), reason_code: response.status === 401 ? 'account_not_logged_in' : 'request_failed'};
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid response');
      return result;
    } catch {
      return locked('无法连接账号服务，请检查网络后重试', 'license_network_error');
    }
  }
  async login(payload) {
    this.clear();
    const result = await this.call('/v1/login', {email:String(payload?.email || ''), password:String(payload?.password || ''), device:this.device, name:process.platform+' '+process.arch});
    if (result.ok && typeof result.token === 'string') {
      this.token = result.token;
      const {token, ...publicResult} = result;
      let remembered = false;
      if (this.canPersist()) {
        try {
          const temp = this.file+'.tmp';
          fs.writeFileSync(temp, this.storage.encryptString(JSON.stringify({base:this.base,token})), {mode:0o600});
          fs.renameSync(temp, this.file);
          remembered = true;
        } catch { /* Keep session in memory if keychain or filesystem fails. */ }
      }
      return {...publicResult, remembered};
    }
    return result;
  }
  register(payload) {
    return this.call('/v1/register', {email:String(payload?.email || ''), password:String(payload?.password || ''), device:this.device, name:process.platform+' '+process.arch});
  }
  status() { return this.token ? this.call('/v1/session') : Promise.resolve(locked()); }
  async authorize(feature) {
    if (!this.token) return locked();
    const result = await this.call('/v1/authorize', {feature});
    const valid = result.ok === true && result.valid === true;
    return {...result, ok:valid, valid, needActivate:!valid};
  }
  async logout() {
    const result = await this.call('/v1/logout', {});
    this.clear();
    return {...locked(result.ok ? '已退出登录' : '本机已退出；服务端会话未能撤销，可在其他设备移除此设备'), ok:true};
  }
}
module.exports = {CommercialClient, trustedBase};
