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
            finally:
                server.shutdown(); server.server_close(); thread.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
