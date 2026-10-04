"""Provider-free checks against an operator-selected public workspace.

Uses only one disposable owned session and our harmless private health URL.
Never enumerate other sessions, fetch metadata, or submit model requests.
"""
import base64
import http.client
import json
import secrets
import sys
from urllib.parse import urlsplit
import urllib.error
import urllib.request


def private_navigation_rejected(result):
    status, _, body = result
    try:
        error = json.loads(body)
    except (ValueError, TypeError):
        return False
    return status == 502 and isinstance(error, dict) and error.get("code") == "browser_operation_failed"


def check(base):
    parsed = urlsplit(base)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.path not in ("", "/"):
        raise ValueError("Supply only the HTTPS workspace origin")
    base = base.rstrip("/")

    def request(path, method="GET", data=None, headers=None):
        request = urllib.request.Request(base + path, method=method,
            data=None if data is None else json.dumps(data).encode(),
            headers={"Content-Type": "application/json", **(headers or {})})
        try:
            response = urllib.request.urlopen(request, timeout=25)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def expect(name, result, expected):
        status, headers, body = result
        if status != expected:
            raise RuntimeError(f"{name}: expected {expected}, received {status}")
        for key, value in {"X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff",
                           "Cache-Control": "no-store"}.items():
            if headers.get(key) != value:
                raise RuntimeError(f"{name}: missing {key}")
        if ("object-src 'none'" not in headers.get("Content-Security-Policy", "")
                or not headers.get("Strict-Transport-Security")
                or headers.get("WWW-Authenticate") or headers.get("Access-Control-Allow-Origin")):
            raise RuntimeError(f"{name}: unexpected browser security policy")
        print(f"PASS {name}: {status}", flush=True)
        return body

    for path in ("/", "/health", "/view/health"):
        expect(path, request(path), 200)
    for origin in ("https://foreign.invalid", "null"):
        expect("foreign origin", request("/api/sessions", "POST", headers={"Origin": origin}), 403)
        expect("foreign preflight", request("/api/sessions", "OPTIONS",
            headers={"Origin": origin, "Access-Control-Request-Method": "POST"}), 403)
    for site in ("cross-site", "same-site"):
        expect("foreign fetch " + site, request("/api/sessions", "POST", headers={"Sec-Fetch-Site": site}), 403)
    expect("ordinary external link", request("/", headers={"Sec-Fetch-Site": "cross-site"}), 200)
    for path in ("/.env", "/.git/config", "/internal/", "/internal/selection"):
        expect("private path " + path, request(path), 404)

    session = json.loads(expect("owned session", request("/api/sessions", "POST",
        headers={"Origin": base, "Sec-Fetch-Site": "same-origin"}), 200))
    try:
        page = "/api/pages/" + session["pageId"]
        result = request(page + "/navigate", "POST", {"url": "http://resolver:8080/health"})
        if not private_navigation_rejected(result):
            raise RuntimeError("Private navigation did not produce the expected Browser network rejection")
        print("PASS private service navigation rejected", flush=True)
        expect("public browser navigation", request(page + "/navigate", "POST",
            {"url": "https://www.saucedemo.com/"}), 200)
        for origin, expected in ((base, 101), ("https://foreign.invalid", 403), ("null", 403)):
            connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=10)
            try:
                connection.request("GET", "/view/" + session["sessionId"], headers={
                    "Origin": origin, "Connection": "Upgrade", "Upgrade": "websocket",
                    "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": base64.b64encode(secrets.token_bytes(16)).decode()})
                response = connection.getresponse()
                if response.status != expected:
                    raise RuntimeError(f"Viewer origin check: expected {expected}, received {response.status}")
                print(f"PASS viewer origin: {expected}", flush=True)
            finally:
                connection.close()
    finally:
        expect("owned session cleanup", request("/api/sessions/" + session["sessionId"], "DELETE"), 204)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: hosted-security-check.py https://YOUR_WORKSPACE_HOST")
    check(sys.argv[1])
