"""Direct merchant integrations. Private keys exist on the server only.

Wechat uses API v3 Native, pinned WeChat Pay public keys, RSA-SHA256 and AES-GCM.
Alipay uses RSA2 public-key mode (not certificate mode), trade.precreate.
No redirect, screenshot or client payment status can grant an entitlement.
"""
import base64
import json
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from urllib.parse import parse_qsl

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class Payments:
    def __init__(self, config=None, transport=None):
        self.config = dict(os.environ if config is None else config)
        self.transport = transport

    def c(self, key):
        value = self.config.get(key, '')
        if not value:
            raise ValueError('payment configuration missing: ' + key)
        return value

    def available(self):
        if not self.config.get('QIYIN_PUBLIC_URL', '').startswith('https://'):
            return []
        fields = {
            'wechat': ['WECHAT_APP_ID', 'WECHAT_MCH_ID', 'WECHAT_SERIAL', 'WECHAT_PRIVATE_KEY_FILE', 'WECHAT_API_V3_KEY', 'WECHAT_PUBLIC_KEY_FILE', 'WECHAT_PUBLIC_KEY_ID'],
            'alipay': ['ALIPAY_APP_ID', 'ALIPAY_SELLER_ID', 'ALIPAY_PRIVATE_KEY_FILE', 'ALIPAY_PUBLIC_KEY_FILE'],
        }
        return [provider for provider, keys in fields.items() if all(self.config.get(k) for k in keys)]

    def key(self, provider, private=False):
        pem = Path(self.c(provider.upper() + ('_PRIVATE_KEY_FILE' if private else '_PUBLIC_KEY_FILE'))).read_bytes()
        return serialization.load_pem_private_key(pem, password=None) if private else serialization.load_pem_public_key(pem)

    def sign(self, provider, raw):
        return base64.b64encode(self.key(provider, True).sign(raw, padding.PKCS1v15(), hashes.SHA256())).decode()

    def check(self, provider, raw, signature):
        self.key(provider).verify(base64.b64decode(signature, validate=True), raw, padding.PKCS1v15(), hashes.SHA256())

    def wechat_check(self, headers, raw):
        stamp = headers['wechatpay-timestamp']
        if abs(time.time()-int(stamp)) > 300:
            raise ValueError('stale WeChat response')
        if headers['wechatpay-serial'] != self.c('WECHAT_PUBLIC_KEY_ID'):
            raise ValueError('unknown WeChat public key')
        message = stamp.encode()+b'\n'+headers['wechatpay-nonce'].encode()+b'\n'+raw+b'\n'
        self.check('wechat', message, headers['wechatpay-signature'])

    def wechat_request(self, method, path, payload=None):
        raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode() if payload is not None else b''
        stamp, nonce = str(int(time.time())), secrets.token_hex(16)
        message = f'{method}\n{path}\n{stamp}\n{nonce}\n'.encode()+raw+b'\n'
        signature = self.sign('wechat', message)
        auth = f'WECHATPAY2-SHA256-RSA2048 mchid="{self.c("WECHAT_MCH_ID")}",nonce_str="{nonce}",timestamp="{stamp}",serial_no="{self.c("WECHAT_SERIAL")}",signature="{signature}"'
        with httpx.Client(timeout=15, transport=self.transport, follow_redirects=False) as client:
            result = client.request(method, 'https://api.mch.weixin.qq.com'+path, content=raw,
                                    headers={'Authorization': auth, 'Accept': 'application/json', 'Content-Type': 'application/json', 'Wechatpay-Serial': self.c('WECHAT_PUBLIC_KEY_ID')})
        self.wechat_check(dict(result.headers), result.content)
        result.raise_for_status()
        return result.json()

    def alipay_request(self, method, payload):
        params = {'app_id': self.c('ALIPAY_APP_ID'), 'method': method, 'format': 'JSON', 'charset': 'utf-8', 'sign_type': 'RSA2', 'timestamp': datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d %H:%M:%S'), 'version': '1.0', 'biz_content': json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}
        if method == 'alipay.trade.precreate':
            params['notify_url'] = self.c('QIYIN_PUBLIC_URL').rstrip('/')+'/payments/alipay/notify'
        params['sign'] = self.sign('alipay', '&'.join(f'{k}={v}' for k,v in sorted(params.items()) if v != '').encode())
        gateway = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do' if self.config.get('ALIPAY_SANDBOX') == '1' else 'https://openapi.alipay.com/gateway.do'
        with httpx.Client(timeout=15, transport=self.transport, follow_redirects=False) as client:
            response = client.post(gateway, data=params)
        response.raise_for_status()
        text = response.content.decode('utf-8')
        root = json.loads(text)
        name = method.replace('.', '_')+'_response'
        match = re.search('"'+name+'"\\s*:\\s*', text)
        if not match:
            raise ValueError('missing Alipay response')
        # Verify exact JSON bytes, not re-serialized data (escaping and whitespace matter).
        body, end = json.JSONDecoder().raw_decode(text[match.end():])
        self.check('alipay', text[match.end():match.end()+end].encode(), root['sign'])
        if body.get('code') != '10000':
            raise ValueError('Alipay request rejected')
        return body

    def create(self, provider, oid, amount, title):
        if provider not in self.available():
            raise ValueError('provider not configured')
        if provider == 'wechat':
            response = self.wechat_request('POST', '/v3/pay/transactions/native', {
                'appid': self.c('WECHAT_APP_ID'), 'mchid': self.c('WECHAT_MCH_ID'), 'description': '期音上传器 '+title,
                'out_trade_no': oid, 'notify_url': self.c('QIYIN_PUBLIC_URL').rstrip('/')+'/payments/wechat/notify',
                'time_expire': (datetime.now(timezone.utc)+timedelta(minutes=15)).isoformat(),
                'amount': {'total': amount, 'currency': 'CNY'}})
            return response['code_url']
        response = self.alipay_request('alipay.trade.precreate', {'out_trade_no': oid, 'total_amount': f'{amount//100}.{amount%100:02d}', 'subject': '期音上传器 '+title, 'timeout_express': '15m'})
        if response['out_trade_no'] != oid:
            raise ValueError('order mismatch')
        return response['qr_code']

    def normalize_wechat(self, data):
        if data.get('mchid') != self.c('WECHAT_MCH_ID') or data.get('appid') != self.c('WECHAT_APP_ID'):
            raise ValueError('merchant mismatch')
        if data.get('trade_state') != 'SUCCESS':
            return None
        amount = data['amount']
        if amount.get('currency') != 'CNY' or type(amount.get('total')) is not int:
            raise ValueError('currency or amount mismatch')
        return {'order_id': data['out_trade_no'], 'amount': amount['total'], 'transaction_id': data['transaction_id']}

    def normalize_alipay(self, data):
        amount = Decimal(data['total_amount'])*100
        if not amount.is_finite() or amount != amount.to_integral_value():
            raise ValueError('invalid amount')
        return {'order_id': data['out_trade_no'], 'amount': int(amount), 'transaction_id': data['trade_no']}

    def verify(self, provider, headers, raw):
        if provider not in self.available():
            raise ValueError('provider not configured')
        if provider == 'wechat':
            self.wechat_check(headers, raw)
            notification = json.loads(raw)
            resource = notification['resource']
            if notification.get('event_type') != 'TRANSACTION.SUCCESS' or resource['algorithm'] != 'AEAD_AES_256_GCM':
                raise ValueError('unexpected event')
            value = AESGCM(self.c('WECHAT_API_V3_KEY').encode()).decrypt(resource['nonce'].encode(), base64.b64decode(resource['ciphertext'], validate=True), resource.get('associated_data', '').encode())
            return self.normalize_wechat(json.loads(value))
        pairs = parse_qsl(raw.decode('utf-8'), keep_blank_values=True, max_num_fields=100)
        data = dict(pairs)
        if len(data) != len(pairs) or data.get('sign_type') != 'RSA2':
            raise ValueError('ambiguous or unsupported signature')
        signed = '&'.join(f'{k}={v}' for k,v in sorted(data.items()) if k not in ('sign','sign_type') and v != '').encode()
        self.check('alipay', signed, data['sign'])
        if data.get('app_id') != self.c('ALIPAY_APP_ID') or data.get('seller_id') != self.c('ALIPAY_SELLER_ID'):
            raise ValueError('merchant mismatch')
        if data.get('trade_status') not in ('TRADE_SUCCESS', 'TRADE_FINISHED'):
            return None
        return self.normalize_alipay(data)

    def query(self, provider, oid):
        """Admin reconciliation for a missed callback. Still verifies platform response."""
        if not re.fullmatch('[0-9a-f]{32}', oid):
            raise ValueError('invalid order')
        if provider == 'wechat':
            data = self.wechat_request('GET', f'/v3/pay/transactions/out-trade-no/{oid}?mchid={self.c("WECHAT_MCH_ID")}')
            event = self.normalize_wechat(data)
        else:
            data = self.alipay_request('alipay.trade.query', {'out_trade_no': oid})
            if data.get('trade_status') not in ('TRADE_SUCCESS', 'TRADE_FINISHED'):
                return None
            event = self.normalize_alipay(data)
        if event and event['order_id'] != oid:
            raise ValueError('order mismatch')
        return event
