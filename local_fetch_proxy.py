#!/usr/bin/env python3
"""Root wrapper so `python3 local_fetch_proxy.py` works from repo root."""

import os
import runpy
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(ROOT, "plugin-dev-kit", "local_fetch_proxy.py")

if not os.path.exists(TARGET):
    print(f"Proxy script not found: {TARGET}")
    raise SystemExit(1)

sys.argv[0] = TARGET
runpy.run_path(TARGET, run_name="__main__")
