"""XVault 22 helper file operations: no-overwrite renames and duplicate hard links (real files, real HTTP)."""
import http.client
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

HELPER_DIR = pathlib.Path(__file__).resolve().parents[2] / 'FFmpeg_Helper'
sys.path.insert(0, str(HELPER_DIR))
import file_ops  # noqa: E402


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


class RenameFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name) / 'XVault'
        self.root.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_moves_into_new_folders_and_accepts_chrome_style_paths(self):
        write(self.root / 'Images' / 'a.jpg', b'one')
        result = file_ops.rename_files(self.root, [{'key': 'k1', 'from': 'XVault/Images/a.jpg', 'to': 'XVault/nasa/2024/a-1.jpg'}])
        self.assertTrue(result['ok'])
        self.assertEqual(result['results'][0]['state'], 'moved')
        self.assertFalse((self.root / 'Images' / 'a.jpg').exists())
        self.assertEqual((self.root / 'nasa' / '2024' / 'a-1.jpg').read_bytes(), b'one')

    def test_never_overwrites_and_reports_already_moved(self):
        write(self.root / 'a.jpg', b'one')
        write(self.root / 'b.jpg', b'two')
        result = file_ops.rename_files(self.root, [{'from': 'a.jpg', 'to': 'b.jpg'}])
        self.assertEqual(result['results'][0]['state'], 'skipped')
        self.assertEqual((self.root / 'b.jpg').read_bytes(), b'two')
        self.assertEqual((self.root / 'a.jpg').read_bytes(), b'one')
        again = file_ops.rename_files(self.root, [{'from': 'gone.jpg', 'to': 'b.jpg'}])
        self.assertEqual(again['results'][0]['state'], 'already-moved')
        missing = file_ops.rename_files(self.root, [{'from': 'gone.jpg', 'to': 'nope.jpg'}])
        self.assertEqual(missing['results'][0]['state'], 'missing')

    def test_refuses_escapes_absolute_paths_and_symlinks(self):
        outside = write(pathlib.Path(self.tmp.name) / 'secret.txt', b'secret')
        write(self.root / 'a.jpg', b'one')
        os.symlink(outside, self.root / 'link.txt')
        (self.root / 'linked-dir').symlink_to(pathlib.Path(self.tmp.name), target_is_directory=True)
        cases = [
            {'from': '../secret.txt', 'to': 'stolen.txt'},
            {'from': 'a.jpg', 'to': '../escaped.jpg'},
            {'from': str(outside), 'to': 'abs.txt'},
            {'from': 'link.txt', 'to': 'copied.txt'},
            {'from': 'a.jpg', 'to': 'linked-dir/escaped.jpg'},
            {'from': 'a.jpg', 'to': 'XVault'},
            {'from': 'a.jpg', 'to': 'bad\x00name.jpg'},
        ]
        result = file_ops.rename_files(self.root, cases)
        self.assertEqual([row['state'] for row in result['results']], ['refused'] * len(cases))
        self.assertTrue(outside.exists())
        self.assertFalse((pathlib.Path(self.tmp.name) / 'escaped.jpg').exists())
        self.assertTrue((self.root / 'a.jpg').exists())

    def test_dry_run_and_limits(self):
        write(self.root / 'a.jpg', b'one')
        result = file_ops.rename_files(self.root, [{'from': 'a.jpg', 'to': 'b.jpg'}], dry_run=True)
        self.assertEqual(result['results'][0]['state'], 'would-move')
        self.assertTrue((self.root / 'a.jpg').exists())
        self.assertFalse(file_ops.rename_files(self.root, [{}] * (file_ops.MAX_ITEMS + 1))['ok'])
        self.assertFalse(file_ops.rename_files(self.root, 'nope')['ok'])


class LinkDuplicates(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name) / 'XVault'
        self.root.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_identical_copies_become_one_inode_and_both_paths_still_read(self):
        keep = write(self.root / 'Images' / 'keep.jpg', b'x' * 5000)
        dup = write(self.root / 'Likes' / 'dup.jpg', b'x' * 5000)
        result = file_ops.link_duplicates(self.root, [{'key': 'd1', 'keep': 'XVault/Images/keep.jpg', 'duplicate': 'Likes/dup.jpg'}])
        self.assertEqual(result['results'][0]['state'], 'linked')
        self.assertEqual(result['bytes'], 5000)
        self.assertEqual(os.stat(keep).st_ino, os.stat(dup).st_ino)
        self.assertEqual(dup.read_bytes(), b'x' * 5000)
        self.assertFalse(any(p.name.endswith('.xvault-link') for p in self.root.rglob('*')))
        again = file_ops.link_duplicates(self.root, [{'keep': 'Images/keep.jpg', 'duplicate': 'Likes/dup.jpg'}])
        self.assertEqual(again['results'][0]['state'], 'already-linked')

    def test_different_bytes_are_never_linked(self):
        write(self.root / 'a.jpg', b'aaaa')
        write(self.root / 'b.jpg', b'aaab')
        write(self.root / 'c.jpg', b'aaaaa')
        result = file_ops.link_duplicates(self.root, [{'keep': 'a.jpg', 'duplicate': 'b.jpg'}, {'keep': 'a.jpg', 'duplicate': 'c.jpg'}])
        self.assertEqual([row['state'] for row in result['results']], ['skipped', 'skipped'])
        self.assertEqual((self.root / 'b.jpg').read_bytes(), b'aaab')
        self.assertNotEqual(os.stat(self.root / 'a.jpg').st_ino, os.stat(self.root / 'b.jpg').st_ino)

    def test_refuses_outside_paths_same_path_and_missing(self):
        outside = write(pathlib.Path(self.tmp.name) / 'outside.jpg', b'same')
        write(self.root / 'a.jpg', b'same')
        result = file_ops.link_duplicates(self.root, [
            {'keep': '../outside.jpg', 'duplicate': 'a.jpg'},
            {'keep': 'a.jpg', 'duplicate': 'a.jpg'},
            {'keep': 'a.jpg', 'duplicate': 'missing.jpg'},
        ])
        self.assertEqual([row['state'] for row in result['results']], ['refused', 'refused', 'missing'])
        self.assertEqual(outside.read_bytes(), b'same')


class HelperHttp(unittest.TestCase):
    """The real helper request handler: auth required, routes to file_ops inside the watched root."""

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('xvault_helper_files_test', HELPER_DIR / 'xvault_ffmpeg_helper.py')
        cls.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.helper)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name) / 'XVault'
        self.root.mkdir()
        self.helper.STATE['watching'] = str(self.root)
        self.helper.auth_token = lambda: 'test-token'
        self.helper.log = lambda message: None
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), self.helper.API)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f'http://127.0.0.1:{self.server.server_address[1]}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def post(self, path, body, token='test-token'):
        data = json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method='POST', headers={'Content-Type': 'application/json', **({'Authorization': f'Bearer {token}'} if token else {})})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b'{}')

    def test_rename_and_link_over_http(self):
        write(self.root / 'Images' / 'a.jpg', b'same bytes')
        write(self.root / 'Images' / 'b.jpg', b'same bytes')
        status, body = self.post('/files/rename', {'moves': [{'key': 'k', 'from': 'XVault/Images/a.jpg', 'to': 'XVault/nasa/a.jpg'}]})
        self.assertEqual(status, 200)
        self.assertEqual(body['results'][0]['state'], 'moved')
        status, body = self.post('/files/link-duplicates', {'pairs': [{'key': 'd', 'keep': 'XVault/nasa/a.jpg', 'duplicate': 'XVault/Images/b.jpg'}]})
        self.assertEqual(status, 200)
        self.assertEqual(body['results'][0]['state'], 'linked')

    def test_requires_auth_and_bounds_size(self):
        status, _ = self.post('/files/rename', {'moves': []}, token=None)
        self.assertEqual(status, 401)
        status, _ = self.post('/files/rename', {'moves': []}, token='wrong')
        self.assertEqual(status, 401)
        status, _ = self.post('/files/rename', {'moves': 'x'})
        self.assertEqual(status, 400)
        # Announce an oversized body without sending it: the helper must refuse on
        # Content-Length alone, before reading anything (no broken-pipe race).
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_address[1], timeout=5)
        connection.putrequest('POST', '/files/rename')
        connection.putheader('Authorization', 'Bearer test-token')
        connection.putheader('Content-Length', str(2 * 1048576))
        connection.endheaders()
        response = connection.getresponse()
        self.assertEqual(response.status, 413)
        connection.close()

    def test_status_advertises_capabilities(self):
        request = urllib.request.Request(self.base + '/status', headers={'Authorization': 'Bearer test-token'})
        with urllib.request.urlopen(request, timeout=5) as response:
            body = json.loads(response.read())
        self.assertIn('rename', body['capabilities'])
        self.assertIn('link-duplicates', body['capabilities'])


if __name__ == '__main__':
    unittest.main()
