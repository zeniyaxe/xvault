"""Build the current MV3 extension as XVault.zip without local test/user data."""
from pathlib import Path
import os
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "XVault.zip"
RUNTIME_SUFFIXES = {".js", ".mjs", ".css", ".html", ".json", ".webmanifest", ".svg", ".png", ".woff", ".woff2", ".ttf", ".otf", ".py", ".bat", ".ps1", ".md"}
EXCLUDED_NAMES = {"config.json", ".xvault-token", ".xvault-state.json", ".xvault-state.tmp", "helper.log"}
EXCLUDED_DIRS = {"__pycache__", ".pytest_cache"}


def included(path: Path) -> bool:
    rel = path.relative_to(ROOT)
    if any(part in EXCLUDED_DIRS for part in rel.parts) or path.name in EXCLUDED_NAMES:
        return False
    if path.suffix.lower() not in RUNTIME_SUFFIXES and path.name not in {"OFL-Hanken-Grotesk.txt", "OFL-Newsreader.txt"}:
        return False
    if rel.parts[0] in {"tests", "tools", "output", ".playwright-mcp"}:
        return False
    return True


def main() -> None:
    paths = sorted(path for path in ROOT.rglob("*") if path.is_file() and included(path))
    if not any(path.name == "manifest.json" for path in paths):
        raise SystemExit("manifest.json is missing from the package inputs")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix="XVault-", suffix=".zip", dir=ROOT, delete=False) as tmp:
            temporary = Path(tmp.name)
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=8) as archive:
            for path in paths:
                archive.write(path, (Path("XVault") / path.relative_to(ROOT)).as_posix())
        with zipfile.ZipFile(temporary) as archive:
            bad_entry = archive.testzip()
            if bad_entry:
                raise RuntimeError(f"Package verification failed at {bad_entry}")
            if "XVault/background.js" not in archive.namelist():
                raise RuntimeError("Packaged extension has no background service worker")
        os.replace(temporary, OUTPUT)
        temporary = None
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    print(f"Packaged {len(paths)} current runtime/document files into {OUTPUT.name} ({OUTPUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
