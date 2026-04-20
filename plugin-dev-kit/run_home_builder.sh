#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
HTTP_PORT="${1:-8080}"
PROXY_PORT="${2:-8787}"

cd "$ROOT_DIR"

echo "[1/4] Checking Python dependency (cloudscraper)..."
if ! python3 - <<'PY' >/dev/null 2>&1
import cloudscraper
PY
then
  echo "cloudscraper is missing. Installing..."
  python3 -m pip install --user cloudscraper
fi

echo "[2/4] Starting local fetch proxy on :$PROXY_PORT"
python3 local_fetch_proxy.py --port "$PROXY_PORT" > /tmp/vaapp_proxy.log 2>&1 &
PROXY_PID=$!

cleanup() {
  if kill -0 "$PROXY_PID" >/dev/null 2>&1; then
    kill "$PROXY_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

sleep 1
if ! curl -fsS "http://127.0.0.1:$PROXY_PORT/health" >/dev/null 2>&1; then
  echo "Local proxy failed to start. Log: /tmp/vaapp_proxy.log"
  exit 1
fi

echo "[3/4] Starting tester web server on :$HTTP_PORT"
TESTER_URL="http://127.0.0.1:$HTTP_PORT/test.html"

echo "[4/4] Open this URL in browser: $TESTER_URL"
if command -v open >/dev/null 2>&1; then
  open "$TESTER_URL" >/dev/null 2>&1 || true
fi

echo "Running... Press Ctrl+C to stop both servers"
python3 -m http.server "$HTTP_PORT"
