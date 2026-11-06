import importlib.util
import ipaddress
import json
import pathlib
import ssl
import tempfile
import sys
import urllib.error
import urllib.request
import unittest
from types import SimpleNamespace
from unittest.mock import patch


MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / 'FFmpeg_Helper' / 'remote_companion.py'
sys.path.insert(0, str(MODULE_PATH.parent))
spec = importlib.util.spec_from_file_location('xvault_remote_companion_test', MODULE_PATH)
companion_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(companion_module)


class RemoteCompanionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.image = self.root / 'photo.jpg'
        self.image.write_bytes(b'0123456789abcdef')
        self.calls = []

        def rpc(method, payload):
            self.calls.append((method, payload))
            if method == 'library.query':
                return {'rows': [{'id': '123456789', 'link': 'https://fixvx.com/ada/status/123456789',
                                 'text': 'A local photo', 'mediaCount': 1,
                                 'localMedia': [{'filename': 'photo.jpg', 'mediaId': 'asset-1', 'type': 'photo'}]}],
                        'matched': 1, 'nextCursor': None}
            if method == 'library.favorite':
                return {'ok': True, 'favorite': payload['favorite']}
            return {'ok': True}

        self.app = companion_module.RemoteCompanion(
            rpc=rpc,
            media_root=self.root,
            path_resolver=lambda value: (self.root / value).resolve() if value == 'photo.jpg' else None,
            ui_root=pathlib.Path(__file__).resolve().parents[1] / 'FFmpeg_Helper' / 'remote-ui',
            device_store=self.root / 'devices.json',
            bind_host='127.0.0.1',
            port=0,
        )
        self.app.start()
        self.tls = ssl._create_unverified_context()

    def tearDown(self):
        self.app.stop()
        self.temp.cleanup()

    def test_portable_draft_model_is_served_locally(self):
        status, headers, body = self.request('/remote-drafts.js')
        self.assertEqual(status, 200)
        self.assertIn('javascript', headers.get('Content-Type', ''))
        self.assertIn(b'XVaultRemoteDrafts', body)

    def test_saved_views_are_permission_checked_bounded_and_projected(self):
        device = self.paired_device()
        self.app.rpc = lambda method, payload: {'rows': [{'id': str(i), 'name': 'Reference',
            'query': 'tag:reference', 'sort': 'old', 'credential': 'secret', 'path': 'C:/private'} for i in range(1000)]}
        status, _, body = self.request('/api/views', credential=device['credential'])
        self.assertEqual(status, 200)
        rows = json.loads(body)['rows']
        self.assertEqual(len(rows), 100)
        self.assertEqual(set(rows[0]), {'id', 'name', 'query', 'sort'})
        self.assertNotIn(b'secret', body)
        self.app.control('device.permissions', {'deviceId': device['deviceId'], 'permissions': ['media.read']})
        status, _, _ = self.request('/api/views', credential=device['credential'])
        self.assertEqual(status, 403)

    def test_install_icons_are_served_as_local_pngs(self):
        for size in (192, 512):
            status, headers, body = self.request(f'/app-icon-{size}.png')
            self.assertEqual(status, 200)
            self.assertIn('image/png', headers.get('Content-Type', ''))
            self.assertTrue(body.startswith(b'\x89PNG\r\n\x1a\n'))

    def test_session_revision_requires_library_permission_and_safe_integer(self):
        device = self.paired_device()
        self.app.rpc = lambda method, payload: {'motion': 'normal', 'libraryRevision': 42, 'privateNote': 'secret'}
        status, _, body = self.request('/api/session', credential=device['credential'])
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['libraryRevision'], 42)
        self.assertNotIn(b'secret', body)
        self.app.control('device.permissions', {'deviceId': device['deviceId'], 'permissions': ['media.read']})
        _, _, body = self.request('/api/session', credential=device['credential'])
        self.assertNotIn('libraryRevision', json.loads(body))

    def test_pc_downloads_require_grant_and_accept_only_archived_ranges(self):
        device = self.paired_device()
        origin = {'Origin': self.app.origin}
        status, _, _ = self.request('/api/download', {'id': '123456789'}, device['credential'], origin, 'POST')
        self.assertEqual(status, 403)
        self.app.control('device.permissions', {'deviceId': device['deviceId'], 'permissions': ['library.read', 'downloads.manage']})
        self.app.rpc = lambda method, payload: (self.calls.append((method, payload)) or {'ok': True, 'added': 2, 'skipped': 1, 'mediaCount': 100, 'nextOffset': 32, 'mediaVersion': 'a' * 64, 'privatePath': str(self.root)})
        status, _, body = self.request('/api/download', {'id': '123456789'}, device['credential'], origin, 'POST')
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertEqual(result['added'], 2)
        self.assertEqual(self.calls[-1], ('library.download', {'id': '123456789', 'offset': 0, 'limit': 32, 'mediaVersion': ''}))
        self.assertNotIn('privatePath', result)
        for payload in ({'id': '123456789', 'force': True}, {'id': '123456789', 'url': 'http://localhost/private'}, {'id': '123456789', 'offset': True}, {'id': '123456789', 'limit': 33}, {'id': '123456789', 'mediaVersion': 'bad'}):
            status, _, _ = self.request('/api/download', payload, device['credential'], origin, 'POST')
            self.assertEqual(status, 400)
        self.app.rpc = lambda method, payload: {'ok': False, 'stale': True}
        status, _, _ = self.request('/api/download', {'id': '123456789'}, device['credential'], origin, 'POST')
        self.assertEqual(status, 409)

    def test_phone_download_streams_protected_original_as_attachment(self):
        device = self.paired_device()
        media_url = self.app.media_url_for(device['deviceId'], {'filename': 'photo.jpg'})
        status, headers, body = self.request(media_url + '?download=1', credential=device['credential'])
        self.assertEqual(status, 200)
        self.assertEqual(body, self.image.read_bytes())
        self.assertIn('attachment', headers['Content-Disposition'])
        self.assertIn("filename*=UTF-8''photo.jpg", headers['Content-Disposition'])
        self.assertNotIn(str(self.root), headers['Content-Disposition'])
        for query in ('?download=1&tier=thumb', '?download=2', '?download=1&download=1'):
            status, _, _ = self.request(media_url + query, credential=device['credential'])
            self.assertEqual(status, 400)

    def test_contact_strip_requests_a_small_local_preview(self):
        device = self.paired_device()
        media_url = self.app.media_url_for(device['deviceId'], {'filename': 'photo.jpg'})
        with patch.object(self.app.thumbnails, 'get', return_value=b'bounded-jpeg') as preview:
            status, headers, body = self.request(media_url + '?tier=contact', credential=device['credential'])
            self.assertEqual(status, 200)
            self.assertIn('image/jpeg', headers['Content-Type'])
            self.assertEqual(body, b'bounded-jpeg')
            self.assertEqual(preview.call_args.args[1], 160)

    def test_rich_post_context_is_reshaped_and_never_carries_markup_or_urls(self):
        device = self.paired_device()
        self.app.rpc = lambda method, payload: {'rows': [{
            'id': '123456789', 'text': 'Quote post', 'handle': 'ada', 'mediaCount': 0, 'verified': True,
            'replyTo': 'Grace', 'thread': False, 'readLater': True, 'hasNote': True, 'noteText': 'private',
            'quote': {'id': '42', 'handle': 'grace', 'name': 'Grace', 'text': 'x' * 900, 'mediaCount': 2,
                      'url': 'https://evil.example/', 'html': '<img onerror=alert(1)>'},
            'card': {'title': 'A link', 'domain': 'example.com', 'url': 'javascript:alert(1)'},
        }, {'id': '987654321', 'replyTo': 'not a handle!', 'quote': {'id': 'nope'}, 'card': {'domain': 'bad domain/'}}],
            'matched': 2}
        status, _, body = self.request('/api/library', {'query': '', 'sort': 'new', 'limit': 40,
                                       'sessionId': 'a21fc96b-0101-4afc-89a1-71f03859cd92'},
                                       device['credential'], {'Origin': self.app.origin}, 'POST')
        self.assertEqual(status, 200)
        rows = json.loads(body)['rows']
        first, second = rows
        self.assertTrue(first['verified'])
        self.assertEqual(first['replyTo'], 'grace')
        self.assertTrue(first['readLater'])
        self.assertTrue(first['hasNote'])
        self.assertNotIn('noteText', first)
        self.assertEqual(set(first['quote']), {'id', 'handle', 'name', 'text', 'createdAt', 'mediaCount'})
        self.assertEqual(len(first['quote']['text']), 280)
        self.assertEqual(first['card'], {'title': 'A link', 'domain': 'example.com'})
        self.assertIsNone(second['replyTo'])
        self.assertIsNone(second['quote'])
        self.assertIsNone(second['card'])
        self.assertNotIn(b'javascript', body)
        self.assertNotIn(b'onerror', body)
        self.assertNotIn(b'private', body)

    def test_download_monitor_is_read_only_without_manage_permission(self):
        device = self.paired_device()
        calls = []

        def rpc(method, payload):
            calls.append((method, payload))
            if method == 'downloads.status':
                return {'countsReady': True, 'queued': 3, 'failed': 1, 'downloading': 1, 'active': 1,
                        'transfers': [{'name': 'clip.mp4', 'state': 'downloading', 'bytesReceived': 10,
                                       'totalBytes': 100, 'postId': '123', 'path': 'C:/Users/me/clip.mp4'}],
                        'recent': [{'name': 'a.jpg', 'state': 'failed', 'error': 'HTTP 403', 'postId': 'bad'}],
                        'folder': 'C:/Users/me/Downloads'}
            if method == 'library.overview':
                return {'totals': {'posts': 5, 'media': 7, 'secret': 1},
                        'months': [{'key': '2025-01', 'count': 2}, {'key': '<b>', 'count': 9}],
                        'authors': [{'handle': 'ada', 'name': 'Ada', 'count': 3}, {'handle': 'no way', 'count': 1}]}
            return {'ok': True, 'paused': 2}
        self.app.rpc = rpc
        status, _, body = self.request('/api/downloads', credential=device['credential'])
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertEqual(result['queued'], 3)
        self.assertEqual(result['transfers'][0]['totalBytes'], 100)
        self.assertNotIn('path', result['transfers'][0])
        self.assertIsNone(result['recent'][0]['postId'])
        self.assertEqual(result['recent'][0]['error'], 'HTTP 403')
        self.assertFalse(result['canManage'])
        self.assertNotIn(b'C:/Users', body)
        status, _, _ = self.request('/api/downloads/control', {'action': 'pause'}, device['credential'],
                                    {'Origin': self.app.origin}, 'POST')
        self.assertEqual(status, 403)
        self.assertNotIn(('downloads.control', {'action': 'pause'}), calls)
        self.app.control('device.permissions', {'deviceId': device['deviceId'],
                                                'permissions': ['library.read', 'downloads.manage']})
        status, _, body = self.request('/api/downloads/control', {'action': 'shutdown'}, device['credential'],
                                       {'Origin': self.app.origin}, 'POST')
        self.assertEqual(status, 400)
        status, _, body = self.request('/api/downloads/control', {'action': 'pause'}, device['credential'],
                                       {'Origin': self.app.origin}, 'POST')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'ok': True, 'action': 'pause', 'count': 2})
        status, _, body = self.request('/api/overview', credential=device['credential'])
        self.assertEqual(status, 200)
        overview = json.loads(body)
        self.assertEqual(overview['totals']['posts'], 5)
        self.assertNotIn('secret', overview['totals'])
        self.assertEqual(overview['months'], [{'key': '2025-01', 'count': 2}])
        self.assertEqual([row['handle'] for row in overview['authors']], ['ada'])
        self.app.control('device.permissions', {'deviceId': device['deviceId'], 'permissions': ['media.read']})
        self.assertEqual(self.request('/api/overview', credential=device['credential'])[0], 403)
        self.assertEqual(self.request('/api/downloads', credential=device['credential'])[0], 403)

    def test_post_link_projection_requires_https_and_matching_stable_identity(self):
        validate = self.app._make_handler()._valid_post_link
        self.assertEqual(validate('https://fixvx.com/ada/status/123', '123'), 'https://fixvx.com/ada/status/123')
        self.assertIsNone(validate('https://fixvx.com/ada/status/124', '123'))
        self.assertIsNone(validate('javascript://x/ada/status/123', '123'))
        self.assertIsNone(validate('https://user@example.com/ada/status/123', '123'))

    def test_library_response_preserves_incremental_query_progress(self):
        device = self.paired_device()
        self.app.rpc = lambda method, payload: {'rows': [], 'matched': 0, 'matchedExact': False,
            'truncated': False, 'scanned': 2500, 'hasMore': True, 'nextCursor': 'opaque', 'sort': 'new'}
        status, _, body = self.request('/api/library', {'query': 'rare', 'sort': 'new', 'limit': 40, 'sessionId': 'a21fc96b-0101-4afc-89a1-71f03859cd92'},
                                       device['credential'], {'Origin': self.app.origin}, 'POST')
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertFalse(result['matchedExact'])
        self.assertFalse(result['cancelled'])
        self.assertTrue(result['hasMore'])
        self.assertEqual(result['scanned'], 2500)

    def test_library_response_preserves_query_cancellation(self):
        device = self.paired_device()
        self.app.rpc = lambda method, payload: {'rows': [], 'matched': 0, 'cancelled': True,
            'matchedExact': False, 'hasMore': False}
        status, _, body = self.request('/api/library', {'query': 'rare', 'sort': 'new', 'limit': 40, 'sessionId': 'a21fc96b-0101-4afc-89a1-71f03859cd92'},
                                       device['credential'], {'Origin': self.app.origin}, 'POST')
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertTrue(result['cancelled'])
        self.assertEqual(result['rows'], [])

    def test_remote_media_page_is_permission_checked_versioned_and_bounded(self):
        device = self.paired_device()
        origin = {'Origin': self.app.origin}
        self.app.control('device.permissions', {'deviceId': device['deviceId'],
                                                 'permissions': ['library.read']})
        payload = {'id': '123456789', 'offset': 16, 'mediaVersion': 'fixture-v1'}
        status, _, _ = self.request('/api/media/page', payload, device['credential'], origin, 'POST')
        self.assertEqual(status, 403, 'media access is independently granted')
        self.app.control('device.permissions', {'deviceId': device['deviceId'],
                                                 'permissions': ['library.read', 'media.read']})
        def rpc(method, request):
            self.calls.append((method, request))
            return {'id': '123456789', 'offset': 16, 'mediaCount': 100, 'mediaVersion': 'fixture-v1',
                    'media': [{'mediaId': str(index), 'type': 'photo', 'filename': 'photo.jpg',
                               'privateNote': 'must not cross the boundary'} for index in range(16, 36)],
                    'nextOffset': 32}
        self.app.rpc = rpc
        status, _, body = self.request('/api/media/page', payload, device['credential'], origin, 'POST')
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertEqual(len(result['media']), 16)
        self.assertEqual((result['media'][0]['index'], result['media'][-1]['index']), (16, 31))
        self.assertEqual(result['mediaCount'], 100)
        self.assertEqual(self.calls[-1][0], 'library.media.page')
        self.assertEqual(self.calls[-1][1]['limit'], 16)
        self.assertNotIn('privateNote', body.decode())
        self.app.rpc = lambda method, request: {'stale': True}
        status, _, body = self.request('/api/media/page', payload, device['credential'], origin, 'POST')
        self.assertEqual(status, 410)
        self.assertIn('media changed', json.loads(body)['error'])

    def request(self, path, body=None, credential=None, headers=None, method=None, cookie_credential=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.app.base_url + path, data=data, method=method,
                                         headers={'Content-Type': 'application/json', **(headers or {})})
        if credential:
            request.add_header('Authorization', f'Bearer {credential}')
        if cookie_credential:
            request.add_header('Cookie', f'xvault_device={cookie_credential}')
        try:
            with urllib.request.urlopen(request, timeout=3, context=self.tls) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            result = error.code, error.headers, error.read()
            error.close()
            return result

    def paired_device(self):
        invite = self.app.control('pairing.start')
        token = invite['token']
        origin = {'Origin': self.app.origin}
        status, _, body = self.request('/api/pair/request', {'token': token, 'name': 'Test phone'}, headers=origin)
        self.assertEqual(status, 202)
        pending = json.loads(body)
        self.assertRegex(pending['pairingCode'], r'^\d{6}$')
        self.assertEqual(pending['pairingCode'], invite['code'])
        self.app.control('pairing.approve', {'requestId': pending['requestId']})
        status, headers, body = self.request('/api/pair/claim', {
            'requestId': pending['requestId'], 'claimToken': pending['claimToken']
        }, headers=origin)
        self.assertEqual(status, 200)
        self.assertIn('Secure', headers.get('Set-Cookie', ''))
        self.assertIn('HttpOnly', headers.get('Set-Cookie', ''))
        self.assertNotIn('credential', json.loads(body))
        credential = headers.get('Set-Cookie', '').split('xvault_device=', 1)[1].split(';', 1)[0]
        return {**json.loads(body), 'credential': credential}

    def test_pairing_query_and_server_side_permission_enforcement(self):
        device = self.paired_device()
        origin = {'Origin': self.app.origin}
        status, _, body = self.request('/api/library', {'query': '', 'sort': 'new', 'limit': 20, 'sessionId': 'a21fc96b-0101-4afc-89a1-71f03859cd92'},
                                       device['credential'], origin, 'POST')
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertEqual(result['rows'][0]['media'][0]['type'], 'photo')
        self.assertNotIn(str(self.image), body.decode())
        self.assertEqual(self.calls[-1][0], 'library.query')
        self.assertEqual(self.calls[-1][1]['sessionId'], 'a21fc96b-0101-4afc-89a1-71f03859cd92')

        status, _, _ = self.request('/api/favorite', {'id': '123456789', 'favorite': True},
                                     device['credential'], origin, 'POST')
        self.assertEqual(status, 403)
        self.app.control('device.permissions', {'deviceId': device['deviceId'],
                                                 'permissions': ['library.read', 'media.read', 'favorite.write']})
        status, _, body = self.request('/api/favorite', {'id': '123456789', 'favorite': True},
                                       device['credential'], origin, 'POST')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['favorite'], True)
        self.app.control('device.revoke', {'deviceId': device['deviceId']})
        status, _, _ = self.request('/api/library', {'query': '', 'sessionId': 'a21fc96b-0101-4afc-89a1-71f03859cd92'}, device['credential'], origin, 'POST')
        self.assertEqual(status, 401)

    def test_notes_require_baseline_and_report_conflicts_without_truncation(self):
        device = self.paired_device()
        origin = {'Origin': self.app.origin}
        payload = {'id': '123456789', 'note': 'new note', 'expectedNote': 'old note'}
        status, _, _ = self.request('/api/note/read', {'id': payload['id']}, device['credential'], origin, 'POST')
        self.assertEqual(status, 403)
        self.app.control('device.permissions', {'deviceId': device['deviceId'], 'permissions': ['library.read', 'notes.write']})
        status, _, _ = self.request('/api/note/read', {'id': payload['id']}, device['credential'], origin, 'POST')
        self.assertEqual(status, 200)
        self.assertEqual(self.calls[-1][0], 'library.note.read')
        with patch.object(self.app, 'rpc', return_value={'ok': False, 'conflict': True, 'note': 'changed elsewhere', 'error': 'Changed'}) as rpc:
            payload['note'] = 'x' * 3000
            status, _, body = self.request('/api/note', payload, device['credential'], origin, 'POST')
            self.assertEqual(status, 409)
            self.assertEqual(json.loads(body)['note'], 'changed elsewhere')
            self.assertEqual(len(rpc.call_args[0][1]['note']), 3000)
            self.assertEqual(rpc.call_args[0][1]['expectedNote'], 'old note')
        del payload['expectedNote']
        status, _, _ = self.request('/api/note', payload, device['credential'], origin, 'POST')
        self.assertEqual(status, 400)

    def test_host_origin_and_default_security_headers(self):
        self.assertTrue(self.app.base_url.startswith('https://'))
        self.assertRegex(self.app.status()['certificateFingerprint'], r'^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$')
        from cryptography import x509
        certificate = x509.load_pem_x509_certificate(ssl.get_server_certificate(('127.0.0.1', self.app.status()['port'])).encode())
        sans = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        self.assertIn(ipaddress.ip_address('127.0.0.1'), sans.get_values_for_type(x509.IPAddress))
        status, headers, body = self.request('/api/pair/request', {'token': 'bad', 'name': 'Phone'},
                                             headers={'Origin': 'http://evil.example'}, method='POST')
        self.assertEqual(status, 403)
        self.assertEqual(headers.get('X-Content-Type-Options'), 'nosniff')
        self.assertIn("default-src 'self'", headers.get('Content-Security-Policy', ''))
        self.assertNotIn(b'bad', body)

        request = urllib.request.Request(self.app.base_url + '/api/status', headers={'Host': 'evil.example'})
        try:
            urllib.request.urlopen(request, timeout=3, context=self.tls)
            self.fail('unexpected Host should be rejected')
        except urllib.error.HTTPError as error:
            self.assertEqual(error.code, 421)
            error.close()

    def test_expected_client_disconnects_do_not_log_server_tracebacks(self):
        server = self.app._server
        reset = ConnectionResetError('client closed the connection')
        with patch.object(companion_module.sys, 'exc_info', return_value=(ConnectionResetError, reset, None)), \
                patch.object(companion_module.http.server.ThreadingHTTPServer, 'handle_error') as parent:
            server.handle_error(None, ('127.0.0.1', 1))
            parent.assert_not_called()

        failure = RuntimeError('unexpected server error')
        with patch.object(companion_module.sys, 'exc_info', return_value=(RuntimeError, failure, None)), \
                patch.object(companion_module.http.server.ThreadingHTTPServer, 'handle_error') as parent:
            server.handle_error(None, ('127.0.0.1', 1))
            parent.assert_called_once()

    def test_media_tokens_are_device_bound_and_stream_http_ranges(self):
        device = self.paired_device()
        media_url = self.app.media_url_for(device['deviceId'], {'filename': 'photo.jpg', 'type': 'photo'})
        token_path = media_url.replace(self.app.base_url, '')
        status, headers, body = self.request(token_path + '?tier=original', cookie_credential=device['credential'],
                                            headers={'Origin': self.app.origin, 'Range': 'bytes=2-5'})
        self.assertEqual(status, 206)
        self.assertEqual(body, b'2345')
        self.assertEqual(headers.get('Content-Range'), 'bytes 2-5/16')

        other = self.paired_device()
        status, _, _ = self.request(token_path + '?tier=original', credential=other['credential'],
                                    headers={'Origin': self.app.origin})
        self.assertEqual(status, 404)

    def test_photo_thumbnail_route_returns_a_compact_jpeg(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest('Pillow is an optional thumbnail dependency')
        Image.new('RGB', (640, 480), '#62765a').save(self.image, format='JPEG')
        device = self.paired_device()
        media_url = self.app.media_url_for(device['deviceId'], {'filename': 'photo.jpg', 'type': 'photo'})
        status, headers, body = self.request(media_url + '?tier=thumb', cookie_credential=device['credential'],
                                             headers={'Origin': self.app.origin})
        self.assertEqual(status, 200)
        self.assertEqual(headers.get('Content-Type'), 'image/jpeg')
        self.assertTrue(body.startswith(b'\xff\xd8'))
        self.assertLess(len(body), 100_000)

    def test_video_thumbnail_escapes_ffmpeg_filter_separators(self):
        source = self.root / 'sample.mp4'
        source.write_bytes(b'video fixture')
        with patch.object(companion_module.subprocess, 'run', return_value=SimpleNamespace(stdout=b'jpeg-bytes')) as run:
            result = companion_module.ThumbnailCache._create(source, 480, 'ffmpeg')
        self.assertEqual(result, b'jpeg-bytes')
        command = run.call_args.args[0]
        self.assertIn(r'scale=min(480\,iw):-2', command)

    def test_phone_forget_revokes_server_credential_and_clears_cookie(self):
        device = self.paired_device()
        status, headers, body = self.request('/api/forget', {}, headers={'Origin': self.app.origin},
                                             method='POST', cookie_credential=device['credential'])
        self.assertEqual(status, 200)
        self.assertIn('Max-Age=0', headers.get('Set-Cookie', ''))
        status, _, _ = self.request('/api/library', {'query': '', 'sessionId': 'a21fc96b-0101-4afc-89a1-71f03859cd92'}, cookie_credential=device['credential'],
                                    headers={'Origin': self.app.origin}, method='POST')
        self.assertEqual(status, 401)

    def test_non_local_asset_paths_are_never_granted(self):
        device = self.paired_device()
        for filename in ('../outside.jpg', 'C:\\Windows\\win.ini', '/etc/passwd', '\\\\example.invalid\\share\\photo.jpg'):
            with self.assertRaises(ValueError):
                self.app.media_url_for(device['deviceId'], {'filename': filename})

    def test_chrome_absolute_download_paths_are_granted_only_inside_archive(self):
        device = self.paired_device()
        self.app.media.path_resolver = lambda value: pathlib.Path(value).resolve()
        media_url = self.app.media_url_for(device['deviceId'], {'filename': str(self.image.resolve())})
        status, _, body = self.request(media_url, credential=device['credential'])
        self.assertEqual(status, 200)
        self.assertEqual(body, self.image.read_bytes())
        with tempfile.TemporaryDirectory() as other:
            outside = pathlib.Path(other) / 'outside.jpg'
            outside.write_bytes(b'outside archive')
            with self.assertRaises(ValueError):
                self.app.media_url_for(device['deviceId'], {'filename': str(outside)})

    def test_library_keeps_absolute_chrome_media_and_serves_thumbnail(self):
        from PIL import Image
        Image.new('RGB', (30, 20), '#c39b59').save(self.image)
        device = self.paired_device()
        self.app.media.path_resolver = lambda value: pathlib.Path(value).resolve()
        self.app.rpc = lambda method, payload: {'rows': [{'id': '123456789', 'mediaCount': 1,
            'localMedia': [{'filename': str(self.image.resolve()), 'type': 'photo'}]}], 'matched': 1}
        status, _, body = self.request('/api/library', {'query': '', 'sessionId': 'a21fc96b-0101-4afc-89a1-71f03859cd92'},
            credential=device['credential'], headers={'Origin': self.app.origin}, method='POST')
        self.assertEqual(status, 200)
        row = json.loads(body)['rows'][0]
        self.assertEqual(row['mediaState'], 'local')
        self.assertEqual(len(row['media']), 1)
        self.assertNotIn(str(self.root), body.decode())
        status, headers, image = self.request(row['media'][0]['url'] + '?tier=thumb', credential=device['credential'])
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'image/jpeg')
        self.assertTrue(image.startswith(b'\xff\xd8'))


if __name__ == '__main__':
    unittest.main()
