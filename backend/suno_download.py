"""Anonymous public Suno audio retrieval; no account/session state is consumed.

The returned bytes still require the caller's full media decode before export.
Network exceptions are deliberately reduced to codes: URLs, rights and keys must
never become customer diagnostics. Tests replace the transport, not host policy.
"""

import base64
import binascii
import errno
import hashlib
import html
from html.parser import HTMLParser
import http.client
import json
import math
import queue
import re
import select
import socket
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid


PAGE_HOSTS = frozenset(("suno.com", "www.suno.com"))
AUDIO_HOSTS = frozenset(("d2lwuy8qc234o3.cloudfront.net", "cdn1.suno.ai", "cdn2.suno.ai"))
API_HOSTS = frozenset(("studio-api-prod.suno.com", "studio-api.prod.suno.com"))
RIGHTS_URL = "https://studio-api-prod.suno.com/api/mango/rights"
MAX_PAGE_BYTES = 5 * 1024 * 1024
MAX_RIGHTS_BYTES = 16 * 1024
MAX_AUDIO_BYTES = 80 * 1024 * 1024
MAX_AUDIO_DURATION_SECONDS = 12 * 60
CONNECT_TIMEOUT = 10.0
BODY_IDLE_TIMEOUT = 20.0
PAGE_TIMEOUT = 15.0
RIGHTS_TIMEOUT = 15.0
AUDIO_TIMEOUT = 300.0
MAX_REDIRECTS = 4
MAX_RETRIES = 4
RETRY_DELAY = 0.75
MAX_RETRY_DELAY = 4.0
MAX_AUDIO_CANDIDATES = 12
MAX_TASK_REQUESTS = 32
TASK_TIMEOUT = 360.0
MAX_NETWORK_WORKERS = 2
_NETWORK_SLOTS = threading.BoundedSemaphore(MAX_NETWORK_WORKERS)
_NETWORK_LOCK = threading.Lock()
_ACTIVE_NETWORK_CONTROLS = set()
_REDIRECTS = frozenset((301, 302, 303, 307, 308))
_ID = re.compile(r"[a-zA-Z0-9_-]{6,128}\Z")
_USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
               "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.159 Safari/537.36")


class DownloadError(Exception):
    def __init__(self, code, message=None, *, no_retry=False):
        self.code = code
        self.no_retry = no_retry
        super().__init__(message or code)


def _allowed_url(value, hosts):
    if not isinstance(value, str) or not value or re.search(r"[\x00-\x20\x7f\\]", value):
        return None
    try:
        parsed = urllib.parse.urlsplit(value)
        # Reject even an explicit default port and malformed/encoded authority.
        if (parsed.scheme.lower() != "https" or parsed.username is not None
                or parsed.password is not None or ":" in parsed.netloc
                or parsed.hostname not in hosts or parsed.netloc.lower() not in hosts):
            return None
        return parsed._replace(scheme="https", netloc=parsed.netloc.lower(), fragment="")
    except (ValueError, TypeError):
        return None


def normalize_source_url(value):
    parsed = _allowed_url(value.strip() if isinstance(value, str) else "", PAGE_HOSTS)
    if parsed is None:
        return ""
    match = re.fullmatch(r"/(song|s)/([^/]+)/?", parsed.path, re.I)
    if not match or not _ID.fullmatch(match.group(2)):
        return ""
    return parsed._replace(netloc="suno.com").geturl()


def _song_id(value):
    parsed = _allowed_url(value, PAGE_HOSTS)
    if parsed is None:
        return ""
    match = re.fullmatch(r"/song/([a-zA-Z0-9_-]{6,128})/?", parsed.path, re.I)
    return match.group(1) if match else ""


def _safe_title(value, fallback="SUNO歌曲"):
    value = unicodedata.normalize("NFKC", str(value or ""))
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', " ", value)
    value = re.sub(r"\s+", " ", value).strip().rstrip(". ")
    return (value or fallback)[:120]


def _useful_title(value):
    return isinstance(value, str) and bool(value.strip()) and not re.match(
        r"^(?:https?://|(?:www\.)?suno\.com/(?:song|s)/)", value.strip(), re.I)


class _Page(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.canonical = []
        self.links = []
        self.og_title = []
        self.title = []
        self.scripts = []
        self._in_title = False
        self._script = None
        self.feed(text)
        self.close()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "link" and "canonical" in (attrs.get("rel") or "").lower().split():
            self.canonical.append(attrs.get("href") or "")
        if tag == "meta":
            prop = (attrs.get("property") or attrs.get("name") or "").lower()
            if prop == "og:url":
                self.canonical.append(attrs.get("content") or "")
            elif prop == "og:title":
                self.og_title.append(attrs.get("content") or "")
        if tag == "a":
            self.links.append(attrs.get("href") or "")
        if tag == "title":
            self._in_title = True
        if tag == "script":
            self._script = []

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag == "script" and self._script is not None:
            self.scripts.append("".join(self._script))
            self._script = None

    def handle_data(self, value):
        if self._in_title:
            self.title.append(value)
        if self._script is not None:
            self._script.append(value)


def _json_roots(text):
    """Decode JSON objects and Next.js push arrays without executing script."""
    decoder = json.JSONDecoder()
    offset = 0
    for _ in range(512):
        match = re.search(r"[\[{]", text[offset:])
        if match is None:
            return
        start = offset + match.start()
        try:
            value, end = decoder.raw_decode(text, start)
        except (ValueError, RecursionError):
            offset = start + 1
            continue
        yield value
        offset = end


def _embedded_title(texts, song_id):
    pending = [(value, 0) for text in texts for value in _json_roots(text)]
    visited = 0
    while pending and visited < 20000:
        value, depth = pending.pop()
        visited += 1
        if depth > 48:
            continue
        if isinstance(value, dict):
            if str(value.get("id", "")) == song_id and _useful_title(value.get("title")):
                return _safe_title(value["title"])
            pending.extend((item, depth + 1) for item in value.values())
        elif isinstance(value, list):
            pending.extend((item, depth + 1) for item in value)
        elif isinstance(value, str) and song_id in value and depth < 4:
            pending.extend((item, depth + 1) for item in _json_roots(value))
    return ""


def _page_song(text, final_url, original_id):
    page = _Page(text)
    final_id = _song_id(final_url)
    if original_id and final_id and original_id != final_id:
        raise DownloadError("SONG_ID_MISMATCH")
    canonical_ids = {_song_id(urllib.parse.urljoin(final_url, value)) for value in page.canonical}
    canonical_ids.discard("")
    song_id = original_id or final_id
    if len(canonical_ids) > 1 or (song_id and canonical_ids and song_id not in canonical_ids):
        raise DownloadError("SONG_ID_MISMATCH")
    if not song_id and canonical_ids:
        song_id = next(iter(canonical_ids))
    if not song_id:
        # An absolute official link wins over incidental relative page links.
        absolute_ids = {_song_id(value) for value in page.links}
        absolute_ids.discard("")
        if not absolute_ids:
            absolute_ids = {_song_id(value) for value in re.findall(r'https://[^\s"<>\\]+', text)}
            absolute_ids.discard("")
        relative_ids = {_song_id(urllib.parse.urljoin(final_url, value)) for value in page.links
                        if value.startswith("/song/")}
        ids = absolute_ids or (relative_ids - {""})
        if len(ids) == 1:
            song_id = next(iter(ids))
    if not song_id:
        raise DownloadError("UNSUPPORTED_SUNO_LINK")
    title = _embedded_title(page.scripts or [text], song_id)
    if not title:
        for value in page.og_title + ["".join(page.title)]:
            value = re.sub(r"\s+by\s+.+?\s*\|\s*Suno\s*$", "", html.unescape(value), flags=re.I)
            value = re.sub(r"\s*\|\s*Suno\s*$", "", value, flags=re.I).strip()
            if _useful_title(value):
                title = _safe_title(value)
                break
    return song_id, _safe_title(title, "SUNO-" + song_id), _audio_candidates(text, song_id)


def _audio_candidates(text, song_id):
    candidates = [
        "https://d2lwuy8qc234o3.cloudfront.net/1/clip/" + song_id + ".m4a",
        "https://cdn1.suno.ai/" + song_id + ".mp3",
        "https://cdn2.suno.ai/" + song_id + ".mp3",
    ]
    seen = set(candidates)
    normalized = text.replace("\\/", "/").replace("\\u0026", "&")
    for match in re.finditer(r'https://[^\s"\'<>\\]+', normalized, re.I):
        value = match.group()
        parsed = _allowed_url(value, AUDIO_HOSTS)
        if parsed is None:
            continue
        try:
            path = urllib.parse.unquote(parsed.path, errors="strict")
        except UnicodeError:
            continue
        if not re.search(r"/" + re.escape(song_id) + r"\.(?:m4a|mp3)$", path):
            continue
        url = parsed.geturl()
        if url not in seen:
            candidates.append(url)
            seen.add(url)
            if len(candidates) >= MAX_AUDIO_CANDIDATES:
                break
    return candidates


class _TaskBudget:
    """One budget shared by page, redirects, retries, candidates and rights."""
    def __init__(self, cancel_event):
        self.cancel_event = cancel_event
        self.deadline = time.monotonic() + TASK_TIMEOUT
        self.requests = 0
        self._lock = threading.Lock()

    def check(self):
        if self.cancel_event.is_set():
            raise DownloadError("CANCELLED")
        if time.monotonic() >= self.deadline:
            raise DownloadError("TASK_TIMEOUT", no_retry=True)

    def remaining(self):
        self.check()
        return max(0.001, self.deadline - time.monotonic())

    def request(self):
        with self._lock:
            self.check()
            if self.requests >= MAX_TASK_REQUESTS:
                raise DownloadError("TASK_REQUEST_LIMIT", no_retry=True)
            self.requests += 1


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _open_request(request, timeout):
    # Read existing proxy preferences only; never install account/cookie auth.
    control = request._download_control
    opener = urllib.request.build_opener(_proxy_handler(request), _NoRedirect(),
                                         _ControlledHTTPSHandler(control))
    try:
        return opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as response:
        return response


def _proxy_handler(request):
    """Honor HTTP CONNECT proxies for HTTPS, without silent protocol downgrade.

    Common system HTTPS proxy settings resolve to an http:// proxy URL.
    TLS-to-proxy and SOCKS need transports urllib does not provide; report these
    configurations explicitly instead of ignoring them or sending them plaintext.
    Proxy credentials stay in memory and urllib sends them only in CONNECT.
    """
    try:
        proxies = urllib.request.getproxies()
        proxy = proxies.get("https") or proxies.get("all")
        if not proxy or urllib.request.proxy_bypass(request.host):
            return urllib.request.ProxyHandler({})
        if not isinstance(proxy, str) or re.search(r"[\x00-\x20\x7f\\]", proxy):
            raise ValueError()
        if "://" not in proxy:
            proxy = "http://" + proxy
        parsed = urllib.parse.urlsplit(proxy)
        if parsed.scheme.lower() != "http":
            raise DownloadError("PROXY_UNSUPPORTED", no_retry=True)
        port = parsed.port if parsed.port is not None else 80
        if (not parsed.hostname or parsed.path not in ("", "/") or parsed.query or parsed.fragment
                or "%" in parsed.hostname or not 1 <= port <= 65535):
            raise ValueError()
        for credential in (parsed.username, parsed.password):
            if credential is not None and re.search(r"[\x00-\x1f\x7f]", urllib.parse.unquote(credential)):
                raise ValueError()
        return urllib.request.ProxyHandler({"https": proxy})
    except DownloadError:
        raise
    except (ValueError, TypeError, OSError):
        raise DownloadError("PROXY_CONFIGURATION_INVALID", no_retry=True) from None


def _response_socket(response):
    try:
        return response.fp.raw._sock
    except AttributeError:
        return None


class _RequestControl:
    def __init__(self, cancel_event, timeout):
        self.cancel_event = cancel_event
        self.deadline = time.monotonic() + timeout
        self.stopped = threading.Event()
        self.response = None
        self._socket = None
        self._socket_lock = threading.Lock()

    def check(self):
        if self.cancel_event.is_set():
            raise DownloadError("CANCELLED")
        if self.stopped.is_set() or time.monotonic() >= self.deadline:
            raise DownloadError("REQUEST_TIMEOUT")

    def remaining(self):
        self.check()
        return max(0.001, self.deadline - time.monotonic())

    def abort(self):
        self.stopped.set()
        with self._socket_lock:
            sockets = (self._socket, _response_socket(self.response))
            for sock in sockets:
                if sock is not None:
                    try:
                        sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
        if hasattr(self.response, "abort"):
            self.response.abort()

    def track_socket(self, sock):
        with self._socket_lock:
            self._socket = sock
            try:
                self.check()
            except DownloadError:
                sock.close()
                raise

    def connect(self, address, timeout, source_address=None):
        # libc DNS is not cancellable. The process-wide worker limit bounds it;
        # checking immediately afterwards prevents a cancelled lookup connecting.
        self.check()
        connect_deadline = min(self.deadline, time.monotonic() + timeout)
        addresses = socket.getaddrinfo(*address, 0, socket.SOCK_STREAM)
        self.check()
        last_error = None
        for family, kind, protocol, _canonical, target in addresses:
            self.check()
            if time.monotonic() >= connect_deadline:
                raise socket.timeout()
            sock = socket.socket(family, kind, protocol)
            try:
                self.track_socket(sock)
                sock.setblocking(False)
                if source_address:
                    sock.bind(source_address)
                with self._socket_lock:
                    self.check()
                    code = sock.connect_ex(target)
                pending = (0, errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY, errno.EINTR)
                if code not in pending:
                    raise OSError(code, "connection failed")
                while code:
                    self.check()
                    remaining = connect_deadline - time.monotonic()
                    if remaining <= 0:
                        raise socket.timeout()
                    _, writable, exceptional = select.select([], [sock], [sock], min(0.05, remaining))
                    if writable or exceptional:
                        code = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
                        if code:
                            raise OSError(code, "connection failed")
                        break
                self.check()
                sock.settimeout(min(timeout, self.remaining()))
                return sock
            except OSError as exc:
                last_error = exc
                sock.close()
                self.check()
            except BaseException:
                sock.close()
                raise
        raise last_error or OSError("no addresses")


class _ControlledHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, *, control, **kwargs):
        super().__init__(host, **kwargs)
        self._control = control
        self._create_connection = control.connect

    def connect(self):
        http.client.HTTPConnection.connect(self)
        self._control.check()
        hostname = self._tunnel_host or self.host
        self.sock = self._context.wrap_socket(self.sock, server_hostname=hostname,
                                               do_handshake_on_connect=False)
        self._control.track_socket(self.sock)
        self._control.check()
        self.sock.do_handshake()
        self._control.check()


class _ControlledHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, control):
        super().__init__()
        self._control = control

    def https_open(self, request):
        return self.do_open(_ControlledHTTPSConnection, request, control=self._control,
                            context=self._context)


def _with_deadline(task, cancel_event, timeout):
    """Return promptly on cancellation/deadline, including a blocked DNS lookup.

    At most two workers may exist across all downloader instances. DNS can only
    be abandoned, not killed; its slot stays occupied until it really exits.
    TCP connect, TLS, headers and body all share the tracked abortable socket.
    """
    control = _RequestControl(cancel_event, timeout)
    control.check()
    if not _NETWORK_SLOTS.acquire(blocking=False):
        raise DownloadError("NETWORK_BUSY", no_retry=True)
    result = queue.Queue(maxsize=1)

    def run():
        try:
            result.put((True, task(control)))
        except BaseException as exc:
            result.put((False, exc))
        finally:
            with _NETWORK_LOCK:
                _ACTIVE_NETWORK_CONTROLS.discard(control)
            _NETWORK_SLOTS.release()

    worker = threading.Thread(target=run, name="suno-public-download", daemon=True)
    with _NETWORK_LOCK:
        _ACTIVE_NETWORK_CONTROLS.add(control)
    try:
        worker.start()
    except BaseException:
        with _NETWORK_LOCK:
            _ACTIVE_NETWORK_CONTROLS.discard(control)
        _NETWORK_SLOTS.release()
        raise
    try:
        while True:
            control.check()
            try:
                ok, value = result.get(timeout=min(0.05, control.remaining()))
            except queue.Empty:
                continue
            control.check()
            if ok:
                return value
            raise value
    finally:
        control.abort()
        # Normal cancellation joins the socket worker. Uninterruptible DNS keeps
        # a tracked slot, instead of creating unlimited hidden retry workers.
        worker.join(timeout=0.1)


def _retryable(error):
    if error.no_retry or error.code == "CANCELLED":
        return False
    return (error.code in ("NETWORK_ERROR", "REQUEST_TIMEOUT")
            or error.code.endswith("_IDLE_TIMEOUT")
            or bool(re.search(r"_HTTP_(?:408|425|5\d\d)$", error.code)))


def _read_body(response, control, prefix, maximum, minimum, progress):
    length_header = response.headers.get("Content-Length")
    declared = None
    if length_header is not None:
        if not re.fullmatch(r"[0-9]+", length_header.strip()) or len(length_header.strip()) > 12:
            raise DownloadError(prefix + "_LENGTH_INVALID")
        declared = int(length_header)
        if declared > maximum:
            raise DownloadError(prefix + "_TOO_LARGE")
    encoding = (response.headers.get("Content-Encoding") or "").strip().lower()
    if encoding not in ("", "identity"):
        raise DownloadError(prefix + "_CONTENT_ENCODING_INVALID")
    if response.headers.get("Transfer-Encoding") and declared is not None:
        raise DownloadError(prefix + "_LENGTH_INVALID")
    received = 0
    chunks = []
    try:
        if progress:
            control.check()
            progress(0, declared)
        while True:
            control.check()
            sock = _response_socket(response)
            if sock is not None:
                sock.settimeout(min(BODY_IDLE_TIMEOUT, control.remaining()))
            # read1 returns available bytes promptly and exposes partial transfers.
            read = getattr(response, "read1", response.read)
            partial = False
            try:
                chunk = read(min(64 * 1024, maximum - received + 1))
            except http.client.IncompleteRead as exc:
                chunk = exc.partial
                partial = True
            control.check()
            if chunk:
                received += len(chunk)
                if received > maximum:
                    raise DownloadError(prefix + "_TOO_LARGE")
                if declared is not None and received > declared:
                    raise DownloadError(prefix + "_LENGTH_MISMATCH")
                chunks.append(chunk)
                if progress:
                    control.check()
                    progress(received, declared)
            if partial:
                raise DownloadError(prefix + "_LENGTH_MISMATCH")
            if not chunk:
                break
        if declared is not None and received != declared:
            raise DownloadError(prefix + "_LENGTH_MISMATCH")
        if received < minimum:
            raise DownloadError(prefix + "_EMPTY")
        return b"".join(chunks)
    except (socket.timeout, TimeoutError):
        raise DownloadError(prefix + "_IDLE_TIMEOUT", no_retry=received > 0) from None
    except DownloadError as exc:
        exc.no_retry = exc.no_retry or received > 0
        raise
    except (OSError, http.client.HTTPException):
        raise DownloadError("NETWORK_ERROR", no_retry=received > 0) from None


class _Downloader:
    def __init__(self, transport=None):
        self._transport = transport or _open_request
        self._device_id = str(uuid.uuid4())

    def _fetch(self, url, *, kind, cancel_event, on_status, on_progress=None, data=None, budget=None):
        budget = budget or _TaskBudget(cancel_event)
        hosts, maximum, minimum, timeout = {
            "PAGE": (PAGE_HOSTS, MAX_PAGE_BYTES, 1, PAGE_TIMEOUT),
            "AUDIO": (AUDIO_HOSTS, MAX_AUDIO_BYTES, 512, AUDIO_TIMEOUT),
            "RIGHTS": (API_HOSTS, MAX_RIGHTS_BYTES, 2, RIGHTS_TIMEOUT),
        }[kind]
        for attempt in range(MAX_RETRIES + 1):
            received = [0]

            def progress(count, total):
                received[0] = count
                if on_progress:
                    on_progress(count, total)

            def request(control):
                current = url
                headers = {"User-Agent": _USER_AGENT, "Referer": "https://suno.com/",
                           "Accept-Encoding": "identity"}
                if kind == "PAGE":
                    headers["Accept"] = "text/html,application/xhtml+xml"
                elif kind == "AUDIO":
                    headers.update({"Accept": "audio/mp4,audio/mpeg,audio/*;q=0.9,application/octet-stream;q=0.8",
                                    "Origin": "https://suno.com"})
                else:
                    token = base64.b64encode(json.dumps({"timestamp": int(time.time() * 1000)},
                                             separators=(",", ":")).encode()).decode("ascii")
                    headers.update({"Accept": "application/json, text/plain, */*",
                                    "Content-Type": "application/json", "Origin": "https://suno.com",
                                    "Browser-Token": json.dumps({"token": token}, separators=(",", ":")),
                                    "Device-Id": self._device_id})
                for redirects in range(MAX_REDIRECTS + 1):
                    parsed = _allowed_url(current, hosts)
                    if parsed is None:
                        raise DownloadError(kind + "_URL_NOT_ALLOWED")
                    current = parsed.geturl()
                    response = None
                    try:
                        control.check()
                        budget.request()
                        req = urllib.request.Request(current, data=data, headers=headers,
                                                     method="POST" if data is not None else "GET")
                        req._download_control = control
                        response = self._transport(req, min(CONNECT_TIMEOUT, control.remaining()))
                        control.response = response
                        control.check()
                        if response.geturl() != current:
                            raise DownloadError(kind + "_REDIRECT_POLICY_VIOLATION")
                        status = response.status
                        if status in _REDIRECTS:
                            location = response.headers.get("Location")
                            if kind == "RIGHTS" or not location or redirects >= MAX_REDIRECTS:
                                raise DownloadError(kind + "_REDIRECT_NOT_ALLOWED")
                            next_url = urllib.parse.urljoin(current, location)
                            target = _allowed_url(next_url, hosts)
                            if target is None:
                                raise DownloadError(kind + "_REDIRECT_NOT_ALLOWED")
                            current = target.geturl()
                            continue
                        if status != 200:
                            raise DownloadError(kind + "_HTTP_" + str(status))
                        content_type = (response.headers.get("Content-Type") or "").lower()
                        if kind == "PAGE" and content_type and not any(
                                value in content_type for value in ("text/html", "application/xhtml+xml")):
                            raise DownloadError("PAGE_CONTENT_TYPE_INVALID")
                        if kind == "AUDIO" and content_type and not (
                                content_type.startswith("audio/") or "octet-stream" in content_type):
                            raise DownloadError("AUDIO_CONTENT_TYPE_INVALID")
                        body = _read_body(response, control, kind, maximum, minimum,
                                          progress if kind == "AUDIO" else None)
                        return body, current
                    except (urllib.error.URLError, OSError, http.client.HTTPException):
                        control.check()
                        raise DownloadError("NETWORK_ERROR", no_retry=received[0] > 0) from None
                    finally:
                        if response is not None:
                            response.close()
                        control.response = None
                raise DownloadError(kind + "_REDIRECT_NOT_ALLOWED")

            try:
                result = _with_deadline(request, cancel_event, min(timeout, budget.remaining()))
                budget.check()
                return result
            except DownloadError as exc:
                budget.check()
                exc.no_retry = exc.no_retry or received[0] > 0
                if attempt >= MAX_RETRIES or not _retryable(exc):
                    raise
                on_status({"PAGE": "页面读取失败，正在重试…", "AUDIO": "音频连接中断，正在重试…",
                           "RIGHTS": "播放授权请求失败，正在重试…"}[kind])
                retry_delay = min(RETRY_DELAY * (2 ** attempt), MAX_RETRY_DELAY, budget.remaining())
                if cancel_event.wait(retry_delay):
                    raise DownloadError("CANCELLED") from None
                budget.check()

    def download(self, source_url, *, cancel_event=None, on_status=None, on_progress=None):
        cancel_event = cancel_event or threading.Event()
        on_status = on_status or (lambda _message: None)
        if cancel_event.is_set():
            raise DownloadError("CANCELLED")
        source_url = normalize_source_url(source_url)
        if not source_url:
            raise DownloadError("INVALID_SUNO_URL")
        budget = _TaskBudget(cancel_event)
        on_status("正在识别链接…")
        song_id = _song_id(source_url)
        try:
            page, final_url = self._fetch(source_url, kind="PAGE", cancel_event=cancel_event,
                                          on_status=on_status, budget=budget)
            song_id, title, candidates = _page_song(page.decode("utf-8", errors="replace"), final_url, song_id)
            budget.check()
        except DownloadError as exc:
            fallback = (exc.code in ("PAGE_HTTP_404", "REQUEST_TIMEOUT", "PAGE_IDLE_TIMEOUT", "NETWORK_ERROR")
                        or bool(re.fullmatch(r"PAGE_HTTP_5\d\d", exc.code)))
            if not song_id or not fallback:
                raise
            title, candidates = "SUNO-" + song_id, _audio_candidates("", song_id)
        last_candidate_error = None
        for candidate in candidates:
            budget.check()
            on_status("正在下载音频…")
            try:
                audio, _ = self._fetch(candidate, kind="AUDIO", cancel_event=cancel_event,
                                       on_status=on_status, on_progress=on_progress, budget=budget)
                break
            except DownloadError as exc:
                unavailable = exc.code in ("AUDIO_HTTP_404", "AUDIO_HTTP_410")
                transient = (exc.code in ("NETWORK_ERROR", "REQUEST_TIMEOUT", "AUDIO_IDLE_TIMEOUT")
                             or bool(re.fullmatch(r"AUDIO_HTTP_(?:408|425|429|5\d\d)", exc.code)))
                if not unavailable and not transient:
                    raise
                if transient:
                    last_candidate_error = exc
                on_status("当前音频线路不可用，正在切换备用线路…")
        else:
            if last_candidate_error is not None:
                raise last_candidate_error
            if len(candidates) >= MAX_AUDIO_CANDIDATES:
                raise DownloadError("AUDIO_CANDIDATE_LIMIT", no_retry=True)
            raise DownloadError("AUDIO_NOT_FOUND")
        info = inspect_audio(audio)
        if not info["valid"]:
            if info["signature"]:
                raise DownloadError(info["error"])
            on_status("正在取得公开播放授权并解码…")
            body = json.dumps({"content_params": {"content_id": song_id, "content_type": "clip"}},
                              separators=(",", ":")).encode()
            rights_body, _ = self._fetch(RIGHTS_URL, kind="RIGHTS", cancel_event=cancel_event,
                                         on_status=on_status, data=body, budget=budget)
            if cancel_event.is_set():
                raise DownloadError("CANCELLED")
            rights = _parse_rights(rights_body)
            audio = decrypt_audio(content_id=song_id, encrypted_data=audio, **rights)
            if cancel_event.is_set():
                raise DownloadError("CANCELLED")
            info = inspect_audio(audio)
            if not info["valid"]:
                raise DownloadError("AUDIO_TOO_LONG" if info["error"] == "AUDIO_TOO_LONG"
                                    else "DECRYPTED_AUDIO_INVALID")
        budget.check()
        on_status("音频已准备，正在校验…")
        return {"title": title, "song_id": song_id, "audio": audio, "container": info["container"],
                "media_info": {key: info.get(key) for key in ("durationSeconds", "sampleRate", "channels")}}


def _parse_rights(value):
    try:
        rights = json.loads(value)
    except (ValueError, UnicodeError, RecursionError):
        raise DownloadError("RIGHTS_RESPONSE_INVALID") from None
    if not isinstance(rights, dict) or any(not isinstance(rights.get(key), str) or not rights[key]
                                           for key in ("key", "iv", "glt")):
        raise DownloadError("RIGHTS_MISSING")
    return {"wrapped_key": rights["key"], "wrapped_iv": rights["iv"], "auth_token": rights["glt"]}


def _base64url(value):
    value = value.strip().replace("-", "+").replace("_", "/")
    core = value.rstrip("=")
    if (not core or len(value) - len(core) > 2 or len(core) % 4 == 1
            or not re.fullmatch(r"[A-Za-z0-9+/]+", core)):
        raise DownloadError("LICENSE_BASE64_INVALID")
    try:
        return base64.b64decode(core + "=" * (-len(core) % 4), validate=True)
    except (ValueError, binascii.Error):
        raise DownloadError("LICENSE_BASE64_INVALID") from None


def decrypt_audio(*, auth_token, content_id, wrapped_key, wrapped_iv, encrypted_data):
    if not all(isinstance(value, str) and value for value in (auth_token, content_id, wrapped_key, wrapped_iv)):
        raise DownloadError("DOWNLOAD_LICENSE_MISSING")
    try:
        from cryptography.exceptions import InvalidTag
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        raise DownloadError("CRYPTO_UNAVAILABLE") from None
    wrapping_key = AESGCM(hashlib.sha256(auth_token.encode("utf-8")).digest())

    def unwrap(value):
        wrapped = _base64url(value)
        if len(wrapped) <= 28:
            raise DownloadError("DOWNLOAD_LICENSE_INVALID")
        try:
            return wrapping_key.decrypt(wrapped[:12], wrapped[12:], content_id.encode("utf-8"))
        except (InvalidTag, ValueError):
            raise DownloadError("DOWNLOAD_LICENSE_UNWRAP_FAILED") from None

    key = unwrap(wrapped_key)
    counter = unwrap(wrapped_iv)
    if len(key) not in (16, 24, 32) or len(counter) != 16:
        raise DownloadError("DOWNLOAD_LICENSE_INVALID")
    decoder = Cipher(algorithms.AES(key), modes.CTR(counter)).decryptor()
    return decoder.update(encrypted_data) + decoder.finalize()


def _boxes(data, start=0, end=None):
    end = len(data) if end is None else end
    boxes = []
    while start < end:
        if end - start < 8 or len(boxes) >= 50000:
            return None
        size = int.from_bytes(data[start:start + 4], "big")
        kind = data[start + 4:start + 8]
        header = 8
        if size == 1:
            if end - start < 16:
                return None
            size = int.from_bytes(data[start + 8:start + 16], "big")
            header = 16
        elif size == 0:
            size = end - start
        if size < header or start + size > end:
            return None
        boxes.append((kind, start + header, start + size))
        start += size
    return boxes


def _invalid(signature, code="AUDIO_CONTAINER_INCOMPLETE"):
    return {"valid": False, "signature": signature, "error": code}


def _valid(signature, duration, sample_rate=None, channels=None):
    if not math.isfinite(duration) or duration <= 0:
        return _invalid(signature, "AUDIO_METADATA_INVALID")
    if duration > MAX_AUDIO_DURATION_SECONDS:
        return _invalid(signature, "AUDIO_TOO_LONG")
    return {"valid": True, "signature": signature, "container": signature,
            "durationSeconds": duration, "sampleRate": sample_rate, "channels": channels}


def _mp4_duration(data, start, end):
    if end <= start:
        return 0
    version = data[start]
    if version == 0 and end - start >= 20:
        scale = int.from_bytes(data[start + 12:start + 16], "big")
        duration = int.from_bytes(data[start + 16:start + 20], "big")
    elif version == 1 and end - start >= 32:
        scale = int.from_bytes(data[start + 20:start + 24], "big")
        duration = int.from_bytes(data[start + 24:start + 32], "big")
    else:
        return 0
    return duration / scale if scale and duration else 0


def _inspect_m4a(data):
    roots = _boxes(data)
    if not roots:
        return _invalid("m4a")
    if not all(any(kind == target and end > start for kind, start, end in roots)
               for target in (b"ftyp", b"moov", b"mdat")):
        return _invalid("m4a")
    moov = next(box for box in roots if box[0] == b"moov")
    children = _boxes(data, moov[1], moov[2])
    if not children:
        return _invalid("m4a")
    mvhd = next((box for box in children if box[0] == b"mvhd"), None)
    duration = _mp4_duration(data, mvhd[1], mvhd[2]) if mvhd else 0
    if not duration:
        return _invalid("m4a", "AUDIO_METADATA_INVALID")
    sample_rate = channels = None
    pending = [(box, 0) for box in children]
    while pending:
        (kind, start, end), depth = pending.pop()
        if depth > 16:
            return _invalid("m4a", "AUDIO_METADATA_INVALID")
        if kind in (b"trak", b"mdia", b"minf", b"stbl"):
            nested = _boxes(data, start, end)
            if nested is None:
                return _invalid("m4a")
            pending.extend((box, depth + 1) for box in nested)
        elif kind == b"mdhd":
            track_duration = _mp4_duration(data, start, end)
            if not track_duration:
                return _invalid("m4a", "AUDIO_METADATA_INVALID")
            duration = max(duration, track_duration)
        elif kind == b"stsd":
            entries = _boxes(data, start + 8, end) if end - start >= 8 else None
            if entries is None or len(entries) != int.from_bytes(data[start + 4:start + 8], "big"):
                return _invalid("m4a")
            for codec, entry_start, entry_end in entries:
                if codec in (b"mp4a", b"alac") and entry_end - entry_start >= 28:
                    channels = int.from_bytes(data[entry_start + 16:entry_start + 18], "big") or None
                    sample_rate = int.from_bytes(data[entry_start + 24:entry_start + 28], "big") / 65536 or None
    return _valid("m4a", duration, sample_rate, channels)


def _mp3_frame(data, offset):
    if offset + 4 > len(data):
        return None
    b0, b1, b2, b3 = data[offset:offset + 4]
    if b0 != 255 or b1 & 224 != 224:
        return None
    version, layer = (b1 >> 3) & 3, (b1 >> 1) & 3
    bitrate_index, rate_index = b2 >> 4, (b2 >> 2) & 3
    if version == 1 or layer != 1 or bitrate_index in (0, 15) or rate_index == 3:
        return None
    rates = (44100, 48000, 32000)
    rate = rates[rate_index] // (2 if version == 2 else 4 if version == 0 else 1)
    bitrates = ((0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)
                if version == 3 else (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160))
    size = (144 if version == 3 else 72) * bitrates[bitrate_index] * 1000 // rate + ((b2 >> 1) & 1)
    if size < 24:
        return None
    return size, rate, 1152 if version == 3 else 576, 1 if b3 >> 6 == 3 else 2


def _inspect_mp3(data):
    offset = 0
    if data[:3] == b"ID3":
        if len(data) < 10 or data[3] not in (2, 3, 4) or any(value > 127 for value in data[6:10]):
            return _invalid("mp3", "AUDIO_METADATA_INVALID")
        offset = 10 + sum(value << shift for value, shift in zip(data[6:10], (21, 14, 7, 0)))
        if data[3] == 4 and data[5] & 16:
            offset += 10
    if offset >= len(data):
        return _invalid("mp3")
    frames = 0
    duration = 0
    sample_rate = channels = None
    while offset < len(data):
        if len(data) - offset == 128 and data[offset:offset + 3] == b"TAG":
            offset = len(data)
            break
        frame = _mp3_frame(data, offset)
        if not frame or offset + frame[0] > len(data):
            return _invalid("mp3")
        size, rate, samples, channel_count = frame
        sample_rate, channels = sample_rate or rate, channels or channel_count
        duration += samples / rate
        frames += 1
        offset += size
        if duration > MAX_AUDIO_DURATION_SECONDS:
            return _invalid("mp3", "AUDIO_TOO_LONG")
    return _valid("mp3", duration, sample_rate, channels) if frames >= 3 else _invalid("mp3")


def _inspect_wav(data):
    if len(data) < 44 or int.from_bytes(data[4:8], "little") + 8 != len(data):
        return _invalid("wav")
    offset = 12
    byte_rate = data_bytes = sample_rate = channels = block_align = 0
    while offset + 8 <= len(data):
        kind = data[offset:offset + 4]
        size = int.from_bytes(data[offset + 4:offset + 8], "little")
        start = offset + 8
        offset = start + size + size % 2
        if offset > len(data):
            return _invalid("wav")
        if kind == b"fmt " and size >= 16:
            channels = int.from_bytes(data[start + 2:start + 4], "little")
            sample_rate = int.from_bytes(data[start + 4:start + 8], "little")
            byte_rate = int.from_bytes(data[start + 8:start + 12], "little")
            block_align = int.from_bytes(data[start + 12:start + 14], "little")
        if kind == b"data":
            data_bytes += size
    if (offset != len(data) or not all((byte_rate, data_bytes, sample_rate, channels, block_align))
            or byte_rate != sample_rate * block_align or data_bytes % block_align):
        return _invalid("wav", "AUDIO_METADATA_INVALID")
    return _valid("wav", data_bytes / byte_rate, sample_rate, channels)


def inspect_audio(data):
    if not isinstance(data, bytes) or len(data) > MAX_AUDIO_BYTES:
        return _invalid("", "AUDIO_TOO_LARGE" if isinstance(data, bytes) else "AUDIO_DATA_INVALID")
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return _inspect_m4a(data)
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return _inspect_wav(data)
    if data[:3] == b"ID3" or (len(data) >= 2 and data[0] == 255 and data[1] & 224 == 224):
        return _inspect_mp3(data)
    for signature, magic in (("ogg", b"OggS"), ("webm", b"\x1a\x45\xdf\xa3")):
        if data.startswith(magic):
            return _invalid(signature, "AUDIO_CONTAINER_UNSUPPORTED")
    return _invalid("", "AUDIO_CONTAINER_UNKNOWN")


def download(source_url, *, cancel_event=None, on_status=None, on_progress=None):
    return _Downloader().download(source_url, cancel_event=cancel_event,
                                  on_status=on_status, on_progress=on_progress)
