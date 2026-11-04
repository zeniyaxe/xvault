import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'FFmpeg_Helper'))
import remote_security as rs  # noqa: E402


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def token_factory():
    counter = iter(range(10_000))
    return lambda n: f'tok{next(counter):04d}'.ljust(43, 'x')


class PairingFlow(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Path(self.tmp.name) / 'devices.json'
        self.pm = rs.PairingManager(clock=self.clock, token_factory=token_factory(), device_store=self.store)

    def tearDown(self):
        self.tmp.cleanup()

    def pair(self, permissions=None):
        invite = self.pm.create_invite('http://192.168.1.5:8765')
        req = self.pm.request_pairing(invite['token'], 'Phone', '192.168.1.9')
        self.pm.approve_pairing(req['requestId'], permissions)
        return self.pm.claim_pairing(req['requestId'], req['claimToken'])

    def test_full_pairing_and_one_time_claim(self):
        claimed = self.pair()
        self.assertEqual(set(claimed['permissions']), set(rs.DEFAULT_PERMISSIONS))
        self.assertIsNotNone(self.pm.authorize(claimed['credential'], 'library.read'))
        self.assertIsNone(self.pm.authorize(claimed['credential'], 'downloads.manage'))
        self.assertNotIn(claimed['credential'], self.store.read_text())

    def test_devices_survive_restart_and_revocation_works(self):
        claimed = self.pair()
        again = rs.PairingManager(clock=self.clock, device_store=self.store)
        self.assertIsNotNone(again.authorize(claimed['credential']))
        self.assertTrue(again.revoke_device(claimed['deviceId']))
        self.assertIsNone(again.authorize(claimed['credential']))

    def test_invite_is_single_use_and_expires(self):
        invite = self.pm.create_invite('http://192.168.1.5:8765')
        self.pm.request_pairing(invite['token'], 'A', '10.0.0.2')
        with self.assertRaises(rs.PairingError):
            self.pm.request_pairing(invite['token'], 'B', '10.0.0.3')
        invite = self.pm.create_invite('http://192.168.1.5:8765')
        self.clock.now += rs.PAIRING_TTL_SECONDS + 1
        with self.assertRaises(rs.PairingError):
            self.pm.request_pairing(invite['token'], 'C', '10.0.0.4')

    def test_rate_limit_per_address(self):
        self.pm.create_invite('http://192.168.1.5:8765')
        for _ in range(rs.PAIRING_ATTEMPT_LIMIT):
            with self.assertRaises(rs.PairingError):
                self.pm.request_pairing('wrong', 'X', '10.0.0.7')
        with self.assertRaisesRegex(rs.PairingError, 'Too many'):
            self.pm.request_pairing('wrong', 'X', '10.0.0.7')

    def test_corrupt_registry_fails_closed(self):
        self.store.write_text('{not json')
        pm = rs.PairingManager(clock=self.clock, device_store=self.store)
        invite = pm.create_invite('http://192.168.1.5:8765')
        req = pm.request_pairing(invite['token'], 'Phone', '192.168.1.9')
        with self.assertRaises(rs.PairingError):
            pm.approve_pairing(req['requestId'])
        self.assertEqual(self.store.read_text(), '{not json')

    def test_invalid_base_urls(self):
        for bad in ('ftp://a', 'http://u:p@a', 'http://a/path', 'http://a?x=1', 'http://a:99999'):
            with self.assertRaises(ValueError):
                self.pm.create_invite(bad)


class HttpValidation(unittest.TestCase):
    def test_host_and_origin(self):
        self.assertTrue(rs.host_is_allowed('192.168.1.5:8765', ['192.168.1.5:8765']))
        self.assertFalse(rs.host_is_allowed('evil.com', ['192.168.1.5:8765']))
        self.assertFalse(rs.host_is_allowed('a@192.168.1.5:8765', ['192.168.1.5:8765']))
        self.assertTrue(rs.origin_is_allowed('http://192.168.1.5:8765', ['http://192.168.1.5:8765/']))
        self.assertFalse(rs.origin_is_allowed('null', ['null']))
        self.assertFalse(rs.origin_is_allowed('http://192.168.1.5:8765/x', ['http://192.168.1.5:8765']))

    def test_byte_ranges(self):
        self.assertEqual(rs.parse_byte_range('bytes=0-99', 1000), (0, 99))
        self.assertEqual(rs.parse_byte_range('bytes=900-', 1000), (900, 999))
        self.assertEqual(rs.parse_byte_range('bytes=-100', 1000), (900, 999))
        self.assertEqual(rs.parse_byte_range('bytes=0-5000', 1000), (0, 999))
        for bad in ('bytes=0-1,5-6', 'bytes=1000-', 'bytes=+5-9', 'bytes=٣-9', 'bytes=-', 'items=0-1', 'bytes=5-2', 'bytes=-0'):
            with self.assertRaises(rs.InvalidRange, msg=bad):
                rs.parse_byte_range(bad, 1000)


if __name__ == '__main__':
    unittest.main()
