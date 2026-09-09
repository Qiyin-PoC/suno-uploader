import os
import re
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qsl

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .store import Store, FEATURES, digest, password_hash, verify_password
from .payments import Payments


class LoginCredentials(BaseModel):
    model_config = ConfigDict(extra='forbid')
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=128)
    device: str = Field(pattern=r'^[a-zA-Z0-9_-]{16,80}$')
    name: str = Field(default='Desktop', max_length=80)

    @field_validator('email')
    @classmethod
    def normalize_login(cls, value):
        return value.strip().lower()


class Credentials(LoginCredentials):
    password: str = Field(min_length=12, max_length=128)

    @field_validator('email')
    @classmethod
    def email_valid(cls, value):
        value = value.strip().lower()
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', value):
            raise ValueError('邮箱格式不正确')
        return value


class Feature(BaseModel):
    model_config = ConfigDict(extra='forbid')
    feature: str = Field(max_length=60)


class OrderRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    provider: Literal['wechat', 'alipay']
    plan: Literal['standard']


def create_app(db_path=None, payments=None):
    store = Store(db_path or os.environ.get('QIYIN_DATABASE', 'data/licensing.sqlite3'))
    gateway = payments or Payments()
    app = FastAPI(title='Qiyin Licensing', docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = store
    # Equal-cost dummy credential validation reduces account enumeration timing leaks.
    dummy = password_hash(secrets.token_urlsafe(24))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        # Pydantic default errors include input values, which can leak passwords.
        message = '注册需要有效邮箱，密码至少12位' if request.url.path == '/v1/register' else '请检查账号、密码和设备信息'
        return JSONResponse({'ok': False, 'message': message}, status_code=422)

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        return JSONResponse({'ok': False, 'valid': False, 'message': str(exc.detail)}, status_code=exc.status_code)

    @app.middleware('http')
    async def bounds(request, call_next):
        size = 0
        chunks = []
        async for chunk in request.stream():
            size += len(chunk)
            if size > 65536:
                return JSONResponse({'ok': False, 'message': '请求过大'}, status_code=413)
            chunks.append(chunk)
        request._body = b''.join(chunks)
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    def rate(request, suffix, maximum, window=300):
        ip = request.client.host if request.client else 'unknown'
        if not store.limit(ip + ':' + suffix, maximum, window):
            raise HTTPException(429, '请求过于频繁，请稍后再试')

    def bearer(request):
        value = request.headers.get('authorization', '')
        if not value.startswith('Bearer ') or len(value) > 200:
            raise HTTPException(401, '请重新登录期音账号')
        return value[7:]

    def authenticated(db, request):
        row = store.user_session(db, bearer(request))
        if row is None:
            raise HTTPException(401, '登录已过期或账号已停用，请重新登录')
        return row

    @app.get('/health')
    def health():
        with store.connect() as db:
            db.execute('SELECT 1').fetchone()
        return {'ok': True}

    @app.post('/v1/register')
    def register(payload: Credentials, request: Request):
        rate(request, 'register', 5, 3600)
        hashed = password_hash(payload.password)
        try:
            with store.connect() as db:
                uid = secrets.token_hex(16)
                db.execute('INSERT INTO users(id,email,password) VALUES(?,?,?)', (uid, payload.email, hashed))
                store.audit(db, 'register', uid, {})
        except sqlite3.IntegrityError:
            raise HTTPException(409, '无法注册，请尝试登录或联系管理员')
        return {'ok': True, 'message': '注册成功，请登录。邮箱目前仅作为登录名，未进行邮箱验证。'}

    @app.post('/v1/login')
    def login(payload: LoginCredentials, request: Request):
        rate(request, 'login', 30)
        if not store.limit('email:'+payload.email, 15):
            raise HTTPException(429, '请求过于频繁，请稍后再试')
        with store.connect() as db:
            row = db.execute('SELECT * FROM users WHERE email=?', (payload.email,)).fetchone()
        valid = verify_password(payload.password, row['password'] if row else dummy)
        if not valid or row is None or row['disabled']:
            raise HTTPException(401, '账号或密码错误，或账号已停用')
        token = secrets.token_urlsafe(48)
        with store.connect() as db:
            # Recheck after expensive password hashing to prevent racing an admin reset/disable.
            current = db.execute('SELECT * FROM users WHERE id=?', (row['id'],)).fetchone()
            if current['disabled'] or current['password'] != row['password']:
                raise HTTPException(401, '请重新登录')
            db.execute('DELETE FROM sessions WHERE expires<=? OR (user_id=? AND device=?)', (int(time.time()), row['id'], payload.device))
            db.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', (digest(token), row['id'], payload.device, payload.name, int(time.time())+604800))
            store.audit(db, 'login', row['id'], {'device': payload.device})
            result = store.profile(db, current)
        return {**result, 'token': token}

    @app.get('/v1/session')
    def status(request: Request):
        with store.connect() as db:
            return store.profile(db, authenticated(db, request))

    @app.post('/v1/logout')
    def logout(request: Request):
        with store.connect() as db:
            token = bearer(request)
            row = store.user_session(db, token)
            if row:
                db.execute('DELETE FROM sessions WHERE user_id=? AND device=?', (row['id'], row['device']))
                db.execute('DELETE FROM devices WHERE user_id=? AND device=?', (row['id'], row['device']))
                store.audit(db, 'logout', row['id'], {})
        return {'ok': True, 'valid': False, 'loggedIn': False}

    @app.post('/v1/authorize')
    def authorize(payload: Feature, request: Request):
        with store.connect() as db:
            row = authenticated(db, request)
            profile = store.profile(db, row)
            if not profile['valid']:
                return {**profile, 'ok': False, 'needActivate': True}
            if payload.feature not in FEATURES:
                raise HTTPException(403, '套餐不包含该功能')
            device = db.execute('SELECT 1 FROM devices WHERE user_id=? AND device=?', (row['id'], row['device'])).fetchone()
            count = db.execute('SELECT count(*) FROM devices WHERE user_id=?', (row['id'],)).fetchone()[0]
            if not device and count >= row['max_devices']:
                return {**profile, 'ok': False, 'valid': False, 'reason_code': 'device_limit', 'message': '设备数量已达上限，请在账号管理中移除旧设备'}
            db.execute('INSERT OR REPLACE INTO devices VALUES(?,?,?,?)', (row['id'], row['device'], row['name'], int(time.time())))
            return profile

    @app.get('/v1/devices')
    def devices(request: Request):
        with store.connect() as db:
            row = authenticated(db, request)
            devices = [dict(d) for d in db.execute('SELECT device,name,last_seen FROM devices WHERE user_id=?', (row['id'],))]
            return {'ok': True, 'devices': devices, 'current': row['device']}

    @app.delete('/v1/devices/{device}')
    def unbind(device: str, request: Request):
        rate(request, 'unbind', 10, 3600)
        with store.connect() as db:
            row = authenticated(db, request)
            db.execute('DELETE FROM devices WHERE user_id=? AND device=?', (row['id'], device))
            db.execute('DELETE FROM sessions WHERE user_id=? AND device=?', (row['id'], device))
            store.audit(db, 'unbind', row['id'], {'device': device})
        return {'ok': True}

    @app.get('/v1/plans')
    def plans():
        price = int(os.environ.get('QIYIN_PRICE_FEN', '0'))
        days = int(os.environ.get('QIYIN_PLAN_DAYS', '30'))
        return {'ok': True, 'plans': [{'id': 'standard', 'name': f'标准版 · {days}天', 'amount': price, 'days': days}] if 0 < price <= 10000000 and 0 < days <= 3660 else [], 'providers': gateway.available()}

    @app.post('/v1/orders')
    def create_order(payload: OrderRequest, request: Request):
        rate(request, 'orders', 10)
        catalog = plans()
        if not catalog['plans'] or payload.provider not in catalog['providers']:
            raise HTTPException(503, '在线支付尚未开通，请联系管理员')
        plan = catalog['plans'][0]
        oid = secrets.token_hex(16)
        with store.connect() as db:
            row = authenticated(db, request)
            db.execute('INSERT INTO orders(id,user_id,provider,amount,days,state,created) VALUES(?,?,?,?,?,?,?)', (oid, row['id'], payload.provider, plan['amount'], plan['days'], 'creating', int(time.time())))
        try:
            qr = gateway.create(payload.provider, oid, plan['amount'], plan['name'])
        except Exception:
            with store.connect() as db:
                db.execute("UPDATE orders SET state='unknown' WHERE id=? AND state='creating'", (oid,))
            raise HTTPException(502, '支付平台暂未返回订单，请稍后重试；如已付款请勿重复支付，联系管理员核对')
        with store.connect() as db:
            db.execute("UPDATE orders SET qr=?,state=CASE WHEN state='creating' THEN 'pending' ELSE state END WHERE id=?", (qr, oid))
        return {'ok': True, 'order_id': oid, 'amount': plan['amount'], 'qr': qr}

    @app.get('/v1/orders/{oid}')
    def order_status(oid: str, request: Request):
        with store.connect() as db:
            row = authenticated(db, request)
            order = db.execute('SELECT id,state,amount,provider,created FROM orders WHERE id=? AND user_id=?', (oid, row['id'])).fetchone()
            if not order:
                raise HTTPException(404, '订单不存在')
            return {'ok': True, 'order': dict(order)}

    @app.post('/payments/{provider}/notify')
    async def notify(provider: Literal['wechat', 'alipay'], request: Request):
        raw = await request.body()
        try:
            event = gateway.verify(provider, dict(request.headers), raw)
            if event:
                store.settle(provider, event['order_id'], event['amount'], event['transaction_id'])
        except Exception:
            return Response('failure', status_code=400)
        return Response('success') if provider == 'alipay' else Response(status_code=204)

    return app
