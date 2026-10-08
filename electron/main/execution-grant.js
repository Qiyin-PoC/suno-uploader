const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PUBLIC_KEYS = Object.freeze({
  'jfmh-202609-v1': 'e8115898d1b2163e3129e1c1ecdff0f3bdf67bc4fa339c5fb0b2e614d86f05b7',
});

function verifyGrant(token, session, now = Date.now()/1000) {
  if (typeof token !== 'string' || token.length > 8192 || !/^[\w-]+\.[\w-]+$/.test(token)) throw new Error('execution_grant_invalid');
  const [payload, signature] = token.split('.');
  const decodedPayload = Buffer.from(payload, 'base64url');
  const decodedSignature = Buffer.from(signature, 'base64url');
  if (decodedPayload.toString('base64url') !== payload || decodedSignature.toString('base64url') !== signature)
    throw new Error('execution_grant_invalid');
  const c = JSON.parse(decodedPayload.toString('utf8'));
  const rawKey = PUBLIC_KEYS[c.kid];
  if (!rawKey) throw new Error('execution_grant_invalid');
  const key = crypto.createPublicKey({format:'der', type:'spki', key:Buffer.from('302a300506032b6570032100'+rawKey, 'hex')});
  if (!crypto.verify(null, Buffer.from('JFMH-EXEC-V1.'+payload), key, decodedSignature)
      || c.v !== 1 || c.app !== 'jfmhstudio' || c.sid !== session?.session_id || c.device !== session?.device_id
      || !Number.isInteger(c.iat) || !Number.isInteger(c.exp) || c.iat > now+60 || c.exp <= now
      || c.exp <= c.iat || c.exp-c.iat > 600 || !Array.isArray(c.features)) throw new Error('execution_grant_invalid');
  return c;
}

class ExecutionGrant {
  constructor(userData) {
    this.file = path.join(userData, 'execution_grant.token');
    this.token = '';
    this.claims = null;
  }
  clear() {
    this.token = ''; this.claims = null;
    try { fs.unlinkSync(this.file); } catch (_) {}
  }
  usable(session, margin = 0, feature = '') {
    try {
      const c = verifyGrant(this.token, session);
      return c.exp > Date.now()/1000 + margin && (!feature || c.features.includes(feature));
    } catch (_) { return false; }
  }
  accept(grant, session) {
    const claims = verifyGrant(grant?.token, session);
    fs.mkdirSync(path.dirname(this.file), {recursive:true});
    const temp = this.file+'.'+crypto.randomUUID()+'.tmp';
    try {
      fs.writeFileSync(temp, grant.token, {encoding:'ascii', mode:0o600, flag:'wx'});
      fs.renameSync(temp, this.file);
    } finally { try { fs.unlinkSync(temp); } catch (_) {} }
    this.token = grant.token; this.claims = claims;
  }
}
module.exports = { ExecutionGrant, verifyGrant };
