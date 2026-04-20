#!/usr/bin/env python3
"""
Local fetch proxy for VAAPP plugin tester.
- Bypass browser CORS by fetching server-side.
- Use cloudscraper to handle Cloudflare anti-bot challenge pages better.

Endpoints:
    GET  /health
    GET  /fetch?url=<encoded-url>
    POST /request  {"url":..., "method":"GET|POST", "headers":{}, "body":"..."}
    GET  /media?url=<encoded-url>&referer=<optional>&origin=<optional>

Run:
    python3 local_fetch_proxy.py --port 8787
Then tester can call:
    http://127.0.0.1:8787/fetch?url=<encoded-target-url>
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, List, Optional
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlparse

try:
    import cloudscraper
except Exception as exc:  # pragma: no cover
    print("Missing dependency: cloudscraper")
    print("Install: python3 -m pip install --user cloudscraper")
    raise SystemExit(2) from exc


SCRAPER = cloudscraper.create_scraper(
    browser={"browser": "chrome", "platform": "windows", "mobile": False}
)
LAST_WARMUP_HOST = ""
DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)


def is_valid_target(url: str) -> bool:
    if not url:
        return False
    parsed = urlparse(url)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def as_origin(url: str) -> str:
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}"


def clamp_timeout(raw: str, default: int = 30) -> int:
    try:
        value = int(raw)
    except Exception:
        return default
    return max(5, min(120, value))


def parse_optional_json_object(text: str) -> dict:
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


class ProxyHandler(BaseHTTPRequestHandler):
    server_version = "VAAPPProxy/2.0"

    def _send(self, status: int, body: bytes, content_type: str = "text/plain; charset=utf-8") -> None:
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_headers_only(
        self,
        status: int,
        content_type: str = "text/plain; charset=utf-8",
        content_length: Optional[int] = None,
        extra_headers: Optional[dict] = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS,HEAD")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Cache-Control", "no-store")
        if content_type:
            self.send_header("Content-Type", content_type)
        if content_length is not None:
            self.send_header("Content-Length", str(content_length))
        if extra_headers:
            for key, value in extra_headers.items():
                if value:
                    self.send_header(key, value)
        self.end_headers()

    def _json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _send_stream(self, response) -> None:
        self.send_response(response.status_code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Cache-Control", "no-store")

        passthrough = [
            "Content-Type",
            "Content-Length",
            "Content-Range",
            "Accept-Ranges",
            "Last-Modified",
            "ETag",
        ]
        for key in passthrough:
            value = response.headers.get(key)
            if value:
                self.send_header(key, value)
        self.end_headers()

        try:
            for chunk in response.iter_content(chunk_size=64 * 1024):
                if chunk:
                    self.wfile.write(chunk)
        except BrokenPipeError:
            return

    def do_OPTIONS(self) -> None:
        self._send(204, b"")

    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/health":
            payload = json.dumps({"ok": True, "service": "local_fetch_proxy"}, ensure_ascii=False).encode("utf-8")
            self._send_headers_only(
                200,
                "application/json; charset=utf-8",
                content_length=len(payload),
            )
            return

        query = parse_qs(parsed.query)

        if parsed.path == "/fetch":
            self._handle_fetch_head(query)
            return

        if parsed.path == "/media":
            self._handle_media_head(query)
            return

        self._send_headers_only(404, "application/json; charset=utf-8", content_length=0)

    def _build_headers(
        self,
        target: str,
        extra_headers: Optional[dict] = None,
        referer: str = "",
        origin: str = "",
        range_header: str = "",
    ) -> dict:
        target_origin = as_origin(target)
        headers = {
            "User-Agent": DEFAULT_UA,
            "Accept": "*/*",
            "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
        }

        merged = extra_headers or {}
        if not referer:
            referer = str(merged.get("Referer") or merged.get("referer") or "").strip()
        if not referer:
            referer = target_origin + "/" if target_origin else ""
        if referer:
            headers["Referer"] = referer

        if not origin:
            origin = str(merged.get("Origin") or merged.get("origin") or "").strip()
        if not origin and referer:
            origin = as_origin(referer)
        if origin:
            headers["Origin"] = origin

        if range_header:
            headers["Range"] = range_header

        for key, value in merged.items():
            if value is None:
                continue
            key_s = str(key)
            low = key_s.lower()
            if low in ("host", "content-length", "connection", "accept-encoding"):
                continue
            headers[key_s] = str(value)

        return headers

    def _warmup(self, target: str, headers: dict, timeout: int) -> None:
        global LAST_WARMUP_HOST
        parsed = urlparse(target)
        host = parsed.netloc
        if not host or host == LAST_WARMUP_HOST:
            return

        origin = as_origin(target)
        if origin:
            try:
                SCRAPER.get(origin + "/", headers=headers, timeout=min(timeout, 15), allow_redirects=True)
            except Exception:
                pass
        LAST_WARMUP_HOST = host

    def _upstream_request(
        self,
        target: str,
        method: str,
        headers: dict,
        timeout: int,
        body: str = "",
        stream: bool = False,
    ):
        self._warmup(target, headers, timeout)
        data = body if method in ("POST", "PUT", "PATCH") else None
        return SCRAPER.request(
            method,
            target,
            headers=headers,
            data=data,
            timeout=timeout,
            allow_redirects=True,
            stream=stream,
        )

    def _iter_media_header_profiles(self, target: str, referer: str, origin: str) -> List[tuple[str, str]]:
        profiles: List[tuple[str, str]] = []
        target_origin = as_origin(target)

        profiles.append((referer.strip(), origin.strip()))
        if target_origin:
            profiles.append((target_origin + "/", target_origin))
        profiles.append(("", ""))

        out: List[tuple[str, str]] = []
        seen = set()
        for ref, org in profiles:
            key = (ref, org)
            if key in seen:
                continue
            seen.add(key)
            out.append(key)
        return out

    def _request_media_with_fallback(
        self,
        target: str,
        timeout: int,
        referer: str,
        origin: str,
        range_header: str,
        playlist_hint: bool,
        stream: bool,
    ):
        retry_statuses = {401, 403, 405, 406, 429, 451, 503}
        errors: List[str] = []

        for ref, org in self._iter_media_header_profiles(target, referer, origin):
            headers = self._build_headers(
                target,
                referer=ref,
                origin=org,
                range_header="" if playlist_hint else range_header,
            )

            try:
                response = self._upstream_request(
                    target=target,
                    method="GET",
                    headers=headers,
                    timeout=timeout,
                    stream=stream,
                )
            except Exception as exc:
                errors.append(f"request-error[{ref or 'none'}]: {exc}")
                continue

            if response.status_code < 400:
                return response, ref, org

            if response.status_code not in retry_statuses:
                return response, ref, org

            errors.append(f"http-{response.status_code}[{ref or 'none'}]")
            try:
                response.close()
            except Exception:
                pass

        if errors:
            raise RuntimeError("Media upstream failed: " + " | ".join(errors[:4]))
        raise RuntimeError("Media upstream failed")

    def _is_hls_playlist(self, url: str, content_type: str) -> bool:
        low_ct = (content_type or "").lower()
        low_url = (url or "").lower()
        if "mpegurl" in low_ct or "vnd.apple.mpegurl" in low_ct:
            return True
        return bool(re.search(r"\.m3u8(\?|$)", low_url))

    def _proxy_base_url(self) -> str:
        host = self.headers.get("Host", "").strip()
        if not host:
            addr = getattr(self.server, "server_address", ("127.0.0.1", 8787))
            host = f"{addr[0]}:{addr[1]}"
        return f"http://{host}"

    def _build_media_proxy_url(self, target_url: str, referer: str, origin: str) -> str:
        params: Dict[str, str] = {"url": target_url}
        if referer:
            params["referer"] = referer
        if origin:
            params["origin"] = origin
        return self._proxy_base_url() + "/media?" + urlencode(params, quote_via=quote)

    def _rewrite_uri_attrs(self, line: str, base_url: str, referer: str, origin: str) -> str:
        def repl(match) -> str:
            raw = match.group(1)
            absolute = urljoin(base_url, raw)
            proxied = self._build_media_proxy_url(absolute, referer, origin)
            return 'URI="' + proxied + '"'

        return re.sub(r'URI="([^"]+)"', repl, line)

    def _rewrite_playlist(self, text: str, base_url: str, referer: str, origin: str) -> str:
        out: List[str] = []
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                out.append(line)
                continue
            if stripped.startswith("#"):
                out.append(self._rewrite_uri_attrs(line, base_url, referer, origin))
                continue

            absolute = urljoin(base_url, stripped)
            out.append(self._build_media_proxy_url(absolute, referer, origin))
        return "\n".join(out)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/health":
            self._json(200, {"ok": True, "service": "local_fetch_proxy"})
            return

        query = parse_qs(parsed.query)

        if parsed.path == "/fetch":
            self._handle_fetch(query)
            return

        if parsed.path == "/media":
            self._handle_media(query)
            return

        self._json(404, {"ok": False, "error": "Not found"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/request":
            self._json(404, {"ok": False, "error": "Not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except Exception:
            length = 0

        raw = self.rfile.read(length) if length > 0 else b""
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            self._json(400, {"ok": False, "error": "Invalid JSON body"})
            return

        if not isinstance(payload, dict):
            self._json(400, {"ok": False, "error": "JSON body must be an object"})
            return

        target = str(payload.get("url") or "").strip()
        if not is_valid_target(target):
            self._json(400, {"ok": False, "error": "Invalid or missing url"})
            return

        method = str(payload.get("method") or "GET").upper()
        if method not in ("GET", "POST"):
            self._json(400, {"ok": False, "error": "Unsupported method"})
            return

        headers = payload.get("headers") if isinstance(payload.get("headers"), dict) else {}
        body = str(payload.get("body") or "")
        timeout = clamp_timeout(str(payload.get("timeout") or "30"), 30)

        try:
            upstream_headers = self._build_headers(target, extra_headers=headers)
            response = self._upstream_request(
                target=target,
                method=method,
                headers=upstream_headers,
                timeout=timeout,
                body=body,
                stream=False,
            )
            content_type = response.headers.get("Content-Type", "text/html; charset=utf-8")
            self._send(response.status_code, response.content, content_type)
        except Exception as exc:
            self._json(502, {"ok": False, "error": str(exc), "target": target})

    def _handle_fetch(self, query: dict) -> None:
        target = (query.get("url") or [""])[0].strip()
        if not is_valid_target(target):
            self._json(400, {"ok": False, "error": "Invalid or missing url"})
            return

        timeout = clamp_timeout((query.get("timeout") or ["30"])[0], 30)
        method = (query.get("method") or ["GET"])[0].strip().upper() or "GET"
        if method not in ("GET", "POST"):
            method = "GET"

        referer = (query.get("referer") or [""])[0].strip()
        origin = (query.get("origin") or [""])[0].strip()
        body = (query.get("body") or [""])[0]

        headers_blob = (query.get("headers") or [""])[0].strip()
        headers = parse_optional_json_object(headers_blob)

        try:
            upstream_headers = self._build_headers(
                target,
                extra_headers=headers,
                referer=referer,
                origin=origin,
            )
            response = self._upstream_request(
                target=target,
                method=method,
                headers=upstream_headers,
                timeout=timeout,
                body=body,
                stream=False,
            )
            content_type = response.headers.get("Content-Type", "text/html; charset=utf-8")
            self._send(response.status_code, response.content, content_type)
        except Exception as exc:
            self._json(502, {"ok": False, "error": str(exc), "target": target})

    def _handle_fetch_head(self, query: dict) -> None:
        target = (query.get("url") or [""])[0].strip()
        if not is_valid_target(target):
            self._send_headers_only(400, "application/json; charset=utf-8", content_length=0)
            return

        timeout = clamp_timeout((query.get("timeout") or ["30"])[0], 30)
        referer = (query.get("referer") or [""])[0].strip()
        origin = (query.get("origin") or [""])[0].strip()
        headers_blob = (query.get("headers") or [""])[0].strip()
        headers = parse_optional_json_object(headers_blob)

        try:
            upstream_headers = self._build_headers(
                target,
                extra_headers=headers,
                referer=referer,
                origin=origin,
            )
            response = self._upstream_request(
                target=target,
                method="GET",
                headers=upstream_headers,
                timeout=timeout,
                stream=True,
            )

            extra = {
                "Content-Range": response.headers.get("Content-Range", ""),
                "Accept-Ranges": response.headers.get("Accept-Ranges", ""),
                "Last-Modified": response.headers.get("Last-Modified", ""),
                "ETag": response.headers.get("ETag", ""),
            }
            cl = response.headers.get("Content-Length")
            content_length = int(cl) if cl and cl.isdigit() else None
            content_type = response.headers.get("Content-Type", "application/octet-stream")

            self._send_headers_only(
                response.status_code,
                content_type,
                content_length=content_length,
                extra_headers=extra,
            )
            response.close()
        except Exception:
            self._send_headers_only(502, "application/json; charset=utf-8", content_length=0)

    def _handle_media(self, query: dict) -> None:
        target = (query.get("url") or [""])[0].strip()
        if not is_valid_target(target):
            self._json(400, {"ok": False, "error": "Invalid or missing url"})
            return

        timeout = clamp_timeout((query.get("timeout") or ["30"])[0], 30)
        referer = (query.get("referer") or [""])[0].strip()
        origin = (query.get("origin") or [""])[0].strip()
        range_header = self.headers.get("Range", "")
        playlist_hint = self._is_hls_playlist(target, "")

        try:
            response, effective_referer, effective_origin = self._request_media_with_fallback(
                target=target,
                timeout=timeout,
                referer=referer,
                origin=origin,
                range_header=range_header,
                playlist_hint=playlist_hint,
                stream=not playlist_hint,
            )

            content_type = response.headers.get("Content-Type", "")
            is_playlist = self._is_hls_playlist(response.url or target, content_type)

            # Range on manifests often returns partial playlist, causing 0:00 playback stalls.
            if is_playlist and range_header and response.status_code == 206:
                try:
                    response.close()
                except Exception:
                    pass

                response, effective_referer, effective_origin = self._request_media_with_fallback(
                    target,
                    timeout=timeout,
                    referer=effective_referer,
                    origin=effective_origin,
                    range_header="",
                    playlist_hint=True,
                    stream=False,
                )
                content_type = response.headers.get("Content-Type", "")

            if is_playlist:
                text = response.content.decode(response.encoding or "utf-8", errors="replace")
                effective_base = response.url or target
                rewritten = self._rewrite_playlist(text, effective_base, effective_referer, effective_origin)
                self._send(response.status_code, rewritten.encode("utf-8"), "application/vnd.apple.mpegurl")
                return

            self._send_stream(response)
        except Exception as exc:
            self._json(502, {"ok": False, "error": str(exc), "target": target})

    def _handle_media_head(self, query: dict) -> None:
        target = (query.get("url") or [""])[0].strip()
        if not is_valid_target(target):
            self._send_headers_only(400, "application/json; charset=utf-8", content_length=0)
            return

        timeout = clamp_timeout((query.get("timeout") or ["30"])[0], 30)
        referer = (query.get("referer") or [""])[0].strip()
        origin = (query.get("origin") or [""])[0].strip()
        range_header = self.headers.get("Range", "")
        playlist_hint = self._is_hls_playlist(target, "")

        try:
            response, _, _ = self._request_media_with_fallback(
                target=target,
                timeout=timeout,
                referer=referer,
                origin=origin,
                range_header=range_header,
                playlist_hint=playlist_hint,
                stream=True,
            )

            content_type = response.headers.get("Content-Type", "application/octet-stream")
            is_playlist = self._is_hls_playlist(response.url or target, content_type)

            extra = {
                "Content-Range": response.headers.get("Content-Range", ""),
                "Accept-Ranges": response.headers.get("Accept-Ranges", ""),
                "Last-Modified": response.headers.get("Last-Modified", ""),
                "ETag": response.headers.get("ETag", ""),
            }
            cl = response.headers.get("Content-Length")
            content_length = int(cl) if cl and cl.isdigit() else None

            self._send_headers_only(
                response.status_code,
                "application/vnd.apple.mpegurl" if is_playlist else content_type,
                content_length=content_length,
                extra_headers=extra,
            )
            response.close()
        except Exception:
            self._send_headers_only(502, "application/json; charset=utf-8", content_length=0)

    def log_message(self, fmt: str, *args) -> None:
        # Keep logs concise and readable in terminal.
        sys.stdout.write("[proxy] " + (fmt % args) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Local fetch proxy for VAAPP tester")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    parser.add_argument("--port", type=int, default=8787, help="Bind port")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), ProxyHandler)
    print(f"Local fetch proxy listening at http://{args.host}:{args.port}")
    print("Health: /health")
    print("Fetch:  /fetch?url=<encoded-url>")
    print("Request: POST /request")
    print("Media:  /media?url=<encoded-url>")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping proxy...")
    except Exception:
        traceback.print_exc()
        return 1
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
