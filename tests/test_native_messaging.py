import importlib.util
import io
import pathlib
import struct
import sys
import unittest


MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / 'FFmpeg_Helper' / 'remote_native_host.py'
sys.path.insert(0, str(MODULE_PATH.parent))
spec = importlib.util.spec_from_file_location('xvault_native_host_test', MODULE_PATH)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeMessageProtocolTests(unittest.TestCase):
    def test_messages_use_little_endian_length_prefixed_utf8_json(self):
        stream = io.BytesIO()
        native.write_message({'type': 'hello', 'label': 'телефон'}, stream)
        raw = stream.getvalue()
        size = struct.unpack('<I', raw[:4])[0]
        self.assertEqual(size, len(raw) - 4)
        self.assertEqual(native.read_message(io.BytesIO(raw)), {'type': 'hello', 'label': 'телефон'})

    def test_oversized_and_malformed_frames_fail_closed(self):
        oversized = io.BytesIO(struct.pack('<I', native.MAX_NATIVE_MESSAGE + 1))
        with self.assertRaises(native.NativeProtocolError):
            native.read_message(oversized)
        malformed = io.BytesIO(struct.pack('<I', 2) + b'{}')
        self.assertEqual(native.read_message(malformed), {})
        invalid_json = io.BytesIO(struct.pack('<I', 1) + b'{')
        with self.assertRaises(native.NativeProtocolError):
            native.read_message(invalid_json)


if __name__ == '__main__':
    unittest.main()
