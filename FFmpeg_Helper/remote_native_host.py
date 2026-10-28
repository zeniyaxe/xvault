"""Chrome Native Messaging entry point for XVault's local Companion."""

from __future__ import annotations

import json
import os
import pathlib
import queue
import struct
import sys
import threading
import time
import uuid
import contextlib

from remote_security import PairingManager


MAX_NATIVE_MESSAGE = 1_000_000
HEARTBEAT_SECONDS = 20
BRIDGE_TIMEOUT_SECONDS = 25


class NativeProtocolError(ValueError):
    pass


def _read_exact(stream, size):
    chunks = []
    remaining = size
    while remaining:
        block = stream.read(remaining)
        if not block:
            if not chunks:
                return None
            raise NativeProtocolError('Native message ended unexpectedly')
        chunks.append(block)
        remaining -= len(block)
    return b''.join(chunks)


def read_message(stream):
    header = _read_exact(stream, 4)
    if header is None:
        return None
    size = struct.unpack('<I', header)[0]
    if size < 2 or size > MAX_NATIVE_MESSAGE:
        raise NativeProtocolError('Native message length is invalid')
    raw = _read_exact(stream, size)
    if raw is None:
        raise NativeProtocolError('Native message ended unexpectedly')
    try:
        value = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise NativeProtocolError('Native message JSON is invalid') from error
    if not isinstance(value, dict):
        raise NativeProtocolError('Native message must be a JSON object')
    return value


def write_message(value, stream):
    try:
        payload = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    except (TypeError, ValueError) as error:
        raise NativeProtocolError('Native response cannot be encoded') from error
    if not payload or len(payload) > MAX_NATIVE_MESSAGE:
        raise NativeProtocolError('Native response exceeds the message limit')
    stream.write(struct.pack('<I', len(payload)))
    stream.write(payload)
    stream.flush()


def application_dir():
    if getattr(sys, 'frozen', False):
        return pathlib.Path(sys.executable).resolve().parent
    return pathlib.Path(__file__).resolve().parent


class NativeHostRuntime:
    def __init__(self, input_stream=None, output_stream=None):
        self.input_stream = input_stream or sys.stdin.buffer
        self.output_stream = output_stream or sys.stdout.buffer
        self._write_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending = {}
        self._incoming = queue.Queue(maxsize=64)
        self._closed = threading.Event()
        self._remote = None
        self._helper = None
        self._app_dir = application_dir()
        self._device_store = self._app_dir / '.xvault-remote-devices.json'
        self._manager = PairingManager(device_store=self._device_store)
        self._log_path = self._app_dir / 'xvault_remote.log'

    def _log(self, message):
        # Event-only logs. Never include native payloads, paths, pairing values,
        # device credentials, or query text.
        try:
            with self._log_path.open('a', encoding='utf-8') as stream:
                stream.write(f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] {message}\n')
        except OSError:
            pass

    def send(self, value):
        with self._write_lock:
            write_message(value, self.output_stream)

    def _read_loop(self):
        try:
            while not self._closed.is_set():
                message = read_message(self.input_stream)
                if message is None:
                    break
                self._incoming.put(message, timeout=2)
        except (NativeProtocolError, OSError, queue.Full):
            self._log('Native Messaging input closed or invalid')
        finally:
            self._closed.set()
            try:
                self._incoming.put_nowait(None)
            except queue.Full:
                pass

    def _ensure_remote(self, port):
        if not self._helper:
            with contextlib.redirect_stdout(sys.stderr):
                import xvault_ffmpeg_helper as helper
            directory = application_dir()
            helper.BASE = directory
            helper.CFG = directory / 'config.json'
            helper.LOG = directory / 'helper.log'
            helper.STATE_FILE = directory / '.xvault-state.json'
            helper.TOKEN_FILE = directory / '.xvault-token'
            with contextlib.redirect_stdout(sys.stderr):
                config = helper.load_cfg()
            root = (pathlib.Path(config['downloads_root']) / config.get('xvault_folder', 'XVault')).resolve()
            helper.STATE['watching'] = str(root)
            helper.STATE['ffmpeg'] = helper.ffmpeg_path()
            self._helper = helper
            self._media_root = root
        if self._remote and self._remote.listening:
            return self._remote.status()
        from remote_companion import RemoteCompanion
        self._remote = RemoteCompanion(
            rpc=self.request_extension,
            media_root=self._media_root,
            path_resolver=self._helper.resolve_source,
            ui_root=application_dir() / 'remote-ui',
            device_store=self._device_store,
            port=port,
            ffmpeg=self._helper.ffmpeg_path(),
            manager=self._manager,
        )
        return self._remote.start()

    def request_extension(self, method, payload):
        request_id = str(uuid.uuid4())
        result = queue.Queue(maxsize=1)
        with self._pending_lock:
            self._pending[request_id] = result
        try:
            self.send({'type': 'bridge_request', 'id': request_id, 'method': str(method)[:64],
                       'payload': payload if isinstance(payload, dict) else {}})
            response = result.get(timeout=BRIDGE_TIMEOUT_SECONDS)
            if not isinstance(response, dict) or response.get('error'):
                error = str(response.get('error') if isinstance(response, dict) else 'No response')[:180]
                raise RuntimeError(error or 'Extension bridge request failed')
            return response.get('result') if isinstance(response.get('result'), dict) else {}
        finally:
            with self._pending_lock:
                self._pending.pop(request_id, None)

    def _command(self, name, payload):
        if name == 'remote.start':
            port = int(payload.get('port') or 18765)
            if not 1024 <= port <= 65535:
                raise ValueError('Remote port must be between 1024 and 65535')
            return self._ensure_remote(port)
        if name == 'remote.status':
            return self._remote.status() if self._remote else {
                'ok': True, 'listening': False, 'pairedDevices': 0
            }
        if name == 'remote.stop':
            result = self._remote.stop() if self._remote else {'ok': True, 'listening': False}
            return result
        if name == 'pairing.pending':
            return {'rows': self._manager.list_pending()}
        if name == 'devices.list':
            return {'rows': self._manager.list_devices()}
        if name == 'device.permissions':
            device = self._manager.set_permissions(payload.get('deviceId'), payload.get('permissions') or [])
            if not device:
                raise ValueError('Paired device not found')
            return {'ok': True, 'device': device}
        if name == 'device.revoke':
            device_id = str(payload.get('deviceId') or '')
            if not self._manager.revoke_device(device_id):
                return {'ok': False, 'error': 'Paired device not found'}
            if self._remote:
                self._remote.media.revoke_device(device_id)
            return {'ok': True}
        if name.startswith(('pairing.', 'device.')):
            port = int(payload.get('port') or 18765)
            if not 1024 <= port <= 65535:
                raise ValueError('Remote port must be between 1024 and 65535')
            self._ensure_remote(port)
            return self._remote.control(name, payload)
        raise ValueError('Unsupported Companion command')

    def run(self):
        reader = threading.Thread(target=self._read_loop, name='XVaultNativeReader', daemon=True)
        reader.start()
        self._log('Native Messaging Companion connected')
        try:
            while not self._closed.is_set():
                try:
                    message = self._incoming.get(timeout=HEARTBEAT_SECONDS)
                except queue.Empty:
                    self.send({'type': 'ping', 'at': int(time.time())})
                    continue
                if message is None:
                    break
                message_type = message.get('type')
                if message_type == 'pong':
                    continue
                if message_type == 'bridge_response':
                    request_id = str(message.get('id') or '')
                    with self._pending_lock:
                        pending = self._pending.get(request_id)
                    if pending:
                        try:
                            pending.put_nowait({'result': message.get('result'), 'error': message.get('error')})
                        except queue.Full:
                            pass
                    continue
                if message_type != 'command':
                    continue
                request_id = str(message.get('id') or '')[:64]
                name = str(message.get('name') or '')[:64]
                payload = message.get('payload') if isinstance(message.get('payload'), dict) else {}
                try:
                    result = self._command(name, payload)
                    self.send({'type': 'response', 'id': request_id, 'result': result})
                    if name == 'remote.stop' and self._remote:
                        self._remote = None
                    if name == 'remote.start':
                        self._log('Remote listener started')
                except Exception as error:
                    # The UI receives actionable but bounded text; no request
                    # object or credentials are written to disk.
                    self.send({'type': 'response', 'id': request_id,
                               'error': str(error)[:180] or 'Companion command failed'})
                    self._log('Companion command failed')
        finally:
            self._closed.set()
            if self._remote:
                self._remote.stop()
                self._remote = None
            self._log('Native Messaging Companion disconnected')


def main():
    if os.name == 'nt':
        try:
            import msvcrt
            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
            msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
        except (ImportError, OSError):
            pass
    NativeHostRuntime().run()


if __name__ == '__main__':
    main()
