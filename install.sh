#!/bin/sh
# Install memex binary from GitHub releases.
# Usage: curl -fsSL https://raw.githubusercontent.com/systemshift/memex/main/install.sh | sh

set -e

REPO="systemshift/memex"
INSTALL_DIR="$HOME/.memex/bin"

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Linux)  os="linux" ;;
  Darwin) os="darwin" ;;
  *)
    echo "Error: Unsupported OS: $OS"
    exit 1
    ;;
esac

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
  *)
    echo "Error: Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

BINARY="memex-${os}-${arch}"

# Get latest release tag
TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | cut -d'"' -f4)
if [ -z "$TAG" ]; then
  echo "Error: Could not determine latest release"
  exit 1
fi

URL="https://github.com/${REPO}/releases/download/${TAG}/${BINARY}"

echo "Installing memex ${TAG} (${os}-${arch})..."
mkdir -p "$INSTALL_DIR"
curl -fsSL "$URL" -o "${INSTALL_DIR}/memex"
chmod +x "${INSTALL_DIR}/memex"

echo "Installed to ${INSTALL_DIR}/memex"

# Check if in PATH
case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo ""
    echo "Add to your PATH:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    echo ""
    echo "Add this to your ~/.bashrc or ~/.zshrc to make it permanent."
    ;;
esac

echo ""
echo "Run 'memex' to start."
