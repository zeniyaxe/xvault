"""Safe file operations for the XVault helper (XVault 22).

Chrome cannot move or hard-link files it has finished downloading. When the local helper runs, XVault asks
it to do two things inside the XVault download root, and nothing else:

* ``rename_files`` moves archived files to the names a new filename template produces. A move never
  overwrites: on file systems with hard links the new name is created with ``os.link`` (which fails if the
  name exists) and the old name is removed afterwards; elsewhere ``os.rename`` is used after a check.
* ``link_duplicates`` replaces an extra copy of a file with a hard link to the kept copy, after checking
  that both are regular files with identical bytes (SHA-256). Every path keeps working; the space is freed.

Every path must resolve inside the root, symbolic links are refused, and each request is bounded.
"""
import hashlib
import os
import pathlib

MAX_ITEMS = 500


def _resolve(root, raw):
    """Resolve an extension path (``XVault/Images/a.jpg`` or relative to the root) inside ``root``."""
    root = pathlib.Path(root).resolve()
    text = str(raw or '').replace('\\', '/').strip()
    if not text or '\x00' in text:
        return None
    path = pathlib.Path(text)
    if path.is_absolute():
        return None
    parts = [part for part in path.parts if part not in ('', '.')]
    if not parts or any(part == '..' for part in parts):
        return None
    if parts[0].casefold() == root.name.casefold():
        parts = parts[1:]
    if not parts:
        return None
    candidate = root.joinpath(*parts)
    try:
        resolved = candidate.resolve(strict=False)
        resolved.relative_to(root)
    except (OSError, ValueError):
        return None
    # No symbolic links anywhere between the root and the file (the file itself included).
    probe = candidate
    while probe != root:
        if probe.is_symlink():
            return None
        probe = probe.parent
    return candidate


def _sha256(path, chunk=1024 * 1024):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(chunk), b''):
            digest.update(block)
    return digest.hexdigest()


def _no_overwrite_move(source, target):
    """Move ``source`` to ``target`` without ever replacing an existing ``target``."""
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, target)  # atomic: raises FileExistsError if target exists
    except FileExistsError:
        raise
    except OSError:
        # No hard links here (FAT/exFAT, some network shares, another volume): checked rename instead.
        if os.path.lexists(target):
            raise FileExistsError(str(target))
        os.rename(source, target)
        return 'renamed'
    os.unlink(source)
    return 'linked-then-unlinked'


def rename_files(root, moves, dry_run=False):
    """Apply ``[{key, from, to}]`` moves; returns one result per move (never raises for a single move)."""
    results = []
    if not isinstance(moves, list):
        return {'ok': False, 'error': 'moves must be a list'}
    if len(moves) > MAX_ITEMS:
        return {'ok': False, 'error': f'At most {MAX_ITEMS} moves per request'}
    for move in moves:
        move = move if isinstance(move, dict) else {}
        key, raw_from, raw_to = str(move.get('key') or ''), move.get('from'), move.get('to')
        source, target = _resolve(root, raw_from), _resolve(root, raw_to)
        row = {'key': key, 'from': raw_from, 'to': raw_to}
        if not source or not target:
            results.append({**row, 'state': 'refused', 'reason': 'Path is outside the XVault folder or uses a link'})
            continue
        if source == target:
            results.append({**row, 'state': 'unchanged'})
            continue
        if not source.is_file():
            # Already moved by an earlier run (or a script): report it so the record can follow.
            state = 'already-moved' if target.is_file() else 'missing'
            results.append({**row, 'state': state})
            continue
        if os.path.lexists(target):
            results.append({**row, 'state': 'skipped', 'reason': 'A file with the new name already exists'})
            continue
        if dry_run:
            results.append({**row, 'state': 'would-move'})
            continue
        try:
            how = _no_overwrite_move(source, target)
            results.append({**row, 'state': 'moved', 'how': how})
        except FileExistsError:
            results.append({**row, 'state': 'skipped', 'reason': 'A file with the new name already exists'})
        except OSError as error:
            results.append({**row, 'state': 'failed', 'reason': str(error)})
    moved = sum(1 for row in results if row['state'] in ('moved', 'already-moved'))
    return {'ok': True, 'results': results, 'moved': moved, 'dryRun': bool(dry_run)}


def link_duplicates(root, pairs, dry_run=False):
    """Replace each ``duplicate`` with a hard link to ``keep`` when their bytes are identical."""
    results = []
    if not isinstance(pairs, list):
        return {'ok': False, 'error': 'pairs must be a list'}
    if len(pairs) > MAX_ITEMS:
        return {'ok': False, 'error': f'At most {MAX_ITEMS} pairs per request'}
    saved = 0
    for pair in pairs:
        pair = pair if isinstance(pair, dict) else {}
        key = str(pair.get('key') or '')
        keep, duplicate = _resolve(root, pair.get('keep')), _resolve(root, pair.get('duplicate'))
        row = {'key': key, 'keep': pair.get('keep'), 'duplicate': pair.get('duplicate')}
        if not keep or not duplicate or keep == duplicate:
            results.append({**row, 'state': 'refused', 'reason': 'Path is outside the XVault folder or uses a link'})
            continue
        if not keep.is_file() or not duplicate.is_file():
            results.append({**row, 'state': 'missing'})
            continue
        try:
            keep_stat, dup_stat = keep.stat(), duplicate.stat()
            if (keep_stat.st_dev, keep_stat.st_ino) == (dup_stat.st_dev, dup_stat.st_ino):
                results.append({**row, 'state': 'already-linked'})
                continue
            if keep_stat.st_dev != dup_stat.st_dev:
                results.append({**row, 'state': 'skipped', 'reason': 'The copies are on different drives'})
                continue
            if keep_stat.st_size != dup_stat.st_size or _sha256(keep) != _sha256(duplicate):
                results.append({**row, 'state': 'skipped', 'reason': 'The files are not identical'})
                continue
            if dry_run:
                results.append({**row, 'state': 'would-link', 'bytes': dup_stat.st_size})
                continue
            temporary = duplicate.with_name(duplicate.name + '.xvault-link')
            if os.path.lexists(temporary):
                os.unlink(temporary)
            os.link(keep, temporary)
            os.replace(temporary, duplicate)  # atomic swap: the duplicate's path never disappears
            saved += dup_stat.st_size
            results.append({**row, 'state': 'linked', 'bytes': dup_stat.st_size})
        except OSError as error:
            results.append({**row, 'state': 'failed', 'reason': str(error)})
    return {'ok': True, 'results': results, 'bytes': saved, 'dryRun': bool(dry_run)}
