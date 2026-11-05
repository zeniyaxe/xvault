"""Safe file operations for the XVault helper (XVault 22, recovery and usage in 23).

Chrome cannot move or hard-link files it has finished downloading. When the local helper runs, XVault asks
it to do two things inside the XVault download root, and nothing else:

* ``rename_files`` moves archived files to the names a new filename template produces. A move never
  overwrites: on file systems with hard links the new name is created with ``os.link`` (which fails if the
  name exists) and the old name is removed afterwards; elsewhere ``os.rename`` is used after a check.
* ``link_duplicates`` replaces an extra copy of a file with a hard link to the kept copy, after checking
  that both are regular files with identical bytes (SHA-256). Every path keeps working; the space is freed.

Every path must resolve inside the root, symbolic links are refused, and each request is bounded.

XVault 23 adds recovery and honest usage numbers:

* A move interrupted between ``os.link`` and ``os.unlink`` leaves both names on the same file. The next run
  sees that the target *is* the source (same device and inode) and finishes the move instead of refusing it.
* ``recover`` removes ``*.xvault-link`` temporaries an interrupted duplicate link left behind (they are extra
  names of a kept file, never the only copy).
* ``disk_usage`` walks the root and counts each physical file once, so hard-linked copies stop being counted
  twice in storage statistics.
"""
import time
import hashlib
import os
import pathlib

MAX_ITEMS = 500
LINK_SUFFIX = '.xvault-link'


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


def _same_file(a, b):
    try:
        first, second = os.stat(a), os.stat(b)
    except OSError:
        return False
    return (first.st_dev, first.st_ino) == (second.st_dev, second.st_ino)


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
        if source.is_file() and target.is_file() and _same_file(source, target):
            # An earlier run linked the new name and stopped before removing the old one: finish it.
            if dry_run:
                results.append({**row, 'state': 'would-move', 'resumed': True})
                continue
            try:
                os.unlink(source)
                results.append({**row, 'state': 'moved', 'how': 'resumed'})
            except OSError as error:
                results.append({**row, 'state': 'failed', 'reason': str(error)})
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
            temporary = duplicate.with_name(duplicate.name + LINK_SUFFIX)
            if os.path.lexists(temporary):
                os.unlink(temporary)
            os.link(keep, temporary)
            os.replace(temporary, duplicate)  # atomic swap: the duplicate's path never disappears
            saved += dup_stat.st_size
            results.append({**row, 'state': 'linked', 'bytes': dup_stat.st_size})
        except OSError as error:
            results.append({**row, 'state': 'failed', 'reason': str(error)})
    return {'ok': True, 'results': results, 'bytes': saved, 'dryRun': bool(dry_run)}


def recover(root, limit=200000):
    """Remove ``*.xvault-link`` temporaries left by an interrupted duplicate link.

    A temporary is only removed while another name of the same file still exists (the duplicate's original
    path or the kept copy), so recovery can never delete the last copy of anything.
    """
    root = pathlib.Path(root)
    removed, kept, seen = 0, 0, 0
    if not root.is_dir():
        return {'ok': False, 'removed': 0}
    for folder, dirs, files in os.walk(root, followlinks=False):
        for name in files:
            seen += 1
            if seen > limit:
                return {'ok': True, 'removed': removed, 'kept': kept, 'truncated': True}
            if not name.endswith(LINK_SUFFIX):
                continue
            path = pathlib.Path(folder) / name
            try:
                stat = path.lstat()
            except OSError:
                continue
            if path.is_symlink() or stat.st_nlink < 2:
                kept += 1  # the only name of its data: leave it for a person to look at
                continue
            try:
                os.unlink(path)
                removed += 1
            except OSError:
                kept += 1
    return {'ok': True, 'removed': removed, 'kept': kept}


def disk_usage(root, limit=400000, budget_seconds=20.0):
    """Apparent vs physical size of everything under ``root``; each hard-linked file is counted once."""
    root = pathlib.Path(root)
    started = time.monotonic()
    inodes = {}
    files = apparent = 0
    folders = {}
    truncated = False
    for folder, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if not name.startswith('.xvault')]
        top = pathlib.Path(folder).relative_to(root).parts[:1]
        bucket = top[0] if top else '(root)'
        for name in names:
            if files >= limit or time.monotonic() - started > budget_seconds:
                truncated = True
                break
            path = pathlib.Path(folder) / name
            try:
                stat = path.lstat()
            except OSError:
                continue
            if not os.path.isfile(path) or os.path.islink(path):
                continue
            files += 1
            apparent += stat.st_size
            key = (stat.st_dev, stat.st_ino)
            entry = folders.setdefault(bucket, {'files': 0, 'bytes': 0, 'physicalBytes': 0})
            entry['files'] += 1
            entry['bytes'] += stat.st_size
            if key in inodes:
                inodes[key]['names'] += 1
            else:
                inodes[key] = {'size': stat.st_size, 'names': 1}
                entry['physicalBytes'] += stat.st_size
        if truncated:
            break
    physical = sum(item['size'] for item in inodes.values())
    linked = [item for item in inodes.values() if item['names'] > 1]
    return {
        'ok': True,
        'root': str(root),
        'files': files,
        'uniqueFiles': len(inodes),
        'bytes': apparent,
        'physicalBytes': physical,
        'savedBytes': apparent - physical,
        'linkedFiles': len(linked),
        'linkedNames': sum(item['names'] for item in linked),
        'folders': [{'name': name, **value} for name, value in sorted(folders.items(), key=lambda kv: -kv[1]['bytes'])][:20],
        'truncated': truncated,
        'elapsedMs': round((time.monotonic() - started) * 1000),
    }
