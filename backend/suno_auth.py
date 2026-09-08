"""Suno credential selection and profile-scoped logout helpers."""
import base64
import json
import ntpath
import re
import shutil


def token_subject(token):
    try:
        payload = token.split('.')[1]
        return str(json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4))).get('sub') or '')
    except (ValueError, IndexError, TypeError):
        return ''


def select_verified_token(data, validate):
    candidates = list(data.get('tokenCandidates') or [])[:8]
    if data.get('token'):
        candidates.append({'token': data['token'], 'source': data.get('tokenSource', 'cookie')})
    priorities = {'clerk': 0, 'cookie': 1, 'cdp-network-cookie': 2, 'localStorage-fresh': 3}
    candidates.sort(key=lambda item: priorities.get(item.get('source'), 4))
    seen = set()
    for item in candidates:
        token = str(item.get('token') or '')
        if not token or token in seen:
            continue
        seen.add(token)
        check = validate(token)
        if check.get('ok'):
            account = {'userId': token_subject(token)}
            supplied = data.get('account') or {}
            if isinstance(supplied, dict) and supplied.get('userId') == account['userId']:
                for key in ('username', 'email'):
                    value = str(supplied.get(key) or '').strip()[:254]
                    if value and not value.startswith('user_'):
                        account[key] = value
            return {'token': token, 'tokenSource': item.get('source') or 'unknown',
                    'tokenCheck': check, 'account': account}
    raise RuntimeError('未获取到通过 Suno 在线验证的登录凭证，请确认浏览器已完成登录或检查网络。')


def matching_browser_pids(rows, profile):
    expected = ntpath.normcase(ntpath.normpath(str(profile))).rstrip('\\/')
    pids = []
    pattern = r'''(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+)))'''
    for row in rows:
        if str(row.get('Name') or '').lower() not in ('chrome.exe', 'msedge.exe', 'chromium.exe'):
            continue
        match = re.search(pattern, str(row.get('CommandLine') or ''), re.I)
        if match:
            actual = ntpath.normcase(ntpath.normpath(next(value for value in match.groups() if value))).rstrip('\\/')
            if actual == expected and int(row.get('ProcessId') or 0) > 0:
                pids.append(int(row['ProcessId']))
    return pids


def clear_login_files(root, profile, token, stop_browser):
    root, profile, token = root.resolve(), profile.resolve(), token.resolve()
    # Resolve before deleting, including junctions/symlinks. Never delete userData.
    for target in (profile, token):
        if target == root or root not in target.parents:
            raise ValueError('登录数据路径不在当前软件数据目录内，已停止清理。')
    stop_browser()
    if profile.exists():
        shutil.rmtree(profile)
    token.unlink(missing_ok=True)
