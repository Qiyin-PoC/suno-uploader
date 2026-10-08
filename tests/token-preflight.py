import json
import os
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root / "backend"))
import backend  # noqa: E402

old_token = "o" * 100
new_token = "n" * 100
contexts = iter([
    {"token": old_token, "account": {"userId": "user-1"}, "tokenSource": "saved"},
    {"token": old_token, "account": {"userId": "user-1"}, "tokenSource": "saved"},
    {"token": new_token, "account": {"userId": "user-1"}, "tokenSource": "extension"},
])
validated = []
backend.load_saved_token = lambda: next(contexts)
backend.time.sleep = lambda _seconds: None


def validate_refresh(token, **_kwargs):
    validated.append(token)
    return {"ok": token == new_token, "status_code": 200 if token == new_token else 401,
            "reason": "token_valid" if token == new_token else "token_unauthorized"}


backend.validate_suno_token = validate_refresh
os.environ["GAOBAI_SUNO_LOGIN_METHOD"] = "extension"
refreshed = backend.prepare_suno_token(5)
if not refreshed.get("ok") or validated != [old_token, new_token]:
    raise AssertionError({"result": refreshed, "validated": validated})

for status in (429, 500, 503):
    backend.load_saved_token = lambda: {"token": old_token, "account": {}, "tokenSource": "saved"}
    backend.validate_suno_token = lambda _token, **_kwargs: {
        "ok": False, "status_code": status, "reason": f"http_{status}"
    }
    os.environ["GAOBAI_SUNO_LOGIN_METHOD"] = "extension"
    result = backend.prepare_suno_token(1)
    if result.get("code") != "network_error":
        raise AssertionError({"status": status, "result": result})

backend.validate_suno_token = lambda _token, **_kwargs: {
    "ok": False, "status_code": 403, "reason": "token_unauthorized"
}
os.environ["GAOBAI_SUNO_LOGIN_METHOD"] = "browser"
unauthorized = backend.prepare_suno_token(1)
if unauthorized.get("code") != "login_required":
    raise AssertionError(unauthorized)

print(json.dumps({"refreshRetry": refreshed["code"], "networkStatuses": [429, 500, 503],
                  "unauthorized": unauthorized["code"]}))
