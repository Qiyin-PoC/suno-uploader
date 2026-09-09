"""Exercise a deployed account API with disposable synthetic accounts only."""
import argparse
import json
import secrets
import sqlite3
import time
import urllib.error
import urllib.request
import uuid


def run(base, database):
    email = f'smoke-{uuid.uuid4().hex}@example.test'
    password = secrets.token_urlsafe(24)
    devices = [f'cloud-qa-{uuid.uuid4().hex}' for _ in range(3)]
    uid = None
    passed = []
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(path, body=None, token=None, method=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        request = urllib.request.Request(base + path, headers=headers,
            data=json.dumps(body).encode() if body is not None else None,
            method=method or ('POST' if body is not None else 'GET'))
        try:
            with opener.open(request, timeout=15) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def check(name, condition):
        if not condition:
            raise AssertionError(name)
        passed.append(name)

    def login(device):
        status, value = call('/v1/login', {'email': email, 'password': password, 'device': device, 'name': 'Disposable cloud QA'})
        check('login-' + str(len(passed)), status == 200 and value.get('loggedIn') is True)
        return value['token']

    def expire(value):
        with sqlite3.connect(database) as db:
            db.execute('UPDATE users SET expires=? WHERE id=? AND email=?', (value, uid, email))

    try:
        status, data = call('/health')
        check('health', status == 200 and data['ok'])
        status, _ = call('/v1/session')
        check('anonymous-denied', status == 401)
        status, data = call('/v1/register', {'email': email, 'password': password, 'device': devices[0], 'name': 'Disposable cloud QA'})
        check('register', status == 200 and data['ok'])
        with sqlite3.connect(database) as db:
            uid = db.execute('SELECT id FROM users WHERE email=?', (email,)).fetchone()[0]
        token1 = login(devices[0])
        status, data = call('/v1/authorize', {'feature': 'suno_download'}, token1)
        check('unpaid-denied', status == 200 and data['valid'] is False)
        expire(int(time.time()) + 3600)
        status, data = call('/v1/authorize', {'feature': 'suno_download'}, token1)
        check('grant-effective-without-relogin', status == 200 and data['valid'] is True)
        expire(0)
        status, data = call('/v1/authorize', {'feature': 'suno_download'}, token1)
        check('revocation-effective-without-relogin', status == 200 and data['valid'] is False)
        expire(int(time.time()) + 3600)
        token2 = login(devices[1])
        status, data = call('/v1/authorize', {'feature': 'lyrics_process'}, token2)
        check('second-device-allowed', status == 200 and data['valid'] is True)
        token3 = login(devices[2])
        status, data = call('/v1/authorize', {'feature': 'lyrics_process'}, token3)
        check('third-device-denied', status == 200 and data.get('reason_code') == 'device_limit')
        status, data = call('/v1/devices', token=token2)
        check('device-list', status == 200 and len(data['devices']) == 2)
        status, data = call('/v1/devices/' + devices[0], token=token2, method='DELETE')
        check('device-unbind', status == 200 and data['ok'])
        status, _ = call('/v1/session', token=token1)
        check('unbound-session-invalid', status == 401)
        status, data = call('/v1/logout', {}, token2)
        check('logout', status == 200 and data['ok'])
        status, _ = call('/v1/session', token=token2)
        check('logged-out-token-invalid', status == 401)
        status, data = call('/v1/plans')
        check('sales-disabled', status == 200 and data['plans'] == [] and data['providers'] == [])
        status, _ = call('/v1/orders', {'provider': 'wechat', 'plan': 'standard'}, token3)
        check('unconfigured-payment-denied', status == 503)
        print(json.dumps({'ok': True, 'passed': len(passed), 'checks': passed}, ensure_ascii=False))
    finally:
        if uid:
            with sqlite3.connect(database) as db:
                for table in ('devices', 'sessions', 'audit'):
                    db.execute(f'DELETE FROM {table} WHERE user_id=?', (uid,))
                db.execute('DELETE FROM users WHERE id=? AND email=?', (uid, email))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', default='http://127.0.0.1:8081')
    parser.add_argument('--database', required=True)
    args = parser.parse_args()
    run(args.base.rstrip('/'), args.database)
