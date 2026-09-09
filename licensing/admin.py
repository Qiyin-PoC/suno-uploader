"""Run on the server, via authenticated SSH. No public administrator endpoint."""
import argparse
import getpass
import json
import os
import time
from .store import Store, password_hash
from .payments import Payments


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--database', default=os.environ.get('QIYIN_DATABASE', 'data/licensing.sqlite3'))
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('grant', 'revoke', 'disable', 'enable', 'reset-password', 'inspect'):
        sub = commands.add_parser(name)
        sub.add_argument('email')
        if name == 'grant':
            sub.add_argument('--days', type=int, required=True)
        if name != 'inspect':
            sub.add_argument('--reason', required=True)
    reconcile = commands.add_parser('reconcile')
    reconcile.add_argument('order_id')
    args = parser.parse_args()
    store = Store(args.database)
    if args.command == 'reconcile':
        with store.connect() as db:
            order = db.execute('SELECT * FROM orders WHERE id=?', (args.order_id,)).fetchone()
        if not order:
            parser.error('订单不存在')
        event = Payments().query(order['provider'], args.order_id)
        if event:
            store.settle(order['provider'], event['order_id'], event['amount'], event['transaction_id'])
        print('已确认支付并开通' if event else '支付尚未成功')
        return
    hashed = None
    if args.command == 'reset-password':
        password = getpass.getpass('新密码（至少12位）: ')
        if not 12 <= len(password) <= 128 or password != getpass.getpass('再次输入: '):
            parser.error('密码长度不正确或两次不一致')
        hashed = password_hash(password)
    if args.command == 'grant' and not 1 <= args.days <= 3660:
        parser.error('days must be 1..3660')
    with store.connect() as db:
        user = db.execute('SELECT * FROM users WHERE email=?', (args.email.strip().lower(),)).fetchone()
        if not user:
            parser.error('账号不存在，请用户先注册')
        uid = user['id']
        if args.command == 'inspect':
            print(json.dumps({'account': {k:user[k] for k in ('id','email','disabled','expires','max_devices')}, 'orders': [dict(r) for r in db.execute('SELECT id,state,provider,amount,created FROM orders WHERE user_id=? ORDER BY created DESC LIMIT 30', (uid,))]}, ensure_ascii=False, indent=2))
            return
        if args.command == 'grant':
            db.execute('UPDATE users SET expires=? WHERE id=?', (max(int(time.time()), user['expires'])+args.days*86400, uid))
        elif args.command == 'revoke':
            db.execute('UPDATE users SET expires=0 WHERE id=?', (uid,))
        elif args.command in ('disable', 'enable'):
            db.execute('UPDATE users SET disabled=? WHERE id=?', (int(args.command == 'disable'), uid))
        elif hashed:
            db.execute('UPDATE users SET password=? WHERE id=?', (hashed, uid))
        if args.command in ('disable','reset-password'):
            db.execute('DELETE FROM sessions WHERE user_id=?', (uid,))
            db.execute('DELETE FROM devices WHERE user_id=?', (uid,))
        store.audit(db, 'admin_'+args.command, uid, {'reason': args.reason})
    print('已完成')


if __name__ == '__main__':
    main()
