import importlib.util
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('xvault_packager_test', ROOT / 'tools' / 'package-extension.py')
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class RemotePackageTests(unittest.TestCase):
    def test_every_offline_shell_dependency_is_packaged(self):
        ui = ROOT / 'FFmpeg_Helper' / 'remote-ui'
        source = (ui / 'remote-sw.js').read_text(encoding='utf-8')
        shell = re.search(r'const SHELL = \[(.*?)\];', source, re.S).group(1)
        files = re.findall(r"'([^']+)'", shell)
        self.assertIn('/manifest.webmanifest', files)
        self.assertIn('/remote-drafts.js', files)
        for asset in files:
            path = ui / ('index.html' if asset == '/' else asset.lstrip('/'))
            self.assertTrue(path.is_file(), asset)
            self.assertTrue(packager.included(path), f'Remote offline shell dependency omitted from ZIP: {asset}')


if __name__ == '__main__':
    unittest.main()
