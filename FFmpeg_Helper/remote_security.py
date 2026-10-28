"""Pairing, device authorization, and HTTP input validation for XVault Remote."""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import threading
import tempfile
import time
import urllib.parse
import uuid
from pathlib import Path
from collections import defaultdict, deque


PAIRING_TTL_SECONDS = 300
PAIR_REQUEST_TTL_SECONDS = 120
PAIRING_ATTEMPT_LIMIT = 5
PAIRING_ATTEMPT_WINDOW_SECONDS = 60
REMOTE_PERMISSIONS = frozenset({
    'library.read',
    'media.read',
    'favorite.write',
    'tags.write',
    'notes.write',
    'downloads.manage',
})
DEFAULT_PERMISSIONS = frozenset({'library.read', 'media.read'})


class PairingError(ValueError):
    """A pairing request was expired, invalid, blocked, or already consumed."""


class InvalidRange(ValueError):
    """A media byte range is malformed or unsatisfiable."""


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _secret(factory=secrets.token_urlsafe) -> str:
    return factory(32)


def _valid_base_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(str(value or ''))
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname or
            parsed.username is not None or parsed.password is not None or
            parsed.query or parsed.fragment or parsed.path not in ('', '/')):
        raise ValueError('A plain HTTP(S) LAN address is required')
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError('The LAN address has an invalid port') from error
    if port is not None and not 1 <= port <= 65535:
        raise ValueError('The LAN address has an invalid port')
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, '', '', ''))


class PairingManager:
    """One-use invitations and revocable per-device bearer credentials.

    Only hashes of device credentials are retained. The one plaintext
    credential exists briefly between desktop approval and the phone's one-time
    claim request; it is erased immediately after it is delivered.
    """

    def __init__(self, clock=time.time, token_factory=secrets.token_urlsafe, device_store=None):
        self._clock = clock
        self._token_factory = token_factory
        self._device_store = Path(device_store) if device_store else None
        self._lock = threading.RLock()
        self._invite = None
        self._pending = {}
        self._devices = {}
        self._attempts = defaultdict(deque)
        self._storage_valid = True
        self._load_devices()

    def _load_devices(self) -> None:
        if not self._device_store or not self._device_store.exists():
            return
        try:
            payload = json.loads(self._device_store.read_text(encoding='utf-8'))
            rows = payload.get('devices') if isinstance(payload, dict) else None
            if not isinstance(rows, list) or len(rows) > 500:
                raise ValueError('Invalid device registry')
            for row in rows:
                if (not isinstance(row, dict) or not row.get('id') or
                        not re.fullmatch(r'[0-9a-f]{64}', str(row.get('credentialHash', '')))):
                    raise ValueError('Invalid device registry entry')
                permissions = set(row.get('permissions') or [])
                if not permissions.issubset(REMOTE_PERMISSIONS):
                    raise ValueError('Unknown permission in device registry')
                safe = {
                    'id': str(row['id'])[:64],
                    'name': ' '.join(str(row.get('name') or 'Device').split())[:48],
                    'address': str(row.get('address') or 'unknown')[:64],
                    'pairedAt': float(row.get('pairedAt') or 0),
                    'lastSeenAt': float(row.get('lastSeenAt') or 0),
                    'permissions': sorted(permissions),
                    'credentialHash': str(row['credentialHash']),
                }
                self._devices[safe['id']] = safe
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            # Do not silently replace a damaged credential store with an empty
            # one. Existing devices fail closed until the owner repairs it.
            self._storage_valid = False

    def _persist_devices(self) -> None:
        if not self._device_store:
            return
        if not self._storage_valid:
            raise PairingError('The paired-device registry is unreadable; existing access remains blocked')
        self._device_store.parent.mkdir(parents=True, exist_ok=True)
        rows = list(self._devices.values())
        payload = json.dumps({'version': 1, 'devices': rows}, ensure_ascii=False, separators=(',', ':'))
        temporary = None
        try:
            with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=self._device_store.parent,
                                             prefix='.xvault-remote-', suffix='.tmp', delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self._device_store)
        finally:
            if temporary and temporary.exists():
                temporary.unlink(missing_ok=True)

    def _new_secret(self) -> str:
        value = self._token_factory(32)
        if not isinstance(value, str) or len(value) < 32:
            raise RuntimeError('Secure random source returned an invalid secret')
        return value

    def create_invite(self, base_url: str) -> dict:
        base = _valid_base_url(base_url)
        token = self._new_secret()
        pin = f'{secrets.randbelow(1_000_000):06d}'
        now = self._clock()
        with self._lock:
            self._invite = {
                'hash': _digest(token),
                'pin': pin,
                'created': now,
                'expires': now + PAIRING_TTL_SECONDS,
                'base': base,
                'request_id': None,
            }
            # Regeneration also invalidates requests made against the old QR.
            self._pending.clear()
        return {
            'url': f'{base}/pair#{urllib.parse.quote(token, safe="")}',
            'token': token,
            'code': pin,
            'expiresAt': self._invite['expires'],
        }

    def revoke_invite(self) -> None:
        with self._lock:
            self._invite = None
            self._pending.clear()

    def _consume_attempt(self, remote_address: str, now: float) -> None:
        address = str(remote_address or 'unknown')[:64]
        attempts = self._attempts[address]
        while attempts and now - attempts[0] >= PAIRING_ATTEMPT_WINDOW_SECONDS:
            attempts.popleft()
        if len(attempts) >= PAIRING_ATTEMPT_LIMIT:
            raise PairingError('Too many pairing attempts; wait before trying again')
        attempts.append(now)

    def request_pairing(self, token: str, name: str, remote_address: str) -> dict:
        now = self._clock()
        with self._lock:
            self._consume_attempt(remote_address, now)
            invite = self._invite
            supplied = _digest(str(token or ''))
            if (not invite or now >= invite['expires'] or
                    not hmac.compare_digest(supplied, invite['hash'])):
                raise PairingError('This pairing code is invalid or has expired')
            if invite['request_id']:
                raise PairingError('This QR already has a pending device request')

            request_id = str(uuid.uuid4())
            claim_token = self._new_secret()
            safe_name = re.sub(r'[\x00-\x1f\x7f<>]', '', str(name or ''))
            safe_name = ' '.join(safe_name.split())[:48] or 'Unnamed device'
            try:
                address = str(ipaddress.ip_address(remote_address))
            except ValueError:
                address = 'unknown'
            self._pending[request_id] = {
                'id': request_id,
                'name': safe_name,
                'address': address,
                'created': now,
                'expires': min(now + PAIR_REQUEST_TTL_SECONDS, invite['expires']),
                'pairing_code': invite['pin'],
                'claim_hash': _digest(claim_token),
                'status': 'pending',
                'credential': None,
                'device_id': None,
            }
            invite['request_id'] = request_id
            return {
                'requestId': request_id,
                'claimToken': claim_token,
                'expiresAt': self._pending[request_id]['expires'],
                'pairingCode': invite['pin'],
            }

    def list_pending(self) -> list[dict]:
        now = self._clock()
        with self._lock:
            self._expire_pending(now)
            return [{**{key: row[key] for key in ('id', 'name', 'address', 'created', 'expires', 'status')},
                     'pairingCode': row['pairing_code']}
                    for row in self._pending.values()]

    def approve_pairing(self, request_id: str, permissions=None) -> dict:
        now = self._clock()
        with self._lock:
            self._expire_pending(now)
            row = self._pending.get(str(request_id))
            if not row or row['status'] != 'pending' or now >= row['expires']:
                raise PairingError('This device request has expired')
            invite = self._invite
            if not invite or now >= invite['expires'] or invite['request_id'] != row['id']:
                raise PairingError('The pairing QR has expired; generate a new one')
            if not self._storage_valid:
                raise PairingError('The paired-device registry is unreadable; pairing is disabled')

            credential = self._new_secret()
            device_id = str(uuid.uuid4())
            granted = set(DEFAULT_PERMISSIONS if permissions is None else permissions)
            if not granted.issubset(REMOTE_PERMISSIONS):
                raise ValueError('Unsupported Remote permission')
            device = {
                'id': device_id,
                'name': row['name'],
                'address': row['address'],
                'pairedAt': now,
                'lastSeenAt': now,
                'permissions': sorted(granted),
                'credentialHash': _digest(credential),
            }
            self._devices[device_id] = device
            try:
                self._persist_devices()
            except Exception:
                self._devices.pop(device_id, None)
                raise
            row.update(status='approved', credential=credential, device_id=device_id)
            return self._public_device(device)

    def deny_pairing(self, request_id: str) -> None:
        with self._lock:
            row = self._pending.pop(str(request_id), None)
            if row:
                self._invalidate_invite_for(row['id'])

    def claim_pairing(self, request_id: str, claim_token: str) -> dict | None:
        now = self._clock()
        with self._lock:
            self._expire_pending(now)
            row = self._pending.get(str(request_id))
            supplied = _digest(str(claim_token or ''))
            if (not row or row['status'] != 'approved' or now >= row['expires'] or
                    not hmac.compare_digest(supplied, row['claim_hash'])):
                return None
            device = self._devices.get(row['device_id'])
            if not device or not row['credential']:
                return None
            result = {
                'deviceId': device['id'],
                'name': device['name'],
                'credential': row['credential'],
                'permissions': list(device['permissions']),
            }
            row['credential'] = None
            self._pending.pop(row['id'], None)
            self._invalidate_invite_for(row['id'])
            return result

    def _invalidate_invite_for(self, request_id: str) -> None:
        if self._invite and self._invite.get('request_id') == request_id:
            self._invite = None

    def _expire_pending(self, now: float) -> None:
        for request_id, row in list(self._pending.items()):
            if now >= row['expires']:
                self._pending.pop(request_id, None)
                self._invalidate_invite_for(request_id)
        if self._invite and now >= self._invite['expires']:
            self._invite = None

    def list_devices(self) -> list[dict]:
        with self._lock:
            return [self._public_device(row) for row in self._devices.values()]

    @staticmethod
    def _public_device(device: dict) -> dict:
        return {key: device[key] for key in ('id', 'name', 'address', 'pairedAt', 'lastSeenAt', 'permissions')}

    def set_permissions(self, device_id: str, permissions) -> dict | None:
        granted = set(permissions)
        if not granted.issubset(REMOTE_PERMISSIONS):
            raise ValueError('Unsupported Remote permission')
        with self._lock:
            row = self._devices.get(str(device_id))
            if not row:
                return None
            row['permissions'] = sorted(granted)
            self._persist_devices()
            return self._public_device(row)

    def revoke_device(self, device_id: str) -> bool:
        with self._lock:
            row = self._devices.pop(str(device_id), None)
            if row:
                self._persist_devices()
            return row is not None

    def authorize(self, credential: str, permission: str | None = None) -> dict | None:
        supplied = _digest(str(credential or ''))
        now = self._clock()
        with self._lock:
            for row in self._devices.values():
                if not hmac.compare_digest(supplied, row['credentialHash']):
                    continue
                if permission and permission not in row['permissions']:
                    return None
                row['lastSeenAt'] = now
                return self._public_device(row)
        return None


def host_is_allowed(host_header: str, allowed_hosts) -> bool:
    """Accept an exact Host authority only; this blocks DNS-rebinding hosts."""
    supplied = str(host_header or '').strip().lower()
    if not supplied or any(char in supplied for char in ('/', '\\', '@', ',', '\r', '\n')):
        return False
    return supplied in {str(host).strip().lower() for host in allowed_hosts}


def origin_is_allowed(origin: str, allowed_origins) -> bool:
    value = str(origin or '').strip()
    if not value or value == 'null':
        return False
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme not in ('http', 'https') or not parsed.netloc or
            parsed.username is not None or parsed.password is not None or
            parsed.path or parsed.query or parsed.fragment):
        return False
    normalized = f'{parsed.scheme.lower()}://{parsed.netloc.lower()}'
    return normalized in {str(item).strip().rstrip('/').lower() for item in allowed_origins}


def parse_byte_range(value: str, size: int) -> tuple[int, int]:
    """Parse one RFC-style bytes range, returning an inclusive (start, end)."""
    if size < 0 or not value or not value.startswith('bytes='):
        raise InvalidRange('Invalid byte range')
    spec = value[6:].strip()
    if ',' in spec or '-' not in spec:
        raise InvalidRange('Only one byte range is supported')
    left, right = spec.split('-', 1)
    try:
        if left:
            start = int(left)
            end = int(right) if right else size - 1
            if start < 0 or end < start or start >= size:
                raise InvalidRange('Byte range is unsatisfiable')
            return start, min(end, size - 1)
        suffix = int(right)
        if suffix <= 0 or size == 0:
            raise InvalidRange('Byte range is unsatisfiable')
        return max(0, size - suffix), size - 1
    except ValueError as error:
        if isinstance(error, InvalidRange):
            raise
        raise InvalidRange('Invalid byte range') from error
