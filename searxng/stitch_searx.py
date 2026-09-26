"""Stitch's wrapper around a bundled SearXNG (https://github.com/searxng/searxng, AGPL-3.0).

Used two ways:

* Desktop: ``python stitch_searx.py serve --data <dir>`` runs a small JSON HTTP server on
  127.0.0.1 (see :func:`serve`); Stitch's main process talks to it.
* Phone (Chaquopy): the app imports this module and calls :func:`configure`, then
  :func:`search` / :func:`page` in-process.

Plain Python on purpose: no Windows-only assumptions outside the guarded shims in
:func:`_platform_shims`, nothing that requires running as ``__main__``.

SearXNG is imported lazily on the first :func:`search` (importing ``searx.webapp`` loads
settings, initialises the engines and starts its network loop), so :func:`configure`
must come first.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import secrets
import socket
import sys
import tempfile
import threading
import time
import types
from urllib.parse import parse_qs, urljoin, urlparse, urlsplit, urlunsplit

API_VERSION = 1

_HERE = os.path.dirname(os.path.abspath(__file__))

# Engines are given this long; SearXNG answers with whatever arrived by max_request_timeout.
REQUEST_TIMEOUT = 4.0
MAX_REQUEST_TIMEOUT = 8.0

PAGE_TIMEOUT = 10.0  # per HTTP request when reading a page
PAGE_DEADLINE = 15.0  # whole page() call, redirects included
PAGE_MAX_BYTES = 3 * 1024 * 1024
PAGE_MAX_REDIRECTS = 8
DEFAULT_LIMIT = 10
MAX_QUERY = 400

CATEGORIES = ('general', 'news', 'science', 'it', 'images', 'videos')
# Enabled on top of SearXNG's defaults (general: brave, duckduckgo, google cse, wikipedia, wikidata…).
EXTRA_ENGINES = ('google', 'bing')
TIME_RANGES = ('day', 'week', 'month', 'year')

_lock = threading.RLock()
_config: dict | None = None
_app = None


class SearxError(Exception):
    """An error with an HTTP-ish status (4xx = the request, 5xx = upstream / SearXNG)."""

    def __init__(self, message: str, status: int = 500):
        super().__init__(message)
        self.status = status


# ─── Configuration ─────────────────────────────────────────────────────────────


def configure(data_dir: str, *, safe_search: int = 1, secret: str | None = None) -> None:
    """Prepare SearXNG to run with everything under ``data_dir``.

    Writes ``<data_dir>/settings.yml``, points ``SEARXNG_SETTINGS_PATH`` at it, moves every
    cache/temp file (SearXNG's SQLite caches use the temp dir) under ``data_dir`` and installs
    the platform shims. Call before the first :func:`search`. Idempotent; calling it again
    after SearXNG was loaded only changes the default safe-search level.
    """
    global _config
    data_dir = os.path.abspath(data_dir)
    safe_search = _safe_level(safe_search, 1)
    with _lock:
        if _config and _config['data_dir'] == data_dir and _config['secret_arg'] == secret:
            if _config['safe_search'] != safe_search:
                _config['safe_search'] = safe_search
                _write_settings(_config)
            return
        if _app is not None:
            # SearXNG is already loaded with the old settings; only the default changes.
            if _config:
                _config['safe_search'] = safe_search
            return

        tmp_dir = os.path.join(data_dir, 'tmp')
        static_dir = os.path.join(data_dir, 'static')
        for d in (data_dir, tmp_dir, static_dir):
            os.makedirs(d, exist_ok=True)

        cfg = {
            'data_dir': data_dir,
            'tmp_dir': tmp_dir,
            'static_dir': static_dir,
            'settings_path': os.path.join(data_dir, 'settings.yml'),
            'safe_search': safe_search,
            'secret_arg': secret,
            'secret': secret or _persistent_secret(data_dir),
        }
        _write_settings(cfg)
        # The bot detection reads <settings dir>/limiter.toml even with the limiter off, and
        # warns when it's missing; SearXNG's defaults are right for a private instance.
        limiter = os.path.join(data_dir, 'limiter.toml')
        if not os.path.exists(limiter):
            with open(limiter, 'w', encoding='utf-8') as f:
                f.write('# SearXNG limiter settings (unused: Stitch runs a private instance).\n')

        os.environ['SEARXNG_SETTINGS_PATH'] = cfg['settings_path']
        os.environ['SEARXNG_DISABLE_ETC_SETTINGS'] = '1'
        os.environ.pop('SEARXNG_DEBUG', None)
        # searx.cache / searx.favicons / searx.enginelib put their SQLite files in the temp dir.
        os.environ['TMPDIR'] = tmp_dir
        tempfile.tempdir = tmp_dir

        _platform_shims()
        _fast_yaml()
        if _HERE not in sys.path:
            sys.path.insert(0, _HERE)
        _config = cfg


def _persistent_secret(data_dir: str) -> str:
    path = os.path.join(data_dir, 'secret_key')
    try:
        with open(path, encoding='utf-8') as f:
            value = f.read().strip()
        if len(value) >= 32:
            return value
    except OSError:
        pass
    value = secrets.token_hex(32)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(value)
    return value


def _settings(cfg: dict) -> dict:
    return {
        # Tor-only engines can't load without a Tor proxy (they'd log an error on every start).
        'use_default_settings': {'engines': {'remove': ['ahmia', 'torch']}},
        'general': {
            'instance_name': 'Stitch',
            'debug': False,
            'enable_metrics': False,
        },
        'search': {
            'safe_search': cfg['safe_search'],
            'autocomplete': '',
            'favicon_resolver': '',
            'default_lang': 'auto',
            'formats': ['html', 'json'],
        },
        'server': {
            'secret_key': cfg['secret'],
            'bind_address': '127.0.0.1',
            'limiter': False,
            'public_instance': False,
            'image_proxy': False,
            'method': 'GET',
        },
        'valkey': {'url': False},
        'ui': {
            # The bundle ships without the web UI's CSS/JS; Stitch only uses the JSON API.
            'static_path': cfg['static_dir'],
            'query_in_title': False,
        },
        'outgoing': {
            'request_timeout': REQUEST_TIMEOUT,
            'max_request_timeout': MAX_REQUEST_TIMEOUT,
            'pool_connections': 100,
            'enable_http2': True,
        },
        'plugins': {
            # SearXNG's defaults, minus self_info ("what is my IP" would answer 127.0.0.1).
            'searx.plugins.calculator.SXNGPlugin': {'active': True},
            'searx.plugins.infinite_scroll.SXNGPlugin': {'active': False},
            'searx.plugins.hash_plugin.SXNGPlugin': {'active': True},
            'searx.plugins.self_info.SXNGPlugin': {'active': False},
            'searx.plugins.unit_converter.SXNGPlugin': {'active': True},
            'searx.plugins.ahmia_filter.SXNGPlugin': {'active': True},
            'searx.plugins.hostnames.SXNGPlugin': {'active': True},
            'searx.plugins.time_zone.SXNGPlugin': {'active': True},
            'searx.plugins.oa_doi_rewrite.SXNGPlugin': {'active': False},
            'searx.plugins.tor_check.SXNGPlugin': {'active': False},
            'searx.plugins.tracker_url_remover.SXNGPlugin': {'active': True},
        },
        # SearXNG's default engine set, plus Google and Bing: they're off by default because
        # they block busy public instances, but answer a single private user reliably.
        'engines': [{'name': name, 'disabled': False} for name in EXTRA_ENGINES],
    }


def _write_settings(cfg: dict) -> None:
    import yaml  # pyyaml is one of SearXNG's own requirements

    text = '# Written by Stitch (stitch_searx.py) on every start; edits are overwritten.\n'
    text += yaml.safe_dump(_settings(cfg), sort_keys=False, allow_unicode=True)
    path = cfg['settings_path']
    try:
        with open(path, encoding='utf-8') as f:
            if f.read() == text:
                return
    except OSError:
        pass
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, path)


def _fast_yaml() -> None:
    """Parse YAML with libyaml (pyyaml's C loader, same results as SafeLoader). SearXNG reads its
    ~2,800-line default settings.yml with ``yaml.safe_load`` on every start, which in pure Python
    takes seconds on a phone and a noticeable moment on a PC."""
    import yaml  # pylint: disable=import-outside-toplevel

    loader = getattr(yaml, 'CSafeLoader', None)
    if loader is None or getattr(yaml.safe_load, '_stitch_fast', False):
        return

    def safe_load(stream):
        return yaml.load(stream, Loader=loader)  # noqa: S506 - CSafeLoader is the safe loader

    safe_load._stitch_fast = True  # type: ignore[attr-defined]
    yaml.safe_load = safe_load


def _platform_shims() -> None:
    # searx/valkeydb.py imports pwd at module level (only used on an error path).
    if 'pwd' not in sys.modules:
        try:
            import pwd  # noqa: F401  pylint: disable=import-outside-toplevel,unused-import
        except ImportError:
            stub = types.ModuleType('pwd')

            def getpwuid(uid):
                raise KeyError(f'getpwuid(): uid not found: {uid}')

            stub.getpwuid = getpwuid  # type: ignore[attr-defined]
            sys.modules['pwd'] = stub
    # curl_cffi needs add_reader(), which the default Proactor loop on Windows lacks
    # (it works around it with an extra selector thread and a warning). The policy API
    # is deprecated from 3.14, so only use it where it's still quiet.
    if sys.platform == 'win32' and sys.version_info < (3, 14):
        import asyncio  # pylint: disable=import-outside-toplevel

        policy = getattr(asyncio, 'WindowsSelectorEventLoopPolicy', None)
        if policy is not None:
            asyncio.set_event_loop_policy(policy())


def _ensure_app():
    """Import SearXNG (once). Returns the Flask app."""
    global _app
    if _app is not None:
        return _app
    with _lock:
        if _app is not None:
            return _app
        if _config is None:
            raise SearxError('stitch_searx.configure() must be called first', 500)
        import searx  # noqa: F401  loads settings from SEARXNG_SETTINGS_PATH

        # searx/version.py shells out to git unless version_frozen exists (the desktop build
        # writes one; this keeps other packagings working).
        try:
            import searx.version_frozen  # noqa: F401
        except ImportError:
            frozen = types.ModuleType('searx.version_frozen')
            frozen.VERSION_STRING = frozen.VERSION_TAG = frozen.DOCKER_TAG = '0.0.0'  # type: ignore[attr-defined]
            frozen.GIT_URL = 'https://github.com/searxng/searxng'  # type: ignore[attr-defined]
            frozen.GIT_BRANCH = 'master'  # type: ignore[attr-defined]
            sys.modules['searx.version_frozen'] = frozen
        import searx.webapp  # runs searx.webapp.init(): engines, plugins, network

        _app = searx.webapp.app
        return _app


def version() -> str:
    """SearXNG version string (e.g. ``2026.9.25+12f8b6515``) once loaded, else ''."""
    mod = sys.modules.get('searx.version')
    return str(getattr(mod, 'VERSION_STRING', '')) if mod else ''


def engines() -> list[str]:
    """Names of the enabled engines (loads SearXNG)."""
    _ensure_app()
    from searx.engines import engines as all_engines  # pylint: disable=import-outside-toplevel

    return sorted(name for name, e in all_engines.items() if not getattr(e, 'disabled', False))


# ─── Search ────────────────────────────────────────────────────────────────────


def _safe_level(value, default: int) -> int:
    try:
        v = int(value)
    except (TypeError, ValueError):
        return default
    return v if v in (0, 1, 2) else default


def _clean(text) -> str:
    return re.sub(r'\s+', ' ', str(text or '')).strip()


def _url_key(url: str) -> str:
    try:
        p = urlsplit(url.strip())
    except ValueError:
        return url.strip()
    host = (p.hostname or '').lower()
    if host.startswith('www.'):
        host = host[4:]
    scheme = 'https' if p.scheme.lower() in ('http', 'https') else p.scheme.lower()
    return urlunsplit((scheme, host, p.path.rstrip('/'), p.query, ''))


def _answer_text(a: dict) -> str:
    if not isinstance(a, dict):
        return _clean(a)
    if a.get('answer'):
        return _clean(a['answer'])
    if a.get('translations'):
        parts = []
        for item in a['translations'][:5]:
            t = _clean(item.get('text'))
            if item.get('definitions'):
                t += ' — ' + '; '.join(_clean(d) for d in item['definitions'][:3])
            if t:
                parts.append(t)
        return ' | '.join(parts)
    if a.get('current'):
        cur = a['current']
        parts = [_clean(cur.get('summary'))]
        hum = (cur.get('humidity') or {}).get('value') if isinstance(cur.get('humidity'), dict) else cur.get('humidity')
        if hum is not None:
            parts.append(f'humidity {hum}%')
        wind = cur.get('wind_speed')
        if isinstance(wind, dict) and wind.get('value') is not None:
            parts.append(f"wind {round(float(wind['value']), 1)} {wind.get('unit', 'm/s')}")
        text = ', '.join(p for p in parts if p)
        fc = [_clean(f.get('summary')) for f in (a.get('forecasts') or [])[:3] if isinstance(f, dict)]
        fc_times = [f.get('datetime') for f in (a.get('forecasts') or [])[:3] if isinstance(f, dict)]
        fc_lines = []
        for s, dt in zip(fc, fc_times):
            when = ''
            if isinstance(dt, dict):
                when = str(dt.get('datetime') or '')[:16].replace('T', ' ')
            elif dt:
                when = str(dt)[:16].replace('T', ' ')
            fc_lines.append(f'{when}: {s}' if when else s)
        if fc_lines:
            text += '. Forecast: ' + '; '.join(fc_lines)
        if a.get('service'):
            text += f" (via {a['service']})"
        return text
    return ''


def _infobox(boxes) -> dict | None:
    if not boxes:
        return None
    box = boxes[0]
    title = _clean(box.get('infobox'))
    lines = []
    content = _clean(box.get('content'))
    if content:
        lines.append(content)
    for attr in (box.get('attributes') or [])[:12]:
        label = _clean(attr.get('label'))
        value = attr.get('value')
        if isinstance(value, dict):
            value = value.get('label') or value.get('value') or ''
        value = _clean(value)
        if label and value:
            lines.append(f'{label}: {value}')
    url = box.get('id') if str(box.get('id') or '').startswith('http') else None
    if not url:
        for u in box.get('urls') or []:
            if str(u.get('url') or '').startswith('http'):
                url = u['url']
                break
    if not title and not lines:
        return None
    out = {'title': title, 'text': '\n'.join(lines)}
    if url:
        out['url'] = url
    return out


def search(req: dict) -> dict:
    """Search the web through SearXNG. ``req`` uses WebSearchRequest's fields:
    query, category, timeRange, language, page, limit, safeSearch.

    Returns WebSearchResult's fields (without ``where``, which the caller adds)."""
    t0 = time.monotonic()
    if not isinstance(req, dict):
        raise SearxError('search request must be an object', 400)
    query = _clean(req.get('query'))[:MAX_QUERY]
    # External bangs (!!w …) answer with a redirect instead of results.
    query = _clean(re.sub(r'(^|\s)!![^\s]*', ' ', query))
    if not query:
        raise SearxError('empty query', 400)

    params = {'q': query, 'format': 'json'}
    category = req.get('category') or 'general'
    if category not in CATEGORIES:
        raise SearxError(f'unknown category: {category}', 400)
    params['categories'] = category
    if req.get('timeRange'):
        if req['timeRange'] not in TIME_RANGES:
            raise SearxError(f"unknown timeRange: {req['timeRange']}", 400)
        params['time_range'] = req['timeRange']
    lang = str(req.get('language') or '').strip()
    if lang:
        if not re.fullmatch(r'[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*|auto|all', lang):
            raise SearxError(f'bad language: {lang}', 400)
        params['language'] = lang
    try:
        page_no = max(1, min(int(req.get('page') or 1), 10))
    except (TypeError, ValueError):
        page_no = 1
    params['pageno'] = str(page_no)
    default_safe = (_config or {}).get('safe_search', 1)
    params['safesearch'] = str(_safe_level(req.get('safeSearch', default_safe), default_safe))
    try:
        limit = max(1, min(int(req.get('limit') or DEFAULT_LIMIT), 50))
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT

    app = _ensure_app()
    client = app.test_client()
    # The in-process client stands in for a local reverse proxy (bot detection wants these headers).
    headers = {'Accept-Language': 'en-US,en;q=0.8', 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1'}
    resp = client.get('/search', query_string=params, environ_base={'REMOTE_ADDR': '127.0.0.1'}, headers=headers)
    try:
        body = resp.get_data(as_text=True)
    finally:
        resp.close()
    if resp.status_code != 200:
        try:
            msg = json.loads(body).get('error') or body
        except ValueError:
            msg = body[:200]
        raise SearxError(f'SearXNG: {_clean(msg) or resp.status}', 400 if resp.status_code == 400 else 502)
    data = json.loads(body)

    results = []
    seen = set()
    for r in data.get('results') or []:
        url = str(r.get('url') or '').strip()
        if not url.startswith(('http://', 'https://')):
            continue
        key = _url_key(url)
        if key in seen:
            continue
        seen.add(key)
        item = {
            'title': _clean(r.get('title')) or url,
            'url': url,
            'snippet': _clean(r.get('content'))[:600],
        }
        eng = r.get('engines') or ([r['engine']] if r.get('engine') else [])
        if eng:
            item['engines'] = sorted(set(str(e) for e in eng))
        if r.get('publishedDate'):
            item['published'] = str(r['publishedDate'])
        thumb = r.get('thumbnail') or r.get('thumbnail_src') or r.get('img_src')
        if isinstance(thumb, str) and thumb.startswith(('http://', 'https://')):
            item['thumbnail'] = thumb
        results.append(item)
        if len(results) >= limit:
            break

    answers = []
    for a in data.get('answers') or []:
        text = _answer_text(a)
        if text and text not in answers:
            answers.append(text)

    suggestions = []
    for s in list(data.get('corrections') or []) + list(data.get('suggestions') or []):
        s = _clean(s)
        if s and s not in suggestions:
            suggestions.append(s)

    unresponsive = []
    for u in data.get('unresponsive_engines') or []:
        if isinstance(u, (list, tuple)) and u:
            name = _clean(u[0])
            why = _clean(u[1]) if len(u) > 1 else ''
            unresponsive.append(f'{name} ({why})' if why else name)
        elif u:
            unresponsive.append(_clean(u))

    return {
        'query': query,
        'results': results,
        'answers': answers[:5],
        'suggestions': suggestions[:8],
        'infobox': _infobox(data.get('infoboxes')),
        'unresponsive': unresponsive,
        'tookMs': int((time.monotonic() - t0) * 1000),
    }


# ─── Page reader ───────────────────────────────────────────────────────────────


def _check_public(host: str, port: int) -> str:
    """Resolve ``host`` and refuse anything that isn't a public address. Returns the IP to use."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise SearxError(f"can't resolve {host}", 502) from e
    chosen = None
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split('%', 1)[0])
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if not ip.is_global or ip.is_multicast:
            raise SearxError(f'{host} is a private or local address', 403)
        if chosen is None:
            chosen = str(ip)
    if chosen is None:
        raise SearxError(f"can't resolve {host}", 502)
    return chosen


def _validate_url(url: str):
    if not isinstance(url, str) or len(url) > 4096:
        raise SearxError('invalid URL', 400)
    url = url.strip()
    p = urlparse(url)
    if p.scheme not in ('http', 'https') or not p.hostname:
        raise SearxError('only http(s) URLs can be opened', 400)
    if p.username or p.password:
        raise SearxError('URLs with credentials are not allowed', 400)
    try:
        port = p.port or (443 if p.scheme == 'https' else 80)
    except ValueError as e:
        raise SearxError('invalid port', 400) from e
    return url, p.hostname, port


_DROP_TAGS = {
    'script', 'style', 'noscript', 'svg', 'nav', 'footer', 'aside', 'form', 'iframe', 'template',
    'button', 'select', 'input', 'textarea', 'canvas', 'object', 'embed', 'dialog', 'map', 'audio',
    'video', 'picture', 'math', 'link', 'meta', 'head',
}
_DROP_ROLES = {'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog', 'alertdialog', 'menu', 'menubar', 'toolbar'}
_NOISE = re.compile(
    r'^(cookie[s]?|cookie-?(banner|notice|consent)|consent|gdpr|advert(isement)?s?|ads?|ad-?(slot|container|wrapper)|'
    r'sidebar|share|sharing|social|social-share|newsletter|promo|subscribe|breadcrumbs?|skip-?link|sr-only|'
    r'visually-hidden|screen-reader-text|mw-editsection|navbox|mw-jump-link|noprint|printfooter|headerlink)$',
    re.I,
)
_BLOCK = {
    'p', 'div', 'section', 'article', 'main', 'ul', 'ol', 'dl', 'table', 'blockquote', 'pre', 'figure',
    'figcaption', 'hr', 'address', 'details', 'summary', 'caption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'header', 'body', 'center', 'fieldset', 'legend',
}
_LINE = {'li', 'tr', 'dt', 'dd'}


_WS = re.compile(r'\s+')  # HTML text: any whitespace run (newlines included) is one space


class _Pre(str):
    """Text from <pre>: kept verbatim."""


def _is_noise(el) -> bool:
    if el.get('hidden') is not None or el.get('aria-hidden') == 'true':
        return True
    if (el.get('role') or '').lower() in _DROP_ROLES:
        return True
    style = (el.get('style') or '').replace(' ', '').lower()
    if 'display:none' in style or 'visibility:hidden' in style:
        return True
    tokens = (el.get('class') or '').split()
    if el.get('id'):
        tokens.append(el.get('id'))
    return any(_NOISE.match(t) for t in tokens)


def _text_len(el) -> int:
    return len(' '.join(el.text_content().split()))


def _link_density(el, total: int) -> float:
    if not total:
        return 0.0
    links = sum(len(' '.join((a.text_content() or '').split())) for a in el.iter('a'))
    return links / total


def _drop_link_farms(root) -> None:
    """Drop menus that are mostly links: language pickers, 'related' lists, tag clouds,
    and short blocks that are nothing but a link ("Edit links", "Skip to content")."""
    dropped: set = set()

    def gone(el) -> bool:
        return any(a in dropped for a in el.iterancestors())

    for el in list(root.iter('ul', 'ol', 'menu', 'dl', 'table')):
        if gone(el):
            continue
        items = len(el.findall('.//li')) + len(el.findall('.//tr')) + len(el.findall('.//dt'))
        total = _text_len(el)
        if items >= 3 and _link_density(el, total) > 0.7:
            dropped.add(el)
    for el in list(root.iter('p', 'div', 'span', 'section')):
        if el in dropped or gone(el):
            continue
        total = _text_len(el)
        if 0 < total <= 60 and _link_density(el, total) > 0.95 and el.getparent() is not None and el.getparent().tag not in ('p', 'li', 'td'):
            dropped.add(el)
    for el in dropped:
        if el.getparent() is not None:
            el.drop_tree()


def _html_to_text(raw: bytes, charset: str | None) -> tuple[str, str]:
    import lxml.html  # pylint: disable=import-outside-toplevel

    enc = charset
    if not enc:
        m = re.search(rb'<meta[^>]+charset\s*=\s*["\']?\s*([A-Za-z0-9_.:-]+)', raw[:8192], re.I)
        if m:
            enc = m.group(1).decode('ascii', 'ignore')
    if not enc:
        try:
            raw.decode('utf-8')
            enc = 'utf-8'
        except UnicodeDecodeError:
            enc = 'windows-1252'
    try:
        parser = lxml.html.HTMLParser(encoding=enc, remove_comments=True, remove_pis=True)
        doc = lxml.html.document_fromstring(raw, parser=parser)
    except (LookupError, ValueError):
        parser = lxml.html.HTMLParser(remove_comments=True, remove_pis=True)
        doc = lxml.html.document_fromstring(raw, parser=parser)

    title = _clean(doc.findtext('.//title'))
    if not title:
        og = doc.xpath('//meta[@property="og:title"]/@content')
        title = _clean(og[0]) if og else ''

    body = doc.find('body')
    if body is None:
        body = doc

    for el in list(body.iter()):
        if not isinstance(el.tag, str) or el.getparent() is None:
            continue
        tag = el.tag.lower()
        drop = tag in _DROP_TAGS or _is_noise(el)
        # A site header goes; an article's own header (title, byline) stays.
        if tag == 'header' and not el.xpath('ancestor::article|ancestor::main'):
            drop = True
        if drop:
            el.drop_tree()

    root = body
    body_len = _text_len(body)
    mains = body.xpath('.//main|.//*[@role="main"]')
    if mains:
        main = max(mains, key=_text_len)
        if _text_len(main) >= 200:
            root = main
    arts = root.xpath('.//article') or body.xpath('.//article')
    if arts:
        art = max(arts, key=_text_len)
        n = _text_len(art)
        if n >= 400 and n >= 0.35 * _text_len(root):
            root = art
    if root is not body and _text_len(root) < 0.1 * body_len:
        root = body
    if not title:
        h1 = root.xpath('.//h1')
        title = _clean(h1[0].text_content()) if h1 else ''
    _drop_link_farms(root)

    out: list[str] = []

    def walk(el, in_pre: bool, in_cell: bool) -> None:
        # in_cell: inside a short table cell (infobox values…), where everything stays on one line.
        tag = el.tag.lower() if isinstance(el.tag, str) else ''
        if tag == 'br':
            out.append(' ' if in_cell else '\n')
        elif tag:
            pre = in_pre or tag == 'pre'
            cell = in_cell
            if in_cell:
                if tag == 'li' and el.getprevious() is not None:
                    out.append(', ')
                elif tag in _BLOCK or tag in _LINE:
                    out.append(' ')
            else:
                if tag in _BLOCK:
                    out.append('\n\n')
                elif tag in _LINE:
                    out.append('\n')
                if tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
                    out.append('#' * int(tag[1]) + ' ')
                elif tag == 'li':
                    out.append('- ')
            if tag in ('td', 'th'):
                if el.getprevious() is not None:
                    out.append(' | ')
                cell = _text_len(el) <= 300
            if el.text:
                out.append(_Pre(el.text) if pre else _WS.sub(' ', el.text))
            for child in el:
                walk(child, pre, cell)
            if tag in _BLOCK and not in_cell:
                out.append('\n\n')
        if el.tail:
            out.append(_Pre(el.tail) if in_pre else _WS.sub(' ', el.tail))

    walk(root, False, False)

    parts: list[str] = []
    last = '\n'
    for seg in out:
        if isinstance(seg, _Pre):
            parts.append(seg)
            last = seg[-1:] or last
            continue
        seg = re.sub('[​‌‍⁠﻿­]', '', seg)
        seg = re.sub(r'[ \t\r\f\v ]+', ' ', seg)
        seg = re.sub(r' *\n *', '\n', seg)
        if last in (' ', '\n'):
            seg = seg.lstrip(' ')
        if seg.startswith('\n') and parts and not isinstance(parts[-1], _Pre):
            parts[-1] = parts[-1].rstrip(' ')
        if seg:
            parts.append(seg)
            last = seg[-1]
    text = ''.join(parts)
    lines = []
    for ln in text.split('\n'):
        stripped = ln.strip()
        if re.fullmatch(r'(#+|-|\|)?', stripped):
            lines.append('')
        else:
            lines.append(ln.rstrip())
    text = re.sub(r'\n{3,}', '\n\n', '\n'.join(lines)).strip()
    # Image captions and pull quotes often appear twice; keep the first copy.
    seen: set = set()
    paras = []
    for para in text.split('\n\n'):
        key = para.strip()
        if len(key) >= 40 or (paras and key == paras[-1].strip()):
            if key in seen:
                continue
            seen.add(key)
        paras.append(para)
    return title, '\n\n'.join(paras)


def _truncate(text: str, max_chars: int) -> tuple[str, bool]:
    if len(text) <= max_chars:
        return text, False
    cut = text[:max_chars]
    for sep in ('\n\n', '\n', '. ', ' '):
        i = cut.rfind(sep)
        if i >= max_chars * 0.8:
            cut = cut[: i + (1 if sep == '. ' else 0)]
            break
    return cut.rstrip(), True


def _charset(content_type: str) -> str | None:
    m = re.search(r'charset\s*=\s*"?([A-Za-z0-9_.:-]+)', content_type or '', re.I)
    return m.group(1) if m else None


def _decode(raw: bytes, charset: str | None) -> str:
    for enc in (charset, 'utf-8'):
        if not enc:
            continue
        try:
            return raw.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode('utf-8', 'replace')


def page(url: str, max_chars: int = 12000) -> dict:
    """Fetch ``url`` and reduce it to readable text.

    Returns ``{url (final, after redirects), title, text, truncated}``. HTML is reduced to
    its main content (headings as ``#`` lines, list items as ``- `` lines, paragraph breaks
    kept); plain text / JSON / XML pass through. PDFs and other binaries raise SearxError.
    Only public http(s) addresses are fetched (each redirect is checked too).
    """
    from curl_cffi import CurlOpt  # pylint: disable=import-outside-toplevel
    from curl_cffi import requests as creq  # pylint: disable=import-outside-toplevel

    try:
        max_chars = max(200, min(int(max_chars or 12000), 200_000))
    except (TypeError, ValueError):
        max_chars = 12000
    url, host, port = _validate_url(url)
    deadline = time.monotonic() + PAGE_DEADLINE
    headers = {
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9',
    }

    resp = None
    session = None
    for _hop in range(PAGE_MAX_REDIRECTS + 1):
        ip = _check_public(host, port)
        remaining = deadline - time.monotonic()
        if remaining <= 0.5:
            raise SearxError('timed out', 504)
        pin = f'{host}:{port}:[{ip}]' if ':' in ip else f'{host}:{port}:{ip}'
        session = creq.Session(impersonate='chrome', curl_options={CurlOpt.RESOLVE: [pin]})
        try:
            resp = session.get(url, headers=headers, allow_redirects=False, stream=True, timeout=min(PAGE_TIMEOUT, remaining))
        except Exception as e:  # pylint: disable=broad-except
            session.close()
            msg = str(e)
            if 'timed out' in msg.lower() or 'timeout' in msg.lower():
                raise SearxError('timed out', 504) from e
            raise SearxError(f"couldn't fetch the page ({_clean(msg)[:160]})", 502) from e
        if resp.status_code in (301, 302, 303, 307, 308) and resp.headers.get('location'):
            nxt = urljoin(url, resp.headers['location'])
            resp.close()
            session.close()
            url, host, port = _validate_url(nxt)
            continue
        break
    else:
        raise SearxError('too many redirects', 502)

    assert resp is not None and session is not None
    try:
        if resp.status_code in (401, 403, 429):
            raise SearxError(f"the site refused automated reading (HTTP {resp.status_code}); try another source", 502)
        if resp.status_code >= 400:
            raise SearxError(f'the site answered HTTP {resp.status_code}', 502)
        ctype = (resp.headers.get('content-type') or '').lower()
        buf = bytearray()
        for chunk in resp.iter_content():
            buf.extend(chunk)
            if len(buf) >= PAGE_MAX_BYTES:
                del buf[PAGE_MAX_BYTES:]
                break
            if time.monotonic() > deadline:
                break
        raw = bytes(buf)
    except SearxError:
        raise
    except Exception as e:  # pylint: disable=broad-except
        raise SearxError(f"couldn't read the page ({_clean(str(e))[:160]})", 502) from e
    finally:
        try:
            resp.close()
        finally:
            session.close()

    mime = ctype.split(';', 1)[0].strip()
    head = raw[:1024].lstrip().lower()
    if mime == 'application/pdf' or raw[:5] == b'%PDF-':
        raise SearxError('this is a PDF document; only web pages and plain text can be read', 415)
    if mime.startswith(('image/', 'audio/', 'video/', 'font/')):
        raise SearxError(f'not a text page ({mime})', 415)
    is_html = mime in ('text/html', 'application/xhtml+xml') or (
        not mime or mime == 'application/octet-stream'
    ) and (head.startswith(b'<!doctype html') or b'<html' in head)
    textual = mime.startswith('text/') or mime in ('application/json', 'application/xml', 'application/javascript') or mime.endswith(('+json', '+xml'))
    if is_html:
        title, text = _html_to_text(raw, _charset(ctype))
    elif textual or not mime:
        if not mime and b'\x00' in raw[:4096]:
            raise SearxError('not a text page (binary content)', 415)
        text = _decode(raw, _charset(ctype)).lstrip('﻿').replace('\r\n', '\n').replace('\f', '\n')
        text = re.sub(r'\n{3,}', '\n\n', '\n'.join(ln.rstrip() for ln in text.split('\n'))).strip('\n')
        title = ''
    else:
        raise SearxError(f'not a text page ({mime})', 415)

    text, truncated = _truncate(text, max_chars)
    return {'url': url, 'title': title or (urlparse(url).hostname or ''), 'text': text, 'truncated': truncated}


# ─── HTTP server (desktop) ─────────────────────────────────────────────────────


def serve(host: str = '127.0.0.1', port: int = 0, *, token: str | None = None) -> None:
    """Run the JSON API until killed:

    * ``GET /stitch/health`` → ``{ok, api, version}``
    * ``POST /stitch/search`` (JSON body = WebSearchRequest) → WebSearchResult fields
    * ``GET /stitch/page?url=…&max=…`` → ``{url, title, text, truncated}``

    Errors are ``{error}`` with a 4xx/5xx status. Loads SearXNG first, then prints exactly
    one line ``STITCH_SEARX_READY <port>`` to stdout once listening (``port`` 0 = any free
    port). With ``token`` (or ``STITCH_SEARX_TOKEN``), requests must send ``X-Stitch-Token``.
    """
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # pylint: disable=import-outside-toplevel

    token = token or os.environ.get('STITCH_SEARX_TOKEN') or None
    _ensure_app()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        server_version = 'StitchSearx/1'

        def log_message(self, format, *args):  # noqa: A002  pylint: disable=redefined-builtin
            pass

        def _send(self, status: int, obj) -> None:
            body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def _allowed(self) -> bool:
            # Loopback only, and no DNS-rebinding: the Host header must be a loopback name.
            hostname = (self.headers.get('Host') or '').rsplit(':', 1)[0].strip('[]').lower()
            if hostname not in ('127.0.0.1', 'localhost', '::1'):
                self._send(403, {'error': 'forbidden host'})
                return False
            if token and not secrets.compare_digest(self.headers.get('X-Stitch-Token') or '', token):
                self._send(401, {'error': 'unauthorized'})
                return False
            return True

        def _run(self, fn) -> None:
            try:
                self._send(200, fn())
            except SearxError as e:
                self._send(e.status, {'error': str(e)})
            except Exception as e:  # pylint: disable=broad-except
                sys.stderr.write(f'[stitch_searx] {type(e).__name__}: {e}\n')
                self._send(500, {'error': f'{type(e).__name__}: {e}'})

        def do_GET(self):  # noqa: N802
            if not self._allowed():
                return
            parts = urlsplit(self.path)
            qs = parse_qs(parts.query)
            one = lambda k: (qs.get(k) or [None])[0]  # noqa: E731
            if parts.path == '/stitch/health':
                self._send(200, {'ok': True, 'api': API_VERSION, 'version': version(), 'pid': os.getpid()})
            elif parts.path == '/stitch/page':
                self._run(lambda: page(one('url') or '', int(one('max') or 12000)))
            elif parts.path == '/stitch/search':
                self._run(lambda: search({'query': one('q') or one('query') or '', 'category': one('category'), 'limit': one('limit')}))
            else:
                self._send(404, {'error': 'not found'})

        def do_POST(self):  # noqa: N802
            if not self._allowed():
                return
            path = urlsplit(self.path).path
            try:
                length = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                length = -1
            if length < 0 or length > 64 * 1024:
                self._send(413, {'error': 'request too large'})
                return
            raw = self.rfile.read(length) if length else b''
            try:
                body = json.loads(raw.decode('utf-8') or '{}')
            except ValueError:
                self._send(400, {'error': 'invalid JSON'})
                return
            if path == '/stitch/search':
                self._run(lambda: search(body))
            elif path == '/stitch/page':
                self._run(lambda: page(str(body.get('url') or ''), int(body.get('maxChars') or body.get('max') or 12000)))
            else:
                self._send(404, {'error': 'not found'})

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        allow_reuse_address = False

    httpd = Server((host, port), Handler)
    sys.stdout.write(f'STITCH_SEARX_READY {httpd.server_address[1]}\n')
    sys.stdout.flush()
    try:
        httpd.serve_forever(poll_interval=0.5)
    finally:
        httpd.server_close()


def _exit_with_stdin() -> None:
    """Exit when stdin closes — the parent (Stitch) went away, even if it crashed."""

    def watch():
        try:
            while sys.stdin.buffer.read(4096):
                pass
        except Exception:  # pylint: disable=broad-except
            pass
        os._exit(0)

    threading.Thread(target=watch, name='stdin-watch', daemon=True).start()


def main(argv: list[str] | None = None) -> int:
    import argparse  # pylint: disable=import-outside-toplevel

    # Results are full of non-ASCII text; a Windows console would otherwise fail to print them.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')

    ap = argparse.ArgumentParser(prog='stitch_searx', description="Stitch's bundled SearXNG")
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name in ('serve', 'check', 'search', 'page'):
        p = sub.add_parser(name)
        p.add_argument('--data', required=True, help='data dir (settings, caches, secret)')
        p.add_argument('--safe', type=int, default=1, choices=(0, 1, 2))
        if name == 'serve':
            p.add_argument('--host', default='127.0.0.1')
            p.add_argument('--port', type=int, default=0)
            p.add_argument('--watch-stdin', action='store_true', help='exit when stdin closes')
        if name == 'search':
            p.add_argument('query')
            p.add_argument('--category', default='general')
            p.add_argument('--limit', type=int, default=DEFAULT_LIMIT)
        if name == 'page':
            p.add_argument('url')
            p.add_argument('--max', type=int, default=12000)
    args = ap.parse_args(argv)

    configure(args.data, safe_search=args.safe)
    if args.cmd == 'serve':
        if args.watch_stdin:
            _exit_with_stdin()
        serve(args.host, args.port)
        return 0
    if args.cmd == 'check':
        t0 = time.monotonic()
        names = engines()
        print(f'ok: SearXNG {version()} loaded in {time.monotonic() - t0:.1f}s with {len(names)} engines')
        return 0
    try:
        if args.cmd == 'search':
            out = search({'query': args.query, 'category': args.category, 'limit': args.limit})
        else:
            out = page(args.url, args.max)
    except SearxError as e:
        print(json.dumps({'error': str(e), 'status': e.status}))
        return 1
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
