import importlib.util
import json
import pathlib
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import unittest
from http.server import ThreadingHTTPServer


HELPER_PATH = pathlib.Path(__file__).resolve().parents[1] / 'FFmpeg_Helper' / 'xvault_ffmpeg_helper.py'
spec = importlib.util.spec_from_file_location('xvault_helper_origin_test', HELPER_PATH)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class HelperExtensionOriginTests(unittest.TestCase):
    def test_bootstrap_exposes_token_only_to_exact_configured_extension(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            extension_id = 'a' * 32
            helper.CFG = root / 'config.json'
            helper.TOKEN_FILE = root / '.token'
            helper.LOG = root / 'helper.log'
            helper.CFG.write_text(json.dumps({'extension_id': extension_id}), encoding='utf-8')
            helper.TOKEN_FILE.write_text('local-helper-secret', encoding='utf-8')
            server = ThreadingHTTPServer(('127.0.0.1', 0), helper.API)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f'http://127.0.0.1:{server.server_address[1]}'
            try:
                request = urllib.request.Request(base + '/bootstrap', headers={'Origin': f'chrome-extension://{extension_id}'})
                with urllib.request.urlopen(request, timeout=3) as response:
                    result = json.loads(response.read())
                    self.assertEqual(result['token'], 'local-helper-secret')
                    self.assertEqual(response.headers.get('Access-Control-Allow-Origin'), f'chrome-extension://{extension_id}')
                attacker = 'b' * 32
                request = urllib.request.Request(base + '/bootstrap', headers={'Origin': f'chrome-extension://{attacker}'})
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(request, timeout=3)
                self.assertEqual(error.exception.code, 403)
                denied_body = error.exception.read()
                error.exception.close()
                self.assertNotIn(b'local-helper-secret', denied_body)
                self.assertIsNone(error.exception.headers.get('Access-Control-Allow-Origin'))
                # POST /bootstrap (what the extension sends since 22.0: Chromium drops Origin on extension GETs)
                # needs no token but the same exact origin; no Origin at all is refused.
                for origin, expected in ((f'chrome-extension://{extension_id}', 200), (f'chrome-extension://{attacker}', 403), (None, 403)):
                    headers = {'Origin': origin} if origin else {}
                    request = urllib.request.Request(base + '/bootstrap', data=b'', method='POST', headers=headers)
                    try:
                        with urllib.request.urlopen(request, timeout=3) as response:
                            status, body = response.status, response.read()
                    except urllib.error.HTTPError as denied:
                        status, body = denied.code, denied.read()
                        denied.close()
                    self.assertEqual(status, expected, origin)
                    self.assertEqual(b'local-helper-secret' in body, expected == 200)
            finally:
                server.shutdown(); server.server_close(); thread.join(timeout=2)



class HelperFirefoxOriginTests(unittest.TestCase):
    """XVault 23: the helper pairs with Firefox (moz-extension://<internal UUID>) and with several browsers."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        helper.CFG = pathlib.Path(self.directory.name) / 'config.json'

    def tearDown(self):
        self.directory.cleanup()

    def configure(self, **values):
        helper.CFG.write_text(json.dumps(values), encoding='utf-8')

    def test_firefox_uuid_and_lists(self):
        uuid = '0f9d3a8e-1b2c-4d5e-8f70-1234567890ab'
        self.configure(extension_id='a' * 32, extension_ids=[uuid.upper(), f'moz-extension://{uuid}/', 'not-an-id'])
        self.assertEqual(helper.extension_origins(), [f'chrome-extension://{"a" * 32}', f'moz-extension://{uuid}'])
        self.assertTrue(helper.allowed_extension_origin(f'moz-extension://{uuid}'))
        self.assertTrue(helper.allowed_extension_origin(f'chrome-extension://{"a" * 32}'))
        self.assertFalse(helper.allowed_extension_origin('moz-extension://0f9d3a8e-1b2c-4d5e-8f70-1234567890ac'))
        self.assertFalse(helper.allowed_extension_origin(f'chrome-extension://{uuid}'))
        self.assertFalse(helper.allowed_extension_origin(f'moz-extension://{"a" * 32}'))
        self.assertFalse(helper.allowed_extension_origin(''))

    def test_firefox_only_config(self):
        uuid = '{0f9d3a8e-1b2c-4d5e-8f70-1234567890ab}'
        self.configure(extension_id=uuid)
        self.assertEqual(helper.extension_origins(), ['moz-extension://0f9d3a8e-1b2c-4d5e-8f70-1234567890ab'])
        self.configure(extension_id='')
        self.assertEqual(helper.extension_origins(), [])
        self.assertFalse(helper.allowed_extension_origin('null'))

if __name__ == '__main__':
    unittest.main()
