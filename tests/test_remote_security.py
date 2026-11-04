import importlib.util
import pathlib
import tempfile
import unittest


MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / 'FFmpeg_Helper' / 'remote_security.py'
spec = importlib.util.spec_from_file_location('xvault_remote_security_test', MODULE_PATH)
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


class RemoteSecurityTests(unittest.TestCase):
    def setUp(self):
        self.now = 1_800_000_000.0
        self.secrets = iter([f'secret-{i}-' + ('x' * 48) for i in range(1, 20)])
        self.manager = remote.PairingManager(clock=lambda: self.now,
                                             token_factory=lambda _: next(self.secrets))

    def test_pairing_token_is_single_use_and_approval_is_required(self):
        invite = self.manager.create_invite('http://192.168.1.25:8765')
        self.assertIn('/pair#', invite['url'])
        token = invite['token']
        request = self.manager.request_pairing(token, 'My phone', '192.168.1.8')
        self.assertNotIn('credential', request)
        self.assertEqual(self.manager.list_pending()[0]['name'], 'My phone')
        self.assertEqual(request['pairingCode'], invite['code'])
        self.assertEqual(self.manager.list_pending()[0]['pairingCode'], invite['code'])
        self.assertIsNone(self.manager.claim_pairing(request['requestId'], request['claimToken']))

        self.manager.approve_pairing(request['requestId'])
        claimed = self.manager.claim_pairing(request['requestId'], request['claimToken'])
        self.assertTrue(claimed['credential'])
        self.assertIsNone(self.manager.claim_pairing(request['requestId'], request['claimToken']))
        with self.assertRaises(remote.PairingError):
            self.manager.request_pairing(token, 'Second phone', '192.168.1.9')

    def test_pairing_expiry_regeneration_and_attempt_rate_limit(self):
        invite = self.manager.create_invite('http://192.168.1.25:8765')
        self.now += remote.PAIRING_TTL_SECONDS + 1
        with self.assertRaises(remote.PairingError):
            self.manager.request_pairing(invite['token'], 'Phone', '192.168.1.8')

        replacement = self.manager.create_invite('http://192.168.1.25:8765')
        with self.assertRaises(remote.PairingError):
            self.manager.request_pairing(invite['token'], 'Phone', '192.168.1.8')
        for _ in range(remote.PAIRING_ATTEMPT_LIMIT):
            with self.assertRaises(remote.PairingError):
                self.manager.request_pairing('wrong-token', 'Phone', '192.168.1.8')
        with self.assertRaises(remote.PairingError):
            self.manager.request_pairing(replacement['token'], 'Phone', '192.168.1.8')

    def test_permissions_are_enforced_by_device_credential_and_revocation(self):
        invite = self.manager.create_invite('http://192.168.1.25:8765')
        request = self.manager.request_pairing(invite['token'], 'Tablet', '192.168.1.9')
        device = self.manager.approve_pairing(request['requestId'])
        claim = self.manager.claim_pairing(request['requestId'], request['claimToken'])

        self.assertIsNotNone(self.manager.authorize(claim['credential'], 'library.read'))
        self.assertIsNone(self.manager.authorize(claim['credential'], 'tags.write'))
        self.manager.set_permissions(device['id'], {'library.read', 'tags.write'})
        self.assertIsNotNone(self.manager.authorize(claim['credential'], 'tags.write'))
        self.manager.revoke_device(device['id'])
        self.assertIsNone(self.manager.authorize(claim['credential'], 'library.read'))

    def test_device_permissions_survive_companion_restart_without_plaintext_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            store = pathlib.Path(directory) / 'devices.json'
            manager = remote.PairingManager(clock=lambda: self.now,
                                            token_factory=lambda _: next(self.secrets),
                                            device_store=store)
            invite = manager.create_invite('http://192.168.1.25:8765')
            request = manager.request_pairing(invite['token'], 'Phone', '192.168.1.8')
            device = manager.approve_pairing(request['requestId'])
            credential = manager.claim_pairing(request['requestId'], request['claimToken'])['credential']
            serialized = store.read_text(encoding='utf-8')
            self.assertNotIn(credential, serialized)

            restarted = remote.PairingManager(clock=lambda: self.now, device_store=store)
            self.assertIsNotNone(restarted.authorize(credential, 'library.read'))
            self.assertTrue(restarted.revoke_device(device['id']))
            self.assertIsNone(remote.PairingManager(clock=lambda: self.now, device_store=store)
                              .authorize(credential, 'library.read'))

    def test_pairing_requests_can_be_denied_and_expire(self):
        invite = self.manager.create_invite('http://192.168.1.25:8765')
        request = self.manager.request_pairing(invite['token'], 'Phone', '192.168.1.8')
        self.manager.deny_pairing(request['requestId'])
        self.assertIsNone(self.manager.claim_pairing(request['requestId'], request['claimToken']))

        invite = self.manager.create_invite('http://192.168.1.25:8765')
        request = self.manager.request_pairing(invite['token'], 'Phone', '192.168.1.8')
        self.now += remote.PAIR_REQUEST_TTL_SECONDS + 1
        with self.assertRaises(remote.PairingError):
            self.manager.approve_pairing(request['requestId'])
        self.assertIsNone(self.manager.claim_pairing(request['requestId'], request['claimToken']))

    def test_host_and_origin_checks_are_exact(self):
        allowed = {'192.168.1.25:8765', '127.0.0.1:8765'}
        self.assertTrue(remote.host_is_allowed('192.168.1.25:8765', allowed))
        self.assertFalse(remote.host_is_allowed('192.168.1.25.evil.test:8765', allowed))
        self.assertFalse(remote.host_is_allowed('192.168.1.25:8766', allowed))
        self.assertTrue(remote.origin_is_allowed('http://192.168.1.25:8765', {'http://192.168.1.25:8765'}))
        self.assertFalse(remote.origin_is_allowed('http://evil.test', {'http://192.168.1.25:8765'}))
        self.assertFalse(remote.origin_is_allowed('null', {'http://192.168.1.25:8765'}))

    def test_single_http_byte_ranges_are_bounded(self):
        self.assertEqual(remote.parse_byte_range('bytes=5-9', 20), (5, 9))
        self.assertEqual(remote.parse_byte_range('bytes=5-', 20), (5, 19))
        self.assertEqual(remote.parse_byte_range('bytes=-5', 20), (15, 19))
        for invalid in ('bytes=20-', 'bytes=8-3', 'bytes=1-2,5-6', 'items=1-2'):
            with self.assertRaises(remote.InvalidRange):
                remote.parse_byte_range(invalid, 20)


if __name__ == '__main__':
    unittest.main()
