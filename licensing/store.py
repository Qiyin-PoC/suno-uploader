"""SQLite authority for users, sessions, devices and paid entitlements."""
import hashlib
import hmac
import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

FEATURES = {'suno_upload', 'suno_download', 'lyrics_process'}


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    value = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return salt + ':' + value


def verify_password(password, stored):
    return hmac.compare_digest(password_hash(password, stored.split(':')[0]), stored)


class Store:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,expires INTEGER NOT NULL DEFAULT 0,max_devices INTEGER NOT NULL DEFAULT 2);
            CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),device TEXT NOT NULL,name TEXT NOT NULL,expires INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS devices(user_id TEXT REFERENCES users(id),device TEXT,name TEXT,last_seen INTEGER,PRIMARY KEY(user_id,device));
            CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),provider TEXT NOT NULL,amount INTEGER NOT NULL,days INTEGER NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,transaction_id TEXT,qr TEXT,UNIQUE(provider,transaction_id));
            CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,created INTEGER,action TEXT,user_id TEXT,detail TEXT);
            CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY,start INTEGER,count INTEGER);
            CREATE INDEX IF NOT EXISTS session_user ON sessions(user_id);
            ''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        try:
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def audit(self, db, action, uid, detail):
        db.execute('INSERT INTO audit(created,action,user_id,detail) VALUES(?,?,?,?)',
                   (int(time.time()), action, uid, json.dumps(detail, ensure_ascii=False)))

    def limit(self, key, maximum, window=300):
        now = int(time.time())
        with self.connect() as db:
            db.execute('DELETE FROM limits WHERE start<?', (now-86400,))
            row = db.execute('SELECT * FROM limits WHERE key=?', (digest(key),)).fetchone()
            start, count = (row['start'], row['count']) if row and row['start'] > now-window else (now, 0)
            db.execute('INSERT OR REPLACE INTO limits VALUES(?,?,?)', (digest(key), start, count+1))
        return count < maximum

    def user_session(self, db, token):
        row = db.execute('SELECT u.*,s.device,s.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?',
                         (digest(token), int(time.time()))).fetchone()
        return row if row and not row['disabled'] else None

    def profile(self, db, row):
        if row is None:
            return {'ok': False, 'loggedIn': False, 'valid': False, 'reason_code': 'account_not_logged_in', 'message': '请登录期音账号'}
        active = row['expires'] > time.time()
        return {'ok': True, 'loggedIn': True, 'valid': active, 'user': {'id': row['id'], 'email': row['email']},
                'expires_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(row['expires'])) if row['expires'] else None,
                'reason_code': 'active' if active else 'membership_required',
                'message': '授权有效' if active else '尚未开通或授权已到期', 'max_devices': row['max_devices']}

    def settle(self, provider, order_id, amount, transaction_id):
        if not isinstance(transaction_id, str) or not transaction_id or len(transaction_id) > 128:
            raise ValueError('invalid transaction')
        with self.connect() as db:
            order = db.execute('SELECT * FROM orders WHERE id=?', (order_id,)).fetchone()
            if not order or order['provider'] != provider or order['amount'] != amount:
                raise ValueError('order mismatch')
            if order['state'] == 'paid':
                if order['transaction_id'] != transaction_id:
                    raise ValueError('transaction mismatch')
                return
            if order['state'] not in ('pending', 'creating', 'unknown'):
                raise ValueError('order not payable')
            user = db.execute('SELECT * FROM users WHERE id=?', (order['user_id'],)).fetchone()
            # A late but valid payment must still be recorded, even for a disabled account.
            expires = max(int(time.time()), user['expires']) + order['days'] * 86400
            db.execute("UPDATE orders SET state='paid',transaction_id=? WHERE id=?", (transaction_id, order_id))
            db.execute('UPDATE users SET expires=? WHERE id=?', (expires, user['id']))
            self.audit(db, 'payment_settled', user['id'], {'order': order_id, 'provider': provider, 'amount': amount})
