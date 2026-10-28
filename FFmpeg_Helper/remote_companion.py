"""Same-Wi-Fi HTTP surface for the XVault Native Messaging Companion."""

from __future__ import annotations

import hashlib
import hmac
import http.server
import ipaddress
import datetime
import http.cookies
import json
import mimetypes
import os
import pathlib
import re
import secrets
import socket
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
from collections import OrderedDict
from typing import Callable

from remote_security import (
    DEFAULT_PERMISSIONS,
    PairingError,
    PairingManager,
    REMOTE_PERMISSIONS,
    host_is_allowed,
    origin_is_allowed,
    parse_byte_range,
)


MAX_REQUEST_BYTES = 32 * 1024
MAX_REMOTE_THREADS = 12
MEDIA_TOKEN_TTL = 20 * 60
MEDIA_CACHE_LIMIT = 48 * 1024 * 1024
TLS_CERT_DAYS = 825
ALLOWED_SORTS = {'new', 'old', 'likes', 'views', 'bookmarks', 'reposts', 'replies', 'media', 'author'}
POST_ID_RE = re.compile(r'^\d{1,32}$')


def find_lan_ipv4() -> str:
    """Choose one private IPv4 interface; never bind to every interface."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(('192.0.2.1', 9))
        address = probe.getsockname()[0]
        if address and ipaddress.ip_address(address).is_private and not address.startswith('127.'):
            return address
    except OSError:
        pass
    finally:
        probe.close()
    try:
        candidates = sorted({row[4][0] for row in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)})
    except OSError:
        candidates = []
    for address in candidates:
        try:
            socket.inet_aton(address)
            if ipaddress.ip_address(address).is_private and not address.startswith(('127.', '169.254.')):
                return address
        except OSError:
            continue
    return '127.0.0.1'


def create_tls_context(address: str, directory) -> tuple[ssl.SSLContext, str]:
    """Create or reuse a per-address local certificate; fail closed without TLS."""
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.x509.oid import NameOID
    except ImportError as error:
        raise RuntimeError('The Remote Companion TLS dependency is missing; run setup_remote.ps1') from error

    parsed_address = ipaddress.ip_address(address)
    key_name = hashlib.sha256(address.encode('ascii')).hexdigest()[:16]
    directory = pathlib.Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    cert_path = directory / f'.xvault-remote-{key_name}.pem'
    key_path = directory / f'.xvault-remote-{key_name}.key'
    certificate = None
    try:
        certificate = x509.load_pem_x509_certificate(cert_path.read_bytes())
        private_key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
        sans = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        if (private_key.public_key().public_numbers() != certificate.public_key().public_numbers() or
                parsed_address not in sans.get_values_for_type(x509.IPAddress) or
                certificate.not_valid_after_utc <= datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=30)):
            certificate = None
    except (OSError, ValueError, x509.ExtensionNotFound):
        certificate = None

    if certificate is None:
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'XVault Remote local companion')])
        now = datetime.datetime.now(datetime.timezone.utc)
        certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=5))
            .not_valid_after(now + datetime.timedelta(days=TLS_CERT_DAYS))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(parsed_address)]), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
        cert_bytes = certificate.public_bytes(serialization.Encoding.PEM)
        key_bytes = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                      serialization.NoEncryption())
        cert_path.write_bytes(cert_bytes)
        key_path.write_bytes(key_bytes)
        try:
            os.chmod(cert_path, 0o600)
            os.chmod(key_path, 0o600)
        except OSError:
            pass
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(str(cert_path), str(key_path))
    fingerprint = certificate.fingerprint(hashes.SHA256()).hex(':').upper()
    return context, fingerprint


class BoundedHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 32

    def __init__(self, address, handler, app):
        self.app = app
        self._slots = threading.BoundedSemaphore(MAX_REMOTE_THREADS)
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        if not self._slots.acquire(timeout=0.25):
            try:
                request.sendall(b'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            except OSError:
                pass
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def handle_error(self, request, client_address):
        # Phones can close a media stream while scrolling or changing networks.
        # Treat expected transport disconnects as cancellation, not server faults.
        error = sys.exc_info()[1]
        if isinstance(error, (BrokenPipeError, ConnectionResetError, ssl.SSLError)):
            return
        super().handle_error(request, client_address)


class MediaTokenStore:
    """Short-lived opaque media grants bound to the device that received them."""

    def __init__(self, root, path_resolver: Callable[[str], pathlib.Path | None], clock=time.time):
        self.root = pathlib.Path(root).resolve()
        self.path_resolver = path_resolver
        self.clock = clock
        self._lock = threading.RLock()
        self._grants = OrderedDict()

    def grant(self, device_id: str, file_record: dict) -> tuple[str, pathlib.Path]:
        filename = str(file_record.get('filename') or '')
        if not filename or len(filename) > 520 or '\x00' in filename:
            raise ValueError('Invalid local media reference')
        normalized = filename.replace('\\', '/')
        parts = normalized.split('/')
        absolute = pathlib.Path(filename).is_absolute()
        # Native Chrome download records use absolute paths. They stay on this
        # trusted bridge and must still resolve strictly beneath the archive root.
        if (normalized.startswith('//') or not absolute and (normalized.startswith('/') or ':' in parts[0]) or
                any(part in ('.', '..') for part in parts) or not absolute and any(not part for part in parts)):
            raise ValueError('Invalid local media reference')
        if absolute:
            try:
                pathlib.Path(filename).relative_to(self.root)
            except ValueError as error:
                raise ValueError('Local media is outside the XVault folder') from error
        resolved = self.path_resolver(filename if absolute else normalized)
        if not resolved:
            raise ValueError('Local media is outside the XVault folder')
        path = pathlib.Path(resolved).resolve(strict=True)
        try:
            path.relative_to(self.root)
        except ValueError as error:
            raise ValueError('Local media is outside the XVault folder') from error
        if not path.is_file():
            raise ValueError('Local media is unavailable')
        token = secrets.token_urlsafe(32)
        key = hashlib.sha256(token.encode('utf-8')).hexdigest()
        grant = {
            'device': str(device_id),
            'path': path,
            'expires': self.clock() + MEDIA_TOKEN_TTL,
            'type': str(file_record.get('type') or 'other')[:24],
            'mediaId': str(file_record.get('mediaId') or '')[:80],
        }
        with self._lock:
            self._purge()
            self._grants[key] = grant
            while len(self._grants) > 3000:
                self._grants.popitem(last=False)
        return f'/api/media/{token}', path

    def resolve(self, token: str, device_id: str) -> dict | None:
        key = hashlib.sha256(str(token or '').encode('utf-8')).hexdigest()
        with self._lock:
            self._purge()
            row = self._grants.get(key)
            if not row or not hmac.compare_digest(row['device'], str(device_id)):
                return None
            self._grants.move_to_end(key)
            try:
                if row['path'].resolve(strict=True) != row['path'] or not row['path'].is_file():
                    return None
            except OSError:
                return None
            return dict(row)

    def revoke_device(self, device_id: str) -> None:
        with self._lock:
            for key, row in list(self._grants.items()):
                if hmac.compare_digest(row['device'], str(device_id)):
                    self._grants.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._grants.clear()

    def _purge(self) -> None:
        now = self.clock()
        for key, row in list(self._grants.items()):
            if now >= row['expires']:
                self._grants.pop(key, None)


class ThumbnailCache:
    def __init__(self, max_bytes=MEDIA_CACHE_LIMIT):
        self.max_bytes = max_bytes
        self._size = 0
        self._entries = OrderedDict()
        self._lock = threading.Lock()

    def get(self, path: pathlib.Path, width: int, ffmpeg: str | None = None) -> bytes | None:
        try:
            stat = path.stat()
            key = (str(path), stat.st_size, stat.st_mtime_ns, width)
        except OSError:
            return None
        with self._lock:
            item = self._entries.get(key)
            if item:
                self._entries.move_to_end(key)
                return item
        data = self._create(path, width, ffmpeg)
        if not data or len(data) > 4 * 1024 * 1024:
            return None
        with self._lock:
            self._entries[key] = data
            self._size += len(data)
            while self._size > self.max_bytes and self._entries:
                _, removed = self._entries.popitem(last=False)
                self._size -= len(removed)
        return data

    @staticmethod
    def _create(path: pathlib.Path, width: int, ffmpeg: str | None) -> bytes | None:
        if path.suffix.lower() in {'.mp4', '.webm', '.mov', '.m4v'}:
            if not ffmpeg:
                return None
            try:
                result = subprocess.run(
                    [ffmpeg, '-hide_banner', '-loglevel', 'error', '-ss', '0', '-i', str(path),
                     '-frames:v', '1', '-vf', f'scale=min({width}\\,iw):-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8, check=True,
                )
                return result.stdout
            except (OSError, subprocess.SubprocessError):
                return None
        try:
            import warnings
            from PIL import Image, ImageOps
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(path) as image:
                    if image.width * image.height > 48_000_000:
                        return None
                    frame = ImageOps.exif_transpose(image)
                    try:
                        frame.seek(0)
                    except EOFError:
                        pass
                    frame.thumbnail((width, width), Image.Resampling.LANCZOS)
                    if frame.mode not in ('RGB', 'L'):
                        background = Image.new('RGB', frame.size, '#16191c')
                        if 'A' in frame.getbands():
                            background.paste(frame, mask=frame.getchannel('A'))
                        else:
                            background.paste(frame.convert('RGB'))
                        frame = background
                    elif frame.mode == 'L':
                        frame = frame.convert('RGB')
                    from io import BytesIO
                    output = BytesIO()
                    frame.save(output, format='JPEG', quality=76, optimize=True)
                    return output.getvalue()
        except Exception:
            return None


class RemoteCompanion:
    def __init__(self, rpc: Callable[[str, dict], dict], media_root, path_resolver,
                 ui_root, device_store, bind_host=None, port=18765, ffmpeg=None, manager=None):
        self.rpc = rpc
        self.media_root = pathlib.Path(media_root).resolve()
        self.path_resolver = path_resolver
        self.ui_root = pathlib.Path(ui_root).resolve()
        self.device_store = pathlib.Path(device_store)
        self.bind_host = bind_host
        self.port = int(port)
        self.ffmpeg = ffmpeg
        self.manager = manager or PairingManager(device_store=self.device_store)
        self.media = MediaTokenStore(self.media_root, self.path_resolver)
        self.thumbnails = ThumbnailCache()
        self._server = None
        self._thread = None
        self._lock = threading.RLock()
        self._origins = set()
        self._hosts = set()
        self._tls_fingerprint = ''

    @property
    def base_url(self):
        if not self._server:
            return ''
        host, port = self._server.server_address[:2]
        return f'https://{host}:{port}'

    @property
    def origin(self):
        return self.base_url

    @property
    def listening(self):
        return self._server is not None

    def start(self):
        with self._lock:
            if self._server:
                return self.status()
            address = self.bind_host or find_lan_ipv4()
            tls_context, self._tls_fingerprint = create_tls_context(address, self.device_store.parent)
            server = BoundedHTTPServer((address, self.port), self._make_handler(), self)
            server.socket = tls_context.wrap_socket(server.socket, server_side=True)
            server.timeout = 10
            self._server = server
            host, port = server.server_address[:2]
            authority = f'{host}:{port}'
            self._hosts = {authority.lower(), f'127.0.0.1:{port}', f'localhost:{port}'}
            self._origins = {f'https://{item}' for item in self._hosts}
            self._thread = threading.Thread(target=server.serve_forever, name='XVaultRemoteHTTP', daemon=True)
            self._thread.start()
            return self.status()

    def stop(self):
        with self._lock:
            server, self._server = self._server, None
            self.manager.revoke_invite()
            self.media.clear()
            self._origins.clear()
            self._hosts.clear()
        if server:
            server.shutdown()
            server.server_close()
        return {'ok': True, 'listening': False}

    def status(self):
        return {'ok': True, 'listening': bool(self._server), 'baseUrl': self.base_url,
                'host': self._server.server_address[0] if self._server else None,
                'port': self._server.server_address[1] if self._server else None,
                'pairedDevices': len(self.manager.list_devices()),
                'certificateFingerprint': self._tls_fingerprint if self._server else None}

    def control(self, name: str, payload=None):
        payload = payload if isinstance(payload, dict) else {}
        if name == 'remote.start':
            return self.start()
        if name == 'remote.stop':
            return self.stop()
        if name == 'pairing.start' or name == 'pairing.regenerate':
            if not self.listening:
                self.start()
            invite = self.manager.create_invite(self.base_url)
            return {**invite, 'status': self.status()}
        if name == 'pairing.pending':
            return {'rows': self.manager.list_pending()}
        if name == 'pairing.approve':
            device = self.manager.approve_pairing(payload.get('requestId'), payload.get('permissions'))
            return {'ok': True, 'device': device}
        if name == 'pairing.deny':
            self.manager.deny_pairing(payload.get('requestId'))
            return {'ok': True}
        if name == 'devices.list':
            return {'rows': self.manager.list_devices()}
        if name == 'device.permissions':
            device = self.manager.set_permissions(payload.get('deviceId'), payload.get('permissions') or [])
            if not device:
                raise ValueError('Paired device not found')
            return {'ok': True, 'device': device}
        if name == 'device.revoke':
            device_id = str(payload.get('deviceId') or '')
            if not self.manager.revoke_device(device_id):
                return {'ok': False, 'error': 'Paired device not found'}
            self.media.revoke_device(device_id)
            return {'ok': True}
        if name == 'remote.status':
            return self.status()
        raise ValueError('Unsupported Companion command')

    def media_url_for(self, device_id: str, record: dict) -> str:
        url, _ = self.media.grant(device_id, record)
        return url

    def _make_handler(self):
        app = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'
            server_version = 'XVaultRemote'
            sys_version = ''

            def setup(self):
                super().setup()
                self.connection.settimeout(10)

            def log_message(self, fmt, *args):
                # Pairing codes, bearer credentials, and LAN paths never enter logs.
                return

            def _headers(self, content_type='application/json; charset=utf-8', length=None, extra=None):
                self.send_header('Content-Type', content_type)
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Referrer-Policy', 'no-referrer')
                self.send_header('X-Frame-Options', 'DENY')
                self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
                self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
                self.send_header('Connection', 'close')
                if length is not None:
                    self.send_header('Content-Length', str(length))
                for key, value in (extra or {}).items():
                    self.send_header(key, str(value))

            def _send(self, status, value, headers=None):
                data = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                self.send_response(status)
                self._headers(length=len(data), extra=headers)
                if self.headers.get('Origin') and origin_is_allowed(self.headers.get('Origin'), app._origins):
                    self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
                    self.send_header('Vary', 'Origin')
                self.end_headers()
                try:
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                self.close_connection = True

            def _send_bytes(self, status, data, content_type, extra=None):
                self.send_response(status)
                self._headers(content_type, len(data), extra)
                self.end_headers()
                if self.command != 'HEAD':
                    try:
                        self.wfile.write(data)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                self.close_connection = True

            def _base_checks(self, require_origin=False):
                if not host_is_allowed(self.headers.get('Host'), app._hosts):
                    self._send(421, {'error': 'This Host is not served by XVault Remote'})
                    return False
                origin = self.headers.get('Origin')
                if (origin and not origin_is_allowed(origin, app._origins)) or (require_origin and not origin):
                    self._send(403, {'error': 'This request origin is not allowed'})
                    return False
                return True

            def _body(self):
                raw_length = self.headers.get('Content-Length', '')
                if not raw_length.isdigit():
                    self._send(411, {'error': 'A bounded Content-Length is required'})
                    return None
                length = int(raw_length)
                limit = 1200 * 1024 if urllib.parse.urlparse(self.path).path == '/api/note' else MAX_REQUEST_BYTES
                if length < 0 or length > limit:
                    self._send(413, {'error': 'Request is too large'})
                    return None
                try:
                    result = json.loads(self.rfile.read(length) or b'{}')
                except (json.JSONDecodeError, UnicodeDecodeError):
                    self._send(400, {'error': 'Request JSON is malformed'})
                    return None
                if not isinstance(result, dict):
                    self._send(400, {'error': 'A JSON object is required'})
                    return None
                return result

            def _device(self, permission):
                credential = self._credential()
                if not credential:
                    self._send(401, {'error': 'Pair this device with XVault to continue'})
                    return None
                device = app.manager.authorize(credential, permission)
                if not device:
                    # Distinguish revoked/unknown from a known device missing a grant.
                    known = app.manager.authorize(credential)
                    if known:
                        self._send(403, {'error': f'This device does not have {permission} permission'})
                    else:
                        self._send(401, {'error': 'This device is no longer paired'})
                    return None
                return device

            def _credential(self):
                authorization = self.headers.get('Authorization', '')
                if authorization.startswith('Bearer ') and len(authorization) <= 180:
                    return authorization[7:]
                cookie = http.cookies.SimpleCookie()
                try:
                    cookie.load(self.headers.get('Cookie', ''))
                    value = cookie.get('xvault_device')
                    credential = value.value if value else ''
                except (http.cookies.CookieError, AttributeError):
                    return ''
                return credential if len(credential) <= 180 else ''

            def do_OPTIONS(self):
                if not self._base_checks(require_origin=True):
                    return
                self.send_response(204)
                self._headers(length=0, extra={
                    'Access-Control-Allow-Origin': self.headers['Origin'],
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range',
                    'Access-Control-Max-Age': '300',
                    'Vary': 'Origin',
                })
                self.end_headers()
                self.close_connection = True

            def do_GET(self):
                if not self._base_checks():
                    return
                parsed = urllib.parse.urlsplit(self.path)
                path = parsed.path
                if path in ('/', '/index.html', '/pair'):
                    return self._static('index.html', 'text/html; charset=utf-8')
                if path in ('/remote.css', '/remote.js', '/remote-drafts.js', '/remote-sw.js', '/manifest.webmanifest', '/app-icon.svg', '/app-icon-192.png', '/app-icon-512.png', '/remote-font.woff2'):
                    names = {'/remote.css': ('remote.css', 'text/css; charset=utf-8'),
                             '/remote.js': ('remote.js', 'text/javascript; charset=utf-8'),
                             '/remote-drafts.js': ('remote-drafts.js', 'text/javascript; charset=utf-8'),
                             '/remote-sw.js': ('remote-sw.js', 'text/javascript; charset=utf-8'),
                             '/manifest.webmanifest': ('manifest.webmanifest', 'application/manifest+json'),
                             '/app-icon.svg': ('app-icon.svg', 'image/svg+xml'),
                             '/app-icon-192.png': ('app-icon-192.png', 'image/png'),
                             '/app-icon-512.png': ('app-icon-512.png', 'image/png'),
                             '/remote-font.woff2': ('remote-font.woff2', 'font/woff2')}
                    name, mime = names[path]
                    return self._static(name, mime)
                if path == '/api/status':
                    return self._send(200, {'ok': True, 'service': 'XVault Remote'})
                if path == '/api/session':
                    device = self._device(None)
                    if not device:
                        return
                    try:
                        preferences = app.rpc('ui.preferences', {})
                    except Exception:
                        preferences = {'motion': 'off'}
                    motion = preferences.get('motion', 'off') if isinstance(preferences, dict) else 'off'
                    session = {'deviceId': device['id'], 'name': device['name'],
                               'permissions': device['permissions'], 'motion': motion if motion in ('normal', 'reduced', 'off') else 'off'}
                    revision = preferences.get('libraryRevision') if isinstance(preferences, dict) else None
                    if 'library.read' in device['permissions'] and isinstance(revision, int) and not isinstance(revision, bool) and 0 <= revision <= 9_007_199_254_740_991:
                        session['libraryRevision'] = revision
                    return self._send(200, session)
                if path == '/api/pair/pending':
                    return self._send(405, {'error': 'Pairing requests are checked from XVault on the desktop'})
                if path.startswith('/api/media/'):
                    return self._serve_media(path.rsplit('/', 1)[-1], parsed.query)
                if path == '/api/activity':
                    device = self._device('library.read')
                    if not device:
                        return
                    try:
                        result = app.rpc('activity.latest', {'limit': 40})
                        return self._send(200, result if isinstance(result, dict) else {'rows': []})
                    except Exception:
                        return self._send(502, {'error': 'XVault could not read recent activity'})
                if path == '/api/views':
                    device = self._device('library.read')
                    if not device:
                        return
                    try:
                        result = app.rpc('library.views', {})
                        source = result.get('rows', []) if isinstance(result, dict) else []
                        rows, seen = [], set()
                        for row in source[:100] if isinstance(source, list) else []:
                            if not isinstance(row, dict):
                                continue
                            identity = str(row.get('id') or '')[:128]
                            query = str(row.get('query') or '')
                            if not identity or identity in seen or len(query) > 1000:
                                continue
                            seen.add(identity)
                            sort = row.get('sort')
                            rows.append({'id': identity, 'name': str(row.get('name') or 'Saved view')[:120],
                                         'query': query, 'sort': sort if isinstance(sort, str) and sort in ALLOWED_SORTS else 'new'})
                        return self._send(200, {'rows': rows})
                    except Exception:
                        return self._send(502, {'error': 'XVault could not read saved views'})
                return self._send(404, {'error': 'Route not found'})

            def do_POST(self):
                if not self._base_checks(require_origin=True):
                    return
                parsed = urllib.parse.urlsplit(self.path)
                payload = self._body()
                if payload is None:
                    return
                if parsed.path == '/api/pair/request':
                    try:
                        request = app.manager.request_pairing(payload.get('token'), payload.get('name'), self.client_address[0])
                    except PairingError as error:
                        return self._send(429 if 'Too many' in str(error) else 401, {'error': str(error)})
                    return self._send(202, request)
                if parsed.path == '/api/pair/claim':
                    result = app.manager.claim_pairing(payload.get('requestId'), payload.get('claimToken'))
                    if not result:
                        return self._send(202, {'approved': False})
                    credential = str(result.get('credential') or '')
                    safe_result = {key: result.get(key) for key in ('deviceId', 'name', 'permissions')}
                    return self._send(200, safe_result, {'Set-Cookie': f'xvault_device={credential}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Strict'})
                if parsed.path == '/api/forget':
                    credential = self._credential()
                    device = app.manager.authorize(credential) if credential else None
                    if device:
                        app.manager.revoke_device(device['id'])
                        app.media.revoke_device(device['id'])
                    return self._send(200, {'ok': True}, {'Set-Cookie': 'xvault_device=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict'})
                if parsed.path == '/api/library':
                    device = self._device('library.read')
                    if not device:
                        return
                    query = str(payload.get('query') or '').strip()
                    sort = str(payload.get('sort') or 'new')
                    limit = payload.get('limit', 40)
                    cursor = payload.get('cursor')
                    session_id = str(payload.get('sessionId') or '')
                    if (len(query) > 1000 or sort not in ALLOWED_SORTS or not isinstance(limit, (int, float)) or
                            not re.fullmatch(r'[0-9a-fA-F-]{36}', session_id)):
                        return self._send(400, {'error': 'Search options are invalid'})
                    if cursor is not None and (not isinstance(cursor, str) or len(cursor) > 4096):
                        return self._send(400, {'error': 'Search cursor is invalid'})
                    try:
                        result = app.rpc('library.query', {'query': query, 'sort': sort,
                                                           'limit': max(1, min(50, int(limit))), 'cursor': cursor,
                                                           'deviceId': device['id'], 'sessionId': session_id.lower()})
                        return self._decorate_page(result, device)
                    except Exception as error:
                        message = str(error)
                        if message.startswith('Search results expired'):
                            return self._send(410, {'error': 'Search results expired; refresh the search'})
                        if message.startswith('This search is larger'):
                            return self._send(422, {'error': 'This search is too large for one Remote session; narrow the search'})
                        return self._send(502, {'error': 'XVault could not search the local Library'})
                if parsed.path == '/api/download':
                    device = self._device('downloads.manage')
                    if not device:
                        return
                    if 'library.read' not in device['permissions']:
                        return self._send(403, {'error': 'Library access is required to save archived media'})
                    post_id, offset, limit = str(payload.get('id') or ''), payload.get('offset', 0), payload.get('limit', 32)
                    version = payload.get('mediaVersion', '')
                    if (set(payload) - {'id', 'offset', 'limit', 'mediaVersion'} or not POST_ID_RE.fullmatch(post_id) or
                            isinstance(offset, bool) or not isinstance(offset, int) or not 0 <= offset <= 10000 or
                            isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 32 or
                            not isinstance(version, str) or version and not re.fullmatch(r'[0-9a-f]{64}', version)):
                        return self._send(400, {'error': 'Download options are invalid; choose archived media only'})
                    try:
                        result = app.rpc('library.download', {'id': post_id, 'offset': offset, 'limit': limit, 'mediaVersion': version})
                        if result.get('stale'):
                            return self._send(409, {'error': 'This post media changed; reopen the post before saving more'})
                        if result.get('missing'):
                            return self._send(404, {'error': 'This archived post is no longer available'})
                        if result.get('ok') is False:
                            return self._send(502, {'error': 'XVault could not queue this request. Check Downloads on your computer.'})
                        safe_result = {key: max(0, min(1_000_000, int(result.get(key) or 0))) for key in ('added', 'skipped', 'filtered', 'unavailable', 'mediaCount')}
                        next_offset = result.get('nextOffset')
                        safe_result.update({'ok': True, 'blocked': result.get('blocked') is True,
                                            'nextOffset': next_offset if isinstance(next_offset, int) and offset < next_offset <= 10000 else None,
                                            'mediaVersion': str(result.get('mediaVersion') or '')[:64]})
                        return self._send(200, safe_result)
                    except Exception:
                        return self._send(502, {'error': 'XVault could not queue archived media'})
                if parsed.path == '/api/media/page':
                    device = self._device('media.read')
                    if not device:
                        return
                    if 'library.read' not in device['permissions']:
                        return self._send(403, {'error': 'Library access is not enabled for this phone'})
                    post_id = str(payload.get('id') or '')
                    offset = payload.get('offset')
                    version = payload.get('mediaVersion', '')
                    if (not POST_ID_RE.fullmatch(post_id) or not isinstance(offset, int) or
                            isinstance(offset, bool) or offset < 0 or offset > 1_000_000 or
                            not isinstance(version, str) or len(version) > 128):
                        return self._send(400, {'error': 'Media page options are invalid'})
                    try:
                        result = app.rpc('library.media.page', {'id': post_id, 'offset': offset,
                                                               'limit': 16, 'mediaVersion': version})
                        if result.get('stale'):
                            return self._send(410, {'error': 'Post media changed; reopen the viewer'})
                        media = []
                        for item in result.get('media', [])[:16]:
                            if not isinstance(item, dict):
                                continue
                            item = {key: item.get(key) for key in ('mediaId', 'type', 'mime', 'width', 'height', 'filename', 'shared', 'ownerPostId')}
                            path = None
                            if item.get('filename'):
                                try:
                                    path, _ = app.media.grant(device['id'], item)
                                except (OSError, ValueError):
                                    path = None
                            media.append({'index': int(offset) + len(media), 'mediaId': str(item.get('mediaId') or '')[:80],
                                          'type': str(item.get('type') or 'other')[:24],
                                          'mime': str(item.get('mime') or '')[:80],
                                          'width': max(0, min(100000, int(item.get('width') or 0))),
                                          'height': max(0, min(100000, int(item.get('height') or 0))),
                                          'shared': item.get('shared') is True, 'ownerPostId': str(item.get('ownerPostId') or '')[:32],
                                          'url': path})
                        return self._send(200, {'id': post_id, 'offset': offset,
                                                'mediaCount': max(0, min(1_000_000, int(result.get('mediaCount') or 0))),
                                                'mediaVersion': str(result.get('mediaVersion') or '')[:128],
                                                'media': media,
                                                'nextOffset': result.get('nextOffset')})
                    except Exception:
                        return self._send(502, {'error': 'XVault could not read this media page'})
                if parsed.path == '/api/favorite':
                    device = self._device('favorite.write')
                    if not device:
                        return
                    post_id = str(payload.get('id') or '')
                    favorite = payload.get('favorite')
                    if not POST_ID_RE.fullmatch(post_id) or not isinstance(favorite, bool):
                        return self._send(400, {'error': 'Favorite update is invalid'})
                    try:
                        result = app.rpc('library.favorite', {'id': post_id, 'favorite': favorite})
                        return self._send(200, result)
                    except Exception:
                        return self._send(502, {'error': 'Favorite could not be saved'})
                if parsed.path == '/api/tag':
                    device = self._device('tags.write')
                    if not device:
                        return
                    post_id = str(payload.get('id') or '')
                    tag = ' '.join(str(payload.get('tag') or '').replace('#', '').split())[:40]
                    if not POST_ID_RE.fullmatch(post_id) or not tag:
                        return self._send(400, {'error': 'Tag update is invalid'})
                    try:
                        result = app.rpc('library.tag', {'id': post_id, 'tag': tag})
                        return self._send(200, result)
                    except Exception:
                        return self._send(502, {'error': 'Tag could not be saved'})
                if parsed.path in ('/api/note', '/api/note/read'):
                    device = self._device('notes.write')
                    if not device:
                        return
                    post_id = str(payload.get('id') or '')
                    note = payload.get('note')
                    if not POST_ID_RE.fullmatch(post_id):
                        return self._send(400, {'error': 'Note update is invalid'})
                    try:
                        if parsed.path == '/api/note/read':
                            return self._send(200, app.rpc('library.note.read', {'id': post_id}))
                        baseline = payload.get('expectedNote')
                        if not isinstance(note, str) or not isinstance(baseline, str) or len(note) > 100000 or len(baseline) > 100000:
                            return self._send(400, {'error': 'A complete note and its saved baseline are required'})
                        result = app.rpc('library.note', {'id': post_id, 'note': note, 'expectedNote': baseline})
                        if result.get('conflict'):
                            return self._send(409, result)
                        if result.get('ok') is False:
                            return self._send(404, result)
                        return self._send(200, result)
                    except Exception:
                        return self._send(502, {'error': 'Note could not be saved'})
                return self._send(404, {'error': 'Route not found'})

            def _decorate_page(self, result, device):
                if not isinstance(result, dict) or not isinstance(result.get('rows'), list):
                    return self._send(502, {'error': 'XVault returned an invalid Library page'})
                try:
                    scanned = max(0, min(1_000_000_000, int(result.get('scanned') or 0)))
                except (TypeError, ValueError, OverflowError):
                    scanned = 0
                rows = []
                for source in result['rows'][:50]:
                    if not isinstance(source, dict) or not POST_ID_RE.fullmatch(str(source.get('id') or '')):
                        continue
                    row = {key: source.get(key) for key in ('id', 'link', 'text', 'handle', 'name',
                           'createdAt', 'archivedAt', 'metrics', 'sensitive', 'favorite', 'tags',
                           'mediaCount', 'mediaTypes')}
                    row['link'] = self._valid_post_link(row.get('link'), str(row['id']))
                    row['media'] = []
                    if 'media.read' in device['permissions']:
                        local_media = source.get('localMedia')
                        if isinstance(local_media, list):
                            for item in local_media[:32]:
                                if not isinstance(item, dict):
                                    continue
                                try:
                                    path, _ = app.media.grant(device['id'], item)
                                except (OSError, ValueError):
                                    continue
                                row['media'].append({'url': path, 'type': str(item.get('type') or 'other')[:24],
                                                     'mediaId': str(item.get('mediaId') or '')[:80],
                                                     'width': int(item.get('width') or 0),
                                                     'height': int(item.get('height') or 0), 'shared': item.get('shared') is True, 'ownerPostId': str(item.get('ownerPostId') or '')[:32]})
                    row['mediaState'] = ('permission-required' if 'media.read' not in device['permissions'] else
                                         'local' if row['media'] else
                                         'missing' if source.get('localMedia') else 'not-downloaded') if row.get('mediaCount') else 'none'
                    rows.append(row)
                return self._send(200, {'rows': rows, 'matched': max(0, int(result.get('matched') or 0)),
                                        'nextCursor': result.get('nextCursor') if isinstance(result.get('nextCursor'), str) else None,
                                        'hasMore': bool(result.get('hasMore')),
                                        'cancelled': bool(result.get('cancelled')),
                                        'matchedExact': result.get('matchedExact') is not False,
                                        'truncated': bool(result.get('truncated')),
                                        'scanned': scanned,
                                        'sort': str(result.get('sort') or 'new'),
                                        'permissions': list(device.get('permissions') or [])})

            @staticmethod
            def _valid_post_link(value, post_id):
                try:
                    parsed = urllib.parse.urlsplit(str(value or ''))
                    match = re.fullmatch(r'/[A-Za-z0-9_]{1,15}/status/(\d{1,32})/?', parsed.path)
                    port = parsed.port
                    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or
                            port not in (None, 443) or parsed.query or parsed.fragment or not re.fullmatch(r'[A-Za-z0-9.-]{1,253}', parsed.hostname) or
                            not match or match.group(1) != post_id):
                        return None
                    return urllib.parse.urlunsplit(parsed)
                except (TypeError, ValueError):
                    return None

            def _serve_media(self, token, raw_query):
                credential = self._credential()
                if not credential:
                    return self._send(401, {'error': 'Pair this device with XVault to continue'})
                device = app.manager.authorize(credential, 'media.read')
                if not device:
                    return self._send(401, {'error': 'Media access is unavailable for this device'})
                grant = app.media.resolve(token, device['id'])
                if not grant:
                    return self._send(404, {'error': 'This media link has expired'})
                path = grant['path']
                query = urllib.parse.parse_qs(raw_query)
                tier = (query.get('tier') or ['original'])[0]
                save_file = query.get('download')
                if save_file is not None and (save_file != ['1'] or tier != 'original'):
                    return self._send(400, {'error': 'File download options are invalid'})
                if tier in ('contact', 'thumb', 'preview'):
                    width = 160 if tier == 'contact' else 480 if tier == 'thumb' else 1280
                    data = app.thumbnails.get(path, width, app.ffmpeg)
                    if not data:
                        return self._send(415, {'error': 'A local preview could not be generated'})
                    return self._send_bytes(200, data, 'image/jpeg', {'Accept-Ranges': 'none'})
                if tier != 'original':
                    return self._send(400, {'error': 'Media size is invalid'})
                try:
                    size = path.stat().st_size
                    start, end = (0, size - 1)
                    status = 200
                    extra = {'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline'}
                    if save_file == ['1']:
                        fallback = re.sub(r'[^A-Za-z0-9._ -]', '_', path.name)[:180] or 'media'
                        extra['Content-Disposition'] = f'attachment; filename="{fallback}"; filename*=UTF-8\'\'{urllib.parse.quote(path.name, safe="")}'
                    range_header = self.headers.get('Range')
                    if range_header:
                        start, end = parse_byte_range(range_header, size)
                        status = 206
                        extra['Content-Range'] = f'bytes {start}-{end}/{size}'
                    length = max(0, end - start + 1)
                    self.send_response(status)
                    self._headers(mimetypes.guess_type(path.name)[0] or 'application/octet-stream', length,
                                  {**extra, 'Cache-Control': 'private, no-store'})
                    self.end_headers()
                    with path.open('rb') as stream:
                        stream.seek(start)
                        remaining = length
                        while remaining:
                            block = stream.read(min(64 * 1024, remaining))
                            if not block:
                                break
                            self.wfile.write(block)
                            remaining -= len(block)
                    self.close_connection = True
                except ValueError:
                    self._send(416, {'error': 'Requested media range is unavailable'}, {'Content-Range': f'bytes */{path.stat().st_size}'})
                except (OSError, BrokenPipeError, ConnectionResetError):
                    self.close_connection = True

            def _static(self, filename, mime):
                target = (app.ui_root / filename).resolve()
                try:
                    target.relative_to(app.ui_root)
                    data = target.read_bytes()
                except (ValueError, OSError):
                    return self._send(503, {'error': 'Remote interface files are unavailable'})
                return self._send_bytes(200, data, mime)

        return Handler


__all__ = ['RemoteCompanion', 'MediaTokenStore', 'ThumbnailCache', 'find_lan_ipv4']
