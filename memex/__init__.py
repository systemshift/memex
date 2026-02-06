"""Memex - AI-native knowledge graph with decentralized social networking."""

__version__ = "0.1.1"

from .app import MemexApp


def main():
    """Entry point for memex command."""
    app = MemexApp()
    app.run()


__all__ = ["main", "MemexApp"]
