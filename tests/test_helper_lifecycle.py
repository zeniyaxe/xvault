import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch


HELPER_PATH = pathlib.Path(__file__).resolve().parents[1] / 'FFmpeg_Helper' / 'xvault_ffmpeg_helper.py'
spec = importlib.util.spec_from_file_location('xvault_helper_test', HELPER_PATH)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class HelperLifecycleTests(unittest.TestCase):
    def setUp(self):
        helper.STATE['conversions'] = {}
        helper.STATE['active'] = 0
        helper.CANCEL_REQUESTS.clear()

    def test_job_id_matches_extension_for_unicode_path(self):
        self.assertEqual(helper.stable_job_id('C:\\Users\\🦊\\GIFs\\Originals\\é.mp4'), 'xvconv-5a85c565')

    def test_gif_only_conversion_finalizes_and_preserves_original(self):
        with tempfile.TemporaryDirectory() as root:
            source = pathlib.Path(root) / 'GIFs' / 'Originals' / 'sample.mp4'
            source.parent.mkdir(parents=True)
            source.write_bytes(b'original archival evidence')
            cfg = {**helper.defaults(), 'make_gif': True, 'make_webp': False, 'delete_source': True}
            with patch.object(helper, 'ffmpeg_path', return_value='fake-ffmpeg'), patch.object(helper, 'run', return_value=True), patch.object(helper, 'persist_state'):
                self.assertTrue(helper.convert(source, cfg))
            self.assertTrue(source.exists())
            self.assertEqual(helper.STATE['conversions'][str(source)]['state'], 'completed')
            self.assertEqual(helper.STATE['active'], 0)

    def test_failed_derivative_preserves_original(self):
        with tempfile.TemporaryDirectory() as root:
            source = pathlib.Path(root) / 'GIFs' / 'Originals' / 'sample.mp4'
            source.parent.mkdir(parents=True)
            source.write_bytes(b'original archival evidence')
            cfg = {**helper.defaults(), 'make_gif': True, 'make_webp': True, 'delete_source': True}
            with patch.object(helper, 'ffmpeg_path', return_value='fake-ffmpeg'), patch.object(helper, 'run', side_effect=[True, False]), patch.object(helper, 'persist_state'):
                self.assertFalse(helper.convert(source, cfg))
            self.assertTrue(source.exists())
            self.assertEqual(helper.STATE['conversions'][str(source)]['state'], 'failed')

    def test_running_job_becomes_interrupted_after_restart(self):
        with tempfile.TemporaryDirectory() as root:
            state_file = pathlib.Path(root) / '.xvault-state.json'
            state_file.write_text('{"conversions":{"job":{"state":"running"}}}', encoding='utf-8')
            with patch.object(helper, 'STATE_FILE', state_file):
                helper.load_state()
            self.assertEqual(helper.STATE['conversions']['job']['state'], 'interrupted')

    def test_conversion_output_signatures(self):
        with tempfile.TemporaryDirectory() as root:
            gif = pathlib.Path(root) / 'output.gif'
            webp = pathlib.Path(root) / 'output.webp'
            gif.write_bytes(b'GIF89a' + b'0' * 128)
            webp.write_bytes(b'RIFF' + b'0' * 4 + b'WEBP' + b'0' * 128)
            self.assertTrue(helper.verify_output(gif, 'GIF')[0])
            self.assertTrue(helper.verify_output(webp, 'WebP')[0])
            gif.write_bytes(b'<html>' + b'0' * 128)
            self.assertFalse(helper.verify_output(gif, 'GIF')[0])
            webp.write_bytes(b'')
            self.assertFalse(helper.verify_output(webp, 'WebP')[0])

    def test_remove_output_deletes_only_the_registered_derivative(self):
        with tempfile.TemporaryDirectory() as root:
            archive = pathlib.Path(root) / 'XVault'
            source = archive / 'GIFs' / 'Originals' / 'sample.mp4'
            source.parent.mkdir(parents=True)
            source.write_bytes(b'original archival evidence')
            cfg = {**helper.defaults(), 'gif_folder': 'GIFs', 'original_folder': 'Originals', 'gif_output_folder': 'GIF', 'webp_output_folder': 'WebP'}
            gif, webp = helper.output_paths(source, cfg)
            gif.parent.mkdir(parents=True)
            webp.parent.mkdir(parents=True)
            gif.write_bytes(b'GIF89a' + b'g' * 128)
            webp.write_bytes(b'RIFF' + b'0000WEBP' + b'w' * 128)
            helper.STATE['watching'] = str(archive)
            helper.STATE['conversions'] = {str(source): {
                'jobId': 'job-safe-delete', 'input': str(source), 'state': 'completed',
                'gifPath': str(gif), 'webpPath': str(webp),
                'gif': {'state': 'ready', 'path': str(gif), 'size': gif.stat().st_size},
                'webp': {'state': 'ready', 'path': str(webp), 'size': webp.stat().st_size},
            }}
            with patch.object(helper, 'persist_state'):
                result = helper.remove_conversion_output('job-safe-delete', 'gif', cfg)
            self.assertEqual(result['state'], 'removed')
            self.assertFalse(gif.exists())
            self.assertTrue(webp.exists())
            self.assertTrue(source.exists(), 'removing a derivative must never remove the archival source')
            self.assertEqual(helper.STATE['conversions'][str(source)]['gif']['state'], 'removed')

    def test_remove_output_rejects_unknown_jobs_formats_and_symlinks(self):
        with tempfile.TemporaryDirectory() as root:
            archive = pathlib.Path(root) / 'XVault'
            source = archive / 'GIFs' / 'Originals' / 'sample.mp4'
            source.parent.mkdir(parents=True)
            source.write_bytes(b'original archival evidence')
            cfg = {**helper.defaults(), 'gif_folder': 'GIFs', 'original_folder': 'Originals'}
            gif, _ = helper.output_paths(source, cfg)
            gif.parent.mkdir(parents=True)
            outside = pathlib.Path(root) / 'outside.gif'
            outside.write_bytes(b'do not delete')
            helper.STATE['watching'] = str(archive)
            helper.STATE['conversions'] = {str(source): {'jobId': 'job-link', 'input': str(source), 'state': 'completed', 'gifPath': str(outside), 'gif': {'state': 'ready', 'path': str(outside)}}}
            with patch.object(helper, 'persist_state'):
                self.assertEqual(helper.remove_conversion_output('unknown', 'gif', cfg)['state'], 'not-found')
                self.assertEqual(helper.remove_conversion_output('job-link', 'mp4', cfg)['state'], 'rejected')
                self.assertEqual(helper.remove_conversion_output('job-link', 'gif', cfg)['state'], 'rejected')
                helper.STATE['conversions'][str(source)]['gifPath'] = str(source)
                helper.STATE['conversions'][str(source)]['gif'] = {'state': 'ready', 'path': str(source)}
                self.assertEqual(helper.remove_conversion_output('job-link', 'gif', cfg)['state'], 'rejected')
            self.assertTrue(outside.exists())
            self.assertTrue(source.exists())

    def test_remove_output_refuses_to_race_an_active_conversion(self):
        with tempfile.TemporaryDirectory() as root:
            archive = pathlib.Path(root) / 'XVault'
            source = archive / 'GIFs' / 'Originals' / 'sample.mp4'
            source.parent.mkdir(parents=True)
            source.write_bytes(b'original archival evidence')
            cfg = {**helper.defaults(), 'gif_folder': 'GIFs', 'original_folder': 'Originals'}
            gif, _ = helper.output_paths(source, cfg)
            gif.parent.mkdir(parents=True)
            gif.write_bytes(b'GIF89a' + b'g' * 128)
            helper.STATE['watching'] = str(archive)
            helper.STATE['conversions'] = {str(source): {
                'jobId': 'job-busy-delete', 'input': str(source), 'state': 'running',
                'gifPath': str(gif), 'gif': {'state': 'ready', 'path': str(gif)},
            }}
            with patch.object(helper, 'persist_state'):
                result = helper.remove_conversion_output('job-busy-delete', 'gif', cfg)
            self.assertEqual(result['state'], 'busy')
            self.assertTrue(gif.exists(), 'active conversion output must remain untouched')
            self.assertTrue(source.exists(), 'the archived source must remain untouched')

    def test_pending_derivative_removals_reconcile_after_restart(self):
        with tempfile.TemporaryDirectory() as root:
            archive = pathlib.Path(root) / 'XVault'
            source = archive / 'GIFs' / 'Originals' / 'sample.mp4'
            source.parent.mkdir(parents=True)
            source.write_bytes(b'original archival evidence')
            cfg = {**helper.defaults(), 'downloads_root': str(pathlib.Path(root)), 'xvault_folder': 'XVault', 'gif_folder': 'GIFs', 'original_folder': 'Originals'}
            gif, _ = helper.output_paths(source, cfg)
            gif.parent.mkdir(parents=True)
            pending = {'key': str(source), 'jobId': 'job-reconcile', 'state': 'completed', 'input': str(source), 'gif': {'state': 'removing', 'path': str(gif), 'size': 138}}
            state_file = pathlib.Path(root) / '.xvault-state.json'
            state_file.write_text(json.dumps({'conversions': {str(source): pending}}), encoding='utf-8')
            helper.STATE['watching'] = str(archive)
            with patch.object(helper, 'STATE_FILE', state_file), patch.object(helper, 'load_cfg', return_value=cfg), patch.object(helper, 'persist_state'):
                helper.load_state()
            self.assertEqual(helper.STATE['conversions'][str(source)]['gif']['state'], 'removed', 'a persisted unlink intent plus a missing output must recover as removed')
            self.assertTrue(source.exists())

            gif.write_bytes(b'GIF89a' + b'g' * 128)
            pending['gif']['path'] = str(gif)
            state_file.write_text(json.dumps({'conversions': {str(source): pending}}), encoding='utf-8')
            with patch.object(helper, 'STATE_FILE', state_file), patch.object(helper, 'load_cfg', return_value=cfg), patch.object(helper, 'persist_state'):
                helper.load_state()
            self.assertEqual(helper.STATE['conversions'][str(source)]['gif']['state'], 'ready', 'an interrupted intent with its output still present must return to available')
            self.assertTrue(gif.exists())
            self.assertTrue(source.exists())

    def test_pending_removal_cannot_mistake_missing_source_for_removed_derivative(self):
        with tempfile.TemporaryDirectory() as root:
            archive = pathlib.Path(root) / 'XVault'
            source = archive / 'GIFs' / 'Originals' / 'sample.mp4'
            source.parent.mkdir(parents=True)
            cfg = {**helper.defaults(), 'downloads_root': str(pathlib.Path(root)), 'xvault_folder': 'XVault', 'gif_folder': 'GIFs', 'original_folder': 'Originals'}
            row = {'key': str(source), 'jobId': 'job-wrong-target', 'state': 'completed', 'input': str(source), 'gif': {'state': 'removing', 'path': str(source)}}
            state_file = pathlib.Path(root) / '.xvault-state.json'
            state_file.write_text(json.dumps({'conversions': {str(source): row}}), encoding='utf-8')
            helper.STATE['watching'] = str(archive)
            with patch.object(helper, 'STATE_FILE', state_file), patch.object(helper, 'load_cfg', return_value=cfg), patch.object(helper, 'persist_state'):
                helper.load_state()
            descriptor = helper.STATE['conversions'][str(source)]['gif']
            self.assertEqual(descriptor['state'], 'verification-unavailable')
            self.assertIn('cannot be verified', descriptor['error'].lower())
            self.assertEqual(helper.STATE['conversions'][str(source)]['derivativeEvents'][-1]['action'], 'remove-unverified')
            self.assertFalse(helper.STATE['conversions'][str(source)]['derivativeEvents'][-1]['sourcePreserved'], 'recovery must not claim the missing archival source was preserved')

    def test_failed_removal_intent_persistence_leaves_derivative_untouched(self):
        with tempfile.TemporaryDirectory() as root:
            archive = pathlib.Path(root) / 'XVault'
            source = archive / 'GIFs' / 'Originals' / 'sample.mp4'
            source.parent.mkdir(parents=True)
            source.write_bytes(b'original archival evidence')
            cfg = {**helper.defaults(), 'gif_folder': 'GIFs', 'original_folder': 'Originals'}
            gif, _ = helper.output_paths(source, cfg)
            gif.parent.mkdir(parents=True)
            gif.write_bytes(b'GIF89a' + b'g' * 128)
            helper.STATE['watching'] = str(archive)
            helper.STATE['conversions'] = {str(source): {
                'jobId': 'job-journal-failure', 'input': str(source), 'state': 'completed',
                'gifPath': str(gif), 'gif': {'state': 'ready', 'path': str(gif), 'size': gif.stat().st_size},
            }}
            with patch.object(helper, 'persist_state', return_value=False):
                result = helper.remove_conversion_output('job-journal-failure', 'gif', cfg)
            self.assertEqual(result['state'], 'journal-failed')
            self.assertTrue(gif.exists())
            self.assertTrue(source.exists())
            self.assertEqual(helper.STATE['conversions'][str(source)]['gif']['state'], 'ready')

    def test_changed_derivative_is_not_deleted_after_removal_intent(self):
        with tempfile.TemporaryDirectory() as root:
            archive = pathlib.Path(root) / 'XVault'
            source = archive / 'GIFs' / 'Originals' / 'sample.mp4'
            source.parent.mkdir(parents=True)
            source.write_bytes(b'original archival evidence')
            cfg = {**helper.defaults(), 'gif_folder': 'GIFs', 'original_folder': 'Originals'}
            gif, _ = helper.output_paths(source, cfg)
            gif.parent.mkdir(parents=True)
            gif.write_bytes(b'GIF89a' + b'before' * 22)
            helper.STATE['watching'] = str(archive)
            helper.STATE['conversions'] = {str(source): {
                'jobId': 'job-file-race', 'input': str(source), 'state': 'completed',
                'gifPath': str(gif), 'gif': {'state': 'ready', 'path': str(gif), 'size': gif.stat().st_size},
            }}

            def persist_after_external_change():
                gif.write_bytes(b'GIF89a' + b'changed-after-preview' * 17)
                return True

            with patch.object(helper, 'persist_state', side_effect=persist_after_external_change):
                result = helper.remove_conversion_output('job-file-race', 'gif', cfg)
            self.assertEqual(result['state'], 'changed')
            self.assertTrue(gif.exists(), 'the derivative changed after the user previewed removal and must be retained')
            self.assertTrue(source.exists())
            self.assertEqual(helper.STATE['conversions'][str(source)]['gif']['state'], 'verification-unavailable')

    def test_persisted_helper_state_uses_the_serialization_lock_and_atomic_replace(self):
        class TrackingLock:
            def __init__(self):
                self.lock = helper.threading.Lock()
                self.entries = 0
            def __enter__(self):
                self.entries += 1
                self.lock.acquire()
            def __exit__(self, *_):
                self.lock.release()

        with tempfile.TemporaryDirectory() as root:
            state_file = pathlib.Path(root) / '.xvault-state.json'
            tracking = TrackingLock()
            helper.STATE['conversions'] = {'one': {'state': 'completed'}}
            with patch.object(helper, 'STATE_FILE', state_file), patch.object(helper, 'STATE_LOCK', tracking):
                self.assertTrue(helper.persist_state())
            self.assertEqual(tracking.entries, 1, 'journal snapshots must serialize with helper state changes')
            self.assertEqual(json.loads(state_file.read_text(encoding='utf-8'))['conversions'], {'one': {'state': 'completed'}})
            self.assertFalse(state_file.with_suffix('.tmp').exists(), 'atomic replacement should leave no pending temp journal')


if __name__ == '__main__':
    unittest.main()
