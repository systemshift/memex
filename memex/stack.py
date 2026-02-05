"""memex-stack - One command to download, start, and launch everything."""

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


def wait_for_server(url: str, timeout: float = 10.0) -> bool:
    """Wait for memex-server to be ready."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            resp = httpx.get(f"{url}/health", timeout=0.5)
            if resp.status_code == 200:
                return True
        except httpx.RequestError:
            pass
        time.sleep(0.2)
    return False


def is_graph_empty(server_url: str) -> bool:
    """Check if the knowledge graph has any nodes."""
    try:
        resp = httpx.get(f"{server_url}/api/nodes", params={"limit": 1}, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            nodes = data if isinstance(data, list) else data.get("nodes", [])
            return len(nodes) == 0
    except Exception:
        pass
    return True


def main() -> int:
    """Entry point for memex-stack command."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Launch memex: downloads binaries, starts services, opens TUI"
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
    parser.add_argument(
        "--skip-ipfs",
        action="store_true",
        help="Skip IPFS daemon setup",
    )
    parser.add_argument(
        "--skip-download",
        action="store_true",
        help="Skip automatic binary downloads (use only local binaries)",
    )
    args = parser.parse_args()

    # Track all subprocesses for cleanup
    procs: list[subprocess.Popen] = []

    def cleanup(signum=None, frame=None):
        for proc in reversed(procs):
            if proc.poll() is None:
                log(f"Stopping process (PID {proc.pid})...")
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    # --- Step 1: Check OPENAI_API_KEY ---
    if not os.environ.get("OPENAI_API_KEY"):
        error("OPENAI_API_KEY environment variable is not set.")
        error("Get your API key from: https://platform.openai.com/api-keys")
        error("Then run: export OPENAI_API_KEY=sk-...")
        return 1

    # --- Step 2: Ensure memex-server binary ---
    if args.skip_download:
        import shutil
        server_bin = os.environ.get("MEMEX_SERVER") or shutil.which("memex-server")
        if not server_bin:
            cached = Path.home() / ".memex" / "bin" / "memex-server"
            if cached.is_file():
                server_bin = str(cached)
            else:
                error("memex-server not found (--skip-download active)")
                error("Install from: https://github.com/systemshift/memex-server/releases")
                return 1
    else:
        from .binaries import ensure_memex_server
        server_bin = ensure_memex_server()
    log(f"memex-server: {server_bin}")

    # --- Step 3: Ensure IPFS binary ---
    ipfs_bin = None
    if not args.skip_ipfs:
        if args.skip_download:
            import shutil
            ipfs_bin = shutil.which("ipfs")
            if not ipfs_bin:
                cached = Path.home() / ".memex" / "bin" / "ipfs"
                if cached.is_file():
                    ipfs_bin = str(cached)
                else:
                    warn("IPFS not found (--skip-download active), skipping IPFS")
        else:
            from .binaries import ensure_ipfs
            ipfs_bin = ensure_ipfs()
            log(f"IPFS: {ipfs_bin}")

    # --- Step 4: Ensure IPFS repo ---
    if ipfs_bin and not args.skip_ipfs:
        from .services import ensure_ipfs_repo
        ensure_ipfs_repo(ipfs_bin)

    # --- Step 5: Start IPFS daemon if needed ---
    if ipfs_bin and not args.skip_ipfs:
        from .services import is_ipfs_running, start_ipfs_daemon, wait_for_ipfs
        if is_ipfs_running():
            log("IPFS daemon already running")
        else:
            ipfs_proc = start_ipfs_daemon(ipfs_bin)
            procs.append(ipfs_proc)
            if wait_for_ipfs():
                log("IPFS daemon ready")
            else:
                warn("IPFS daemon did not start in time, continuing without it")

    # --- Step 6: Ensure dagit identity ---
    from .services import ensure_dagit_identity
    did = ensure_dagit_identity()
    if did != "unknown":
        log(f"Identity: {did}")

    # --- Step 7: Start memex-server ---
    db_path = Path(args.db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)

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
    procs.append(server_proc)

    # --- Step 8: Wait for server ---
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

    # Set server URL for tools module
    os.environ["MEMEX_URL"] = server_url

    # --- Step 9: Check if graph is empty ---
    first_run = is_graph_empty(server_url)
    if first_run:
        log("Empty graph detected — starting onboarding")

    # --- Step 10: Launch TUI ---
    log("Launching memex...")
    try:
        from .app import MemexApp
        app = MemexApp(first_run=first_run)
        app.run()
    except KeyboardInterrupt:
        pass
    finally:
        # --- Step 11: Cleanup ---
        cleanup()

    return 0


if __name__ == "__main__":
    sys.exit(main())
