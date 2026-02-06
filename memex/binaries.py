"""Auto-download and cache external binaries in ~/.memex/bin/."""

import os
import platform
import shutil
import stat
import tarfile
import zipfile
from pathlib import Path

import httpx

BIN_DIR = Path.home() / ".memex" / "bin"

MEMEX_SERVER_VERSION = "v0.1.0"
KUBO_VERSION = "v0.32.1"

MEMEX_SERVER_REPO = "systemshift/memex-server"
KUBO_REPO = "ipfs/kubo"


def _detect_platform() -> tuple[str, str]:
    """Detect OS and architecture.

    Returns:
        (os_name, arch) normalized for download URLs.
    """
    system = platform.system()
    machine = platform.machine().lower()

    if system == "Linux":
        os_name = "linux"
    elif system == "Darwin":
        os_name = "darwin"
    else:
        raise RuntimeError(f"Unsupported OS: {system}. Only Linux and macOS are supported.")

    if machine in ("x86_64", "amd64"):
        arch = "amd64"
    elif machine in ("aarch64", "arm64"):
        arch = "arm64"
    else:
        raise RuntimeError(f"Unsupported architecture: {machine}. Only x86_64 and arm64 are supported.")

    return os_name, arch


def _download_file(url: str, dest: Path, label: str) -> None:
    """Download a file with progress output.

    Args:
        url: URL to download from.
        dest: Destination path.
        label: Human-readable label for progress output.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  Downloading {label}...")
    print(f"  {url}")

    with httpx.stream("GET", url, follow_redirects=True, timeout=120) as resp:
        if resp.status_code == 404:
            raise RuntimeError(
                f"Download not found (404): {url}\n"
                f"  The release may not be published yet."
            )
        resp.raise_for_status()

        total = int(resp.headers.get("content-length", 0))
        downloaded = 0

        with open(dest, "wb") as f:
            for chunk in resp.iter_bytes(chunk_size=65536):
                f.write(chunk)
                downloaded += len(chunk)
                if total:
                    pct = downloaded * 100 // total
                    mb = downloaded / (1024 * 1024)
                    total_mb = total / (1024 * 1024)
                    print(f"\r  {mb:.1f}/{total_mb:.1f} MB ({pct}%)", end="", flush=True)

    if total:
        print()  # newline after progress
    print(f"  Downloaded {label}")


def _extract_binary(archive: Path, binary_name: str, dest: Path) -> None:
    """Extract a single binary from an archive.

    Args:
        archive: Path to tar.gz or zip archive.
        binary_name: Path of the binary within the archive (e.g. "kubo/ipfs").
        dest: Destination path for the extracted binary.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)

    if archive.name.endswith(".tar.gz") or archive.name.endswith(".tgz"):
        with tarfile.open(archive, "r:gz") as tf:
            # Look for the binary in the archive
            for member in tf.getmembers():
                if member.name == binary_name or member.name.endswith(f"/{binary_name}"):
                    # Extract to temp location then move
                    member.name = dest.name
                    tf.extract(member, dest.parent)
                    break
            else:
                # Try just the basename
                basename = Path(binary_name).name
                for member in tf.getmembers():
                    if Path(member.name).name == basename:
                        member.name = dest.name
                        tf.extract(member, dest.parent)
                        break
                else:
                    names = [m.name for m in tf.getmembers()]
                    raise RuntimeError(
                        f"Binary '{binary_name}' not found in archive. Contents: {names}"
                    )

    elif archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as zf:
            for name in zf.namelist():
                if name == binary_name or name.endswith(f"/{binary_name}"):
                    data = zf.read(name)
                    dest.write_bytes(data)
                    break
            else:
                basename = Path(binary_name).name
                for name in zf.namelist():
                    if Path(name).name == basename:
                        data = zf.read(name)
                        dest.write_bytes(data)
                        break
                else:
                    raise RuntimeError(
                        f"Binary '{binary_name}' not found in archive. Contents: {zf.namelist()}"
                    )
    else:
        raise RuntimeError(f"Unknown archive format: {archive.name}")

    # Make executable
    dest.chmod(dest.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    # Clean up archive
    archive.unlink()


def ensure_memex_server() -> str:
    """Ensure memex-server binary is available.

    Checks in order:
    1. MEMEX_SERVER environment variable
    2. System PATH
    3. ~/.memex/bin/ cache
    4. Downloads from GitHub releases

    Returns:
        Path to the memex-server binary.
    """
    # Check env var
    if server := os.environ.get("MEMEX_SERVER"):
        if Path(server).is_file():
            return server

    # Check PATH
    if path_bin := shutil.which("memex-server"):
        return path_bin

    # Check cache
    cached = BIN_DIR / "memex-server"
    if cached.is_file():
        return str(cached)

    # Download
    print("\033[0;32m[memex]\033[0m memex-server not found, downloading...")
    try:
        os_name, arch = _detect_platform()

        # memex-server uses Linux/Darwin and x86_64/arm64
        os_label = "Linux" if os_name == "linux" else "Darwin"
        arch_label = "x86_64" if arch == "amd64" else "arm64"

        filename = f"memex-server_{os_label}_{arch_label}.tar.gz"
        url = f"https://github.com/{MEMEX_SERVER_REPO}/releases/download/{MEMEX_SERVER_VERSION}/{filename}"

        archive = BIN_DIR / filename
        _download_file(url, archive, "memex-server")
        _extract_binary(archive, "memex-server", cached)

        print(f"\033[0;32m[memex]\033[0m memex-server installed to {cached}")
        return str(cached)

    except Exception as e:
        print(f"\033[0;31m[memex]\033[0m Failed to download memex-server: {e}")
        print(f"\033[0;31m[memex]\033[0m Install manually from: https://github.com/{MEMEX_SERVER_REPO}/releases")
        raise SystemExit(1)


def ensure_ipfs() -> str:
    """Ensure IPFS (kubo) binary is available.

    Checks in order:
    1. System PATH
    2. ~/.memex/bin/ cache
    3. Downloads from GitHub releases

    Returns:
        Path to the ipfs binary.
    """
    # Check PATH
    if path_bin := shutil.which("ipfs"):
        return path_bin

    # Check cache
    cached = BIN_DIR / "ipfs"
    if cached.is_file():
        return str(cached)

    # Download
    print("\033[0;32m[memex]\033[0m IPFS not found, downloading kubo...")
    try:
        os_name, arch = _detect_platform()

        filename = f"kubo_{KUBO_VERSION}_{os_name}-{arch}.tar.gz"
        url = f"https://github.com/{KUBO_REPO}/releases/download/{KUBO_VERSION}/{filename}"

        archive = BIN_DIR / filename
        _download_file(url, archive, "IPFS (kubo)")
        _extract_binary(archive, "kubo/ipfs", cached)

        print(f"\033[0;32m[memex]\033[0m IPFS installed to {cached}")
        return str(cached)

    except Exception as e:
        print(f"\033[0;31m[memex]\033[0m Failed to download IPFS: {e}")
        print(f"\033[0;31m[memex]\033[0m Install manually from: https://docs.ipfs.tech/install/")
        raise SystemExit(1)
