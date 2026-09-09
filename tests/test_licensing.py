import base64
import concurrent.futures
import json
import time
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from licensing.app import create_app
from licensing.payments import Payments
from licensing.store import digest

PASSWORD='a-real-test-password-42'


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv('QIYIN_PRICE_FEN', '9900')
    class Gateway:
        def available(self): return ['wechat','alipay']
        def create(self, *args): return 'weixin://test-order'
        def verify(self, *args): raise ValueError('no unsigned callbacks')
    app=create_app(tmp_path/'test.sqlite3', Gateway())
    return TestClient(app), app.state.store


def login(client, email='one@example.com', device='device-0000000001', register=True):
    payload={'email':email, 'password':PASSWORD, 'device':device}
    if register:
        assert client.post('/v1/register',json=payload).status_code==200
    response=client.post('/v1/login',json=payload)
    assert response.status_code==200, response.text
    return {'Authorization':'Bearer '+response.json()['token']}


def grant(store, email='one@example.com', seconds=3600):
    with store.connect() as db:
        db.execute('UPDATE users SET expires=? WHERE email=?', (int(time.time())+seconds,email))


def test_no_entitlement_until_authoritative_payment(setup):
    client,store=setup
    assert client.post('/v1/authorize',json={'feature':'suno_upload'}).status_code==401
    headers=login(client)
    assert not client.post('/v1/authorize',headers=headers,json={'feature':'suno_upload'}).json()['ok']
    assert client.post('/v1/orders',headers=headers,json={'plan':'standard','provider':'wechat','amount':1}).status_code==422
    order=client.post('/v1/orders',headers=headers,json={'plan':'standard','provider':'wechat'}).json()['order_id']
    for provider,amount in [('alipay',9900),('wechat',1)]:
        with pytest.raises(ValueError): store.settle(provider,order,amount,'tx-1')
    assert client.post('/payments/wechat/notify',json={'paid':True,'order_id':order}).status_code==400
    assert not client.get('/v1/session',headers=headers).json()['valid']
    # A concurrent repeated notification grants once, in the same transaction as payment recording.
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda _:store.settle('wechat',order,9900,'tx-1'),range(12)))
    with store.connect() as db:
        expires=db.execute('SELECT expires FROM users').fetchone()[0]
        assert 30*86400-10 < expires-time.time() <= 30*86400
        assert db.execute("SELECT count(*) FROM audit WHERE action='payment_settled'").fetchone()[0]==1
    assert client.post('/v1/authorize',headers=headers,json={'feature':'suno_upload'}).json()['ok']
    assert client.post('/v1/authorize',headers=headers,json={'feature':'unknown-feature'}).status_code==403
    grant(store,seconds=-1)
    assert not client.post('/v1/authorize',headers=headers,json={'feature':'suno_upload'}).json()['ok']


def test_session_storage_logout_and_disable(setup):
    client,store=setup
    headers=login(client)
    with store.connect() as db:
        row=db.execute('SELECT * FROM users').fetchone()
        assert row['password']!=PASSWORD
        assert db.execute('SELECT token FROM sessions').fetchone()[0]==digest(headers['Authorization'][7:])
    assert client.post('/v1/logout',headers=headers,json={}).status_code==200
    assert client.get('/v1/session',headers=headers).status_code==401
    headers=login(client,register=False)
    with store.connect() as db: db.execute('UPDATE users SET disabled=1')
    assert client.get('/v1/session',headers=headers).status_code==401


def test_device_cap_unbind_and_ownership(setup):
    client,store=setup
    first=login(client); grant(store)
    second=login(client,device='device-0000000002',register=False)
    third=login(client,device='device-0000000003',register=False)
    for headers in [first,second]:
        assert client.post('/v1/authorize',headers=headers,json={'feature':'suno_upload'}).json()['ok']
    assert client.post('/v1/authorize',headers=third,json={'feature':'suno_upload'}).json()['reason_code']=='device_limit'
    other=login(client,email='two@example.com',device='other-0000000001')
    client.delete('/v1/devices/device-0000000001',headers=other)
    assert client.get('/v1/session',headers=first).status_code==200
    client.delete('/v1/devices/device-0000000001',headers=third)
    assert client.get('/v1/session',headers=first).status_code==401
    assert client.post('/v1/authorize',headers=third,json={'feature':'suno_upload'}).json()['ok']
    order=client.post('/v1/orders',headers=third,json={'provider':'alipay','plan':'standard'}).json()['order_id']
    assert client.get('/v1/orders/'+order,headers=other).status_code==404


def test_password_and_payload_limits(setup):
    client,store=setup
    response=client.post('/v1/login',json={'password':'do-not-echo-me'})
    assert response.status_code==422 and 'do-not-echo-me' not in response.text
    assert client.post('/v1/login',content='x'*65537).status_code==413
    login(client)
    bad={'email':'one@example.com','password':'wrong-password-long','device':'device-0000000001'}
    for _ in range(14): assert client.post('/v1/login',json=bad).status_code==401
    assert client.post('/v1/login',json=bad).status_code==429


@pytest.fixture
def crypto_gateway(tmp_path):
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    private=tmp_path/'private.pem'; public=tmp_path/'public.pem'
    private.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    public.write_bytes(key.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo))
    config={'QIYIN_PUBLIC_URL':'https://payments.example.test','WECHAT_APP_ID':'app-w','WECHAT_MCH_ID':'merchant-w','WECHAT_SERIAL':'serial-w',
            'WECHAT_PUBLIC_KEY_ID':'PUB_KEY_ID_test','WECHAT_API_V3_KEY':'x'*32,'ALIPAY_APP_ID':'app-a','ALIPAY_SELLER_ID':'seller-a'}
    for p in ('WECHAT','ALIPAY'):
        config[p+'_PRIVATE_KEY_FILE']=str(private); config[p+'_PUBLIC_KEY_FILE']=str(public)
    return Payments(config), key


def wechat_payload(gateway, data, stamp=None):
    nonce='123456789012'
    ciphertext=AESGCM(b'x'*32).encrypt(nonce.encode(),json.dumps(data).encode(),b'transaction')
    raw=json.dumps({'event_type':'TRANSACTION.SUCCESS','resource':{'algorithm':'AEAD_AES_256_GCM','nonce':nonce,'associated_data':'transaction','ciphertext':base64.b64encode(ciphertext).decode()}}).encode()
    stamp=str(stamp or int(time.time()))
    signed=stamp.encode()+b'\nnonce\n'+raw+b'\n'
    headers={'wechatpay-timestamp':stamp,'wechatpay-nonce':'nonce','wechatpay-serial':'PUB_KEY_ID_test','wechatpay-signature':gateway.sign('wechat',signed)}
    return headers,raw


def alipay_payload(gateway, data):
    data={**data,'sign_type':'RSA2'}
    signed='&'.join(f'{k}={v}' for k,v in sorted(data.items()) if k!='sign_type' and v!='').encode()
    data['sign']=gateway.sign('alipay',signed)
    return urlencode(data).encode()


def test_wechat_signature_decryption_and_merchant(crypto_gateway):
    gateway,key=crypto_gateway
    data={'appid':'app-w','mchid':'merchant-w','trade_state':'SUCCESS','amount':{'total':9900,'currency':'CNY'},'out_trade_no':'order','transaction_id':'tx'}
    headers,raw=wechat_payload(gateway,data)
    assert gateway.verify('wechat',headers,raw)['amount']==9900
    for headers2,raw2 in [(headers,raw+b' '),({**headers,'wechatpay-serial':'wrong'},raw),wechat_payload(gateway,data,int(time.time())-3600),wechat_payload(gateway,{**data,'mchid':'other'})]:
        with pytest.raises(Exception): gateway.verify('wechat',headers2,raw2)


def test_alipay_signature_amount_and_merchant(crypto_gateway):
    gateway,key=crypto_gateway
    data={'app_id':'app-a','seller_id':'seller-a','total_amount':'99.00','trade_status':'TRADE_SUCCESS','out_trade_no':'order','trade_no':'tx'}
    raw=alipay_payload(gateway,data)
    assert gateway.verify('alipay',{},raw)['amount']==9900
    for bad in [raw.replace(b'99.00',b'0.01'),raw+b'&total_amount=99.00',alipay_payload(gateway,{**data,'seller_id':'other'}),alipay_payload(gateway,{**data,'total_amount':'0.001'})]:
        with pytest.raises(Exception): gateway.verify('alipay',{},bad)


@pytest.mark.parametrize('provider',['wechat','alipay'])
def test_signed_callback_end_to_end(tmp_path,crypto_gateway,provider):
    gateway,key=crypto_gateway
    app=create_app(tmp_path/'signed.sqlite3',gateway)
    client=TestClient(app); headers=login(client)
    store=app.state.store
    with store.connect() as db:
        uid=db.execute('SELECT id FROM users').fetchone()[0]
        db.execute('INSERT INTO orders(id,user_id,provider,amount,days,state,created) VALUES(?,?,?,?,?,?,?)',('order',uid,provider,9900,30,'pending',int(time.time())))
    if provider=='wechat':
        callback_headers,raw=wechat_payload(gateway,{'appid':'app-w','mchid':'merchant-w','trade_state':'SUCCESS','amount':{'total':9900,'currency':'CNY'},'out_trade_no':'order','transaction_id':'tx'})
    else:
        callback_headers={}
        raw=alipay_payload(gateway,{'app_id':'app-a','seller_id':'seller-a','total_amount':'99.00','trade_status':'TRADE_SUCCESS','out_trade_no':'order','trade_no':'tx'})
    for _ in range(2):
        response=client.post('/payments/'+provider+'/notify',headers=callback_headers,content=raw)
        assert response.status_code in (200,204), response.text
    assert client.post('/v1/authorize',headers=headers,json={'feature':'suno_upload'}).json()['valid']

@pytest.mark.parametrize('provider',['wechat','alipay'])
def test_signed_order_creation_request_and_response(crypto_gateway,provider):
    import httpx
    gateway,key=crypto_gateway
    oid='a'*32
    def handler(request):
        if provider=='wechat':
            payload=json.loads(request.content)
            assert payload['amount']=={'total':9900,'currency':'CNY'}
            assert payload['out_trade_no']==oid
            assert payload['notify_url']=='https://payments.example.test/payments/wechat/notify'
            import re
            fields=dict(re.findall(r'(\w+)="([^"]+)"',request.headers['authorization']))
            signed=f'POST\n/v3/pay/transactions/native\n{fields["timestamp"]}\n{fields["nonce_str"]}\n'.encode()+request.content+b'\n'
            gateway.check('wechat',signed,fields['signature'])
            raw=b'{"code_url":"weixin://official-signed-test"}'
            stamp=str(int(time.time()))
            headers={'wechatpay-timestamp':stamp,'wechatpay-nonce':'response','wechatpay-serial':'PUB_KEY_ID_test','wechatpay-signature':gateway.sign('wechat',stamp.encode()+b'\nresponse\n'+raw+b'\n')}
            return httpx.Response(200,content=raw,headers=headers)
        from urllib.parse import parse_qsl
        data=dict(parse_qsl(request.content.decode()))
        gateway.check('alipay','&'.join(f'{k}={v}' for k,v in sorted(data.items()) if k!='sign').encode(),data['sign'])
        assert json.loads(data['biz_content'])['total_amount']=='99.00'
        assert data['notify_url']=='https://payments.example.test/payments/alipay/notify'
        raw=json.dumps({'code':'10000','out_trade_no':oid,'qr_code':'https://qr.alipay.com/test-only'},separators=(',',':'))
        response='{"alipay_trade_precreate_response":'+raw+',"sign":'+json.dumps(gateway.sign('alipay',raw.encode()))+'}'
        return httpx.Response(200,content=response.encode())
    gateway.transport=httpx.MockTransport(handler)
    assert gateway.create(provider,oid,9900,'标准版')
    def bad(request): return httpx.Response(200,json={'code_url':'attacker'})
    gateway.transport=httpx.MockTransport(bad)
    with pytest.raises(Exception): gateway.create(provider,oid,9900,'标准版')


def test_admin_login_name_does_not_relax_registration(setup):
    from licensing.store import password_hash
    client, store = setup
    payload = {'email': 'demo_user', 'password': 'shortpw', 'device': 'device-0000000001'}
    assert client.post('/v1/register', json=payload).status_code == 422
    assert client.post('/v1/register', json={**payload, 'email': 'demo@example.com'}).status_code == 422
    with store.connect() as db:
        db.execute('INSERT INTO users(id,email,password,expires) VALUES(?,?,?,?)',
                   ('admin-demo', 'demo_user', password_hash('shortpw'), int(time.time())+3600))
    response = client.post('/v1/login', json=payload)
    assert response.status_code == 200 and response.json()['valid']
    assert client.post('/v1/login', json={**payload, 'password': 'wrong'}).status_code == 401
