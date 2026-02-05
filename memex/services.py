"""Manage IPFS daemon lifecycle and dagit identity."""

import subprocess
import time
from pathlib import Path

import httpx


def is_ipfs_running() -> bool:
    """Check if IPFS daemon is already running."""
    try:
        resp = httpx.post("http://localhost:5001/api/v0/id", timeout=2)
        return resp.status_code == 200
    except httpx.RequestError:
        return False


def ensure_ipfs_repo(ipfs_bin: str) -> None:
    """Initialize IPFS repo if it doesn't exist."""
    if (Path.home() / ".ipfs").exists():
        return

    print("\033[0;32m[memex]\033[0m Initializing IPFS repository...")
    result = subprocess.run(
        [ipfs_bin, "init"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"\033[0;31m[memex]\033[0m IPFS init failed: {result.stderr}")
        raise SystemExit(1)
    print("\033[0;32m[memex]\033[0m IPFS repository initialized")


def start_ipfs_daemon(ipfs_bin: str) -> subprocess.Popen:
    """Start IPFS daemon as a background process."""
    print("\033[0;32m[memex]\033[0m Starting IPFS daemon...")
    proc = subprocess.Popen(
        [ipfs_bin, "daemon"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return proc


def wait_for_ipfs(timeout: float = 30) -> bool:
    """Wait for IPFS daemon API to become available."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_ipfs_running():
            return True
        time.sleep(0.5)
    return False


def ensure_dagit_identity() -> str:
    """Create dagit identity if missing, return DID.

    Returns:
        The user's DID string.
    """
    identity_path = Path.home() / ".dagit" / "identity.json"

    if identity_path.exists():
        import json
        data = json.loads(identity_path.read_text())
        return data.get("did", "unknown")

    print("\033[0;32m[memex]\033[0m Creating dagit identity...")
    try:
        from dagit.identity import create
        identity = create()
        did = identity.get("did", "unknown") if isinstance(identity, dict) else str(identity)
        print(f"\033[0;32m[memex]\033[0m Identity created: {did}")
        return did
    except Exception as e:
        print(f"\033[1;33m[memex]\033[0m Could not create dagit identity: {e}")
        return "unknown"
