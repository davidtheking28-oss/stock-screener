"""Regression test runner for the screener's pure logic.

Loads the app in headless Chromium and evaluates tests/assertions.js against
the real in-page functions (applyFilters, computeRS, _ma200Rising, _powerPlayOK).
No network / no live data — deterministic synthetic fixtures only.

Run:  py tests/run-tests.py
Setup (once):  py -m pip install playwright  &&  py -m playwright install chromium
"""
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
HTML = "מסנן-מניות.html"
PORT = 8791


def wait_port(port, timeout=8.0):
    end = time.time() + timeout
    while time.time() < end:
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    os.chdir(ROOT)
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(PORT)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        if not wait_port(PORT):
            print("FAIL: local server did not start")
            return 1
        assertions = (ROOT / "tests" / "assertions.js").read_text(encoding="utf-8")
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.goto(f"http://127.0.0.1:{PORT}/{quote(HTML)}")
            page.wait_for_function(
                "typeof applyFilters==='function' && typeof _powerPlayOK==='function' && typeof C==='object'"
            )
            results = page.evaluate(assertions)
            browser.close()
    finally:
        server.terminate()

    failed = [r for r in results if not r["pass"]]
    for r in results:
        mark = "PASS" if r["pass"] else "FAIL"
        extra = "" if r["pass"] else "  -> " + str(r.get("detail", ""))
        print(f"{mark}  {r['name']}{extra}")
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
