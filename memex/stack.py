"""memex-stack - Launch memex server and TUI together."""

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx


def log(msg: str) -> None:
    print(f"\033[0;32m[memex]\033[0m {msg}")


def warn(msg: str) -> None:
    print(f"\033[1;33m[memex]\033[0m {msg}")


def error(msg: str) -> None:
    print(f"\033[0;31m[memex]\033[0m {msg}", file=sys.stderr)


def find_server() -> str | None:
    """Find memex-server binary."""
    # Check environment variable first
    if server := os.environ.get("MEMEX_SERVER"):
        return server

    # Check common locations
    locations = [
        "memex-server",  # In PATH
        "./memex-server",  # Current directory
        str(Path.home() / ".local" / "bin" / "memex-server"),
        "/usr/local/bin/memex-server",
    ]

    for loc in locations:
        try:
            result = subprocess.run(
                [loc, "--help"],
                capture_output=True,
                timeout=5,
            )
            if result.returncode == 0 or b"memex" in result.stdout.lower():
                return loc
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue

    return None


def wait_for_server(url: str, timeout: float = 5.0) -> bool:
    """Wait for server to be ready."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            resp = httpx.get(f"{url}/health", timeout=0.5)
            if resp.status_code == 200:
                return True
        except httpx.RequestError:
            pass
        time.sleep(0.1)
    return False


def main() -> int:
    """Entry point for memex-stack command."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Launch memex server and TUI together"
    )
    parser.add_argument(
        "--server-only",
        action="store_true",
        help="Start server without TUI",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", "8080")),
        help="Server port (default: 8080)",
    )
    parser.add_argument(
        "--backend",
        choices=["sqlite", "neo4j"],
        default=os.environ.get("MEMEX_BACKEND", "sqlite"),
        help="Storage backend (default: sqlite)",
    )
    parser.add_argument(
        "--db-path",
        type=str,
        default=os.environ.get("SQLITE_PATH", str(Path.home() / ".memex" / "memex.db")),
        help="SQLite database path",
    )
    args = parser.parse_args()

    # Find server binary
    server_bin = find_server()
    if not server_bin:
        error("memex-server not found")
        error("Install from: https://github.com/systemshift/memex-server/releases")
        return 1

    # Create data directory
    db_path = Path(args.db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    # Start server
    log(f"Starting memex-server on port {args.port} ({args.backend} backend)...")

    env = os.environ.copy()
    env["PORT"] = str(args.port)
    env["MEMEX_BACKEND"] = args.backend
    env["SQLITE_PATH"] = str(db_path)

    server_proc = subprocess.Popen(
        [server_bin],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    def cleanup(signum=None, frame=None):
        if server_proc.poll() is None:
            log(f"Stopping memex-server (PID {server_proc.pid})...")
            server_proc.terminate()
            try:
                server_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server_proc.kill()

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    # Wait for server
    server_url = f"http://localhost:{args.port}"
    if not wait_for_server(server_url):
        error("Server failed to start")
        cleanup()
        return 1

    log("Server ready")

    if args.server_only:
        log("Server running. Press Ctrl+C to stop.")
        try:
            server_proc.wait()
        except KeyboardInterrupt:
            pass
        finally:
            cleanup()
        return 0

    # Set server URL for TUI
    os.environ["MEMEX_URL"] = server_url

    # Launch TUI
    log("Launching memex TUI...")
    try:
        from .app import MemexApp
        app = MemexApp()
        app.run()
    except KeyboardInterrupt:
        pass
    finally:
        cleanup()

    return 0


if __name__ == "__main__":
    sys.exit(main())
