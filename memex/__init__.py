"""Memex - Control plane for memex-server and dagit."""

from .app import MemexApp


def main():
    """Entry point for memex command."""
    app = MemexApp()
    app.run()


__all__ = ["main", "MemexApp"]
