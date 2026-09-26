"""Stitch for Android: SearXNG web search on the phone (Chaquopy, CPython 3.13).

Called from Kotlin (com.stitch.mobile.device.web.WebEngine) on one background thread, with strings in and
JSON text out. The search itself is ``stitch_searx`` (shared with the desktop app, staged next to SearXNG
by scripts/searxng.mjs); this module only adapts it to the phone.
"""

from __future__ import annotations

import json
import time

import stitch_searx


def start(data_dir: str, safe_search: int) -> str:
    """Configure SearXNG under ``data_dir`` and load it (settings, engines, plugins, network).

    Returns ``{"version", "engines", "ms"}``. Safe to call again: once loaded it only updates the default
    safe-search level.
    """
    t0 = time.monotonic()
    _fast_yaml()
    stitch_searx.configure(data_dir, safe_search=int(safe_search))
    names = stitch_searx.engines()
    return json.dumps({
        'version': stitch_searx.version(),
        'engines': len(names),
        'ms': int((time.monotonic() - t0) * 1000),
    })


def search(req_json: str) -> str:
    """WebSearchRequest (JSON) → ``{"ok": WebSearchResult fields}`` or ``{"error", "status"}``."""
    return _call(lambda: stitch_searx.search(json.loads(req_json)))


def page(url: str, max_chars: int) -> str:
    """→ ``{"ok": {url, title, text, truncated}}`` or ``{"error", "status"}``."""
    return _call(lambda: stitch_searx.page(url, int(max_chars)))


def _fast_yaml() -> None:
    """Parse YAML with libyaml (pyyaml's C loader, same results as SafeLoader): SearXNG reads its ~2,800-line
    default settings.yml with ``yaml.safe_load`` on every start, which in pure Python takes seconds on a phone."""
    import yaml  # pylint: disable=import-outside-toplevel

    loader = getattr(yaml, 'CSafeLoader', None)
    if loader is None or getattr(yaml.safe_load, '_stitch_fast', False):
        return

    def safe_load(stream):
        return yaml.load(stream, Loader=loader)  # noqa: S506 — CSafeLoader is the safe loader

    safe_load._stitch_fast = True  # type: ignore[attr-defined]
    yaml.safe_load = safe_load


def _call(fn) -> str:
    try:
        return json.dumps({'ok': fn()}, ensure_ascii=False)
    except stitch_searx.SearxError as e:
        return json.dumps({'error': str(e), 'status': e.status}, ensure_ascii=False)
