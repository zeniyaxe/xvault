"""Frozen Companion smoke test, all config/media/credentials in a disposable folder."""
import json
import os
import pathlib
import queue
import shutil
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import urllib.request
from PIL import Image

with tempfile.TemporaryDirectory(prefix='xvault-native-media-') as temporary:
    root = pathlib.Path(temporary)
    host = root / 'xvault_remote_host.exe'
    shutil.copy2(sys.argv[1], host)
    shutil.copytree(pathlib.Path(__file__).resolve().parents[1] / 'FFmpeg_Helper' / 'remote-ui', root / 'remote-ui')
    archive = root / 'Downloads' / 'XVault'
    archive.mkdir(parents=True)
    image = archive / 'photo.jpg'
    Image.new('RGB', (60, 40), '#c39b59').save(image)
    (root / 'config.json').write_text(json.dumps({'downloads_root': str(archive.parent), 'xvault_folder': 'XVault'}))
    process = subprocess.Popen([str(host)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    responses = queue.Queue()
    write_lock = threading.Lock()
    def send(message):
        data = json.dumps(message).encode()
        with write_lock:
            process.stdin.write(struct.pack('<I', len(data)) + data)
            process.stdin.flush()
    def read():
        while True:
            header = process.stdout.read(4)
            if not header:
                responses.put({'error': 'Native process closed'})
                return
            size = struct.unpack('<I', header)[0]
            assert 0 < size <= 1_000_000
            message = json.loads(process.stdout.read(size))
            if message.get('type') == 'bridge_request':
                assert message['method'] == 'library.query'
                send({'type': 'bridge_response', 'id': message['id'], 'result': {'rows': [
                    {'id': '123456789', 'mediaCount': 1, 'localMedia': [{'filename': str(image), 'type': 'photo'}]}
                ], 'matched': 1}})
            else:
                responses.put(message)
    threading.Thread(target=read, daemon=True).start()
    def command(name):
        send({'type': 'command', 'id': name, 'name': name, 'payload': {'port': 18767}})
        result = responses.get(timeout=20)
        assert not result.get('error'), result.get('error')
        return result['result']
    try:
        started = command('remote.start')
        origin = started['baseUrl']
        def request(path, payload=None, cookie=None):
            headers = {'Origin': origin, 'Content-Type': 'application/json'}
            if cookie:
                headers['Cookie'] = cookie
            req = urllib.request.Request(origin + path, data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
            return urllib.request.urlopen(req, context=ssl._create_unverified_context(), timeout=10)
        invite = command('pairing.start')
        with request('/api/pair/request', {'token': invite['token'], 'name': 'Disposable smoke test'}) as response:
            pending = json.load(response)
        send({'type': 'command', 'id': 'approve', 'name': 'pairing.approve', 'payload': {'requestId': pending['requestId']}})
        assert not responses.get(timeout=10).get('error')
        with request('/api/pair/claim', {'requestId': pending['requestId'], 'claimToken': pending['claimToken']}) as response:
            cookie = response.headers['Set-Cookie'].split(';')[0]
        with request('/api/library', {'query': '', 'sessionId': 'a21fc96b-0101-4afc-89a1-71f03859cd92'}, cookie) as response:
            rows = json.load(response)['rows']
        assert rows[0]['mediaState'] == 'local' and len(rows[0]['media']) == 1
        assert str(root) not in json.dumps(rows)
        with request(rows[0]['media'][0]['url'] + '?tier=thumb', cookie=cookie) as response:
            assert response.headers['Content-Type'] == 'image/jpeg'
            assert response.read().startswith(b'\xff\xd8')
        print('PASS frozen Companion: pairing, authenticated query with absolute Chrome path, protected JPEG thumbnail')
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
