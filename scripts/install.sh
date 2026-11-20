#!/usr/bin/env bash
# Installs, updates, or uninstalls the standalone OpenChessCoach bundle on macOS or Linux
# without requiring Node.js, npm, or Homebrew.
#
#   curl -fsSL https://github.com/inprealpha/OpenChessCoach/releases/latest/download/install.sh | bash
set -euo pipefail

REPO="inprealpha/OpenChessCoach"
VERSION="latest"
ARCHIVE=""
UNINSTALL=0
INSTALL_DIR="${OPENCHESSCOACH_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/openchesscoach-app}"
BIN_DIR="${OPENCHESSCOACH_BIN_DIR:-$HOME/.local/bin}"

while [ $# -gt 0 ]; do
  case "$1" in
    --version)     VERSION="$2"; shift 2 ;;
    --archive)     ARCHIVE="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --bin-dir)     BIN_DIR="$2"; shift 2 ;;
    --uninstall)   UNINSTALL=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: install.sh [options]
  --version <tag>       Install a specific release tag (default: latest)
  --archive <path>      Install from a local .tar.gz archive instead of downloading
  --install-dir <path>  Where to install the app bundle
  --bin-dir <path>      Where to place the openchesscoach symlink (default: ~/.local/bin)
  --uninstall           Remove OpenChessCoach (keeps your games and Player Profile)
EOF
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$UNINSTALL" -eq 1 ]; then
  rm -f "$BIN_DIR/openchesscoach"
  rm -rf "$INSTALL_DIR"
  echo "OpenChessCoach has been uninstalled."
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "Your games and Player Profile were kept in: $HOME/Library/Application Support/ai-chess-coach"
  else
    echo "Your games and Player Profile were kept in: ${XDG_DATA_HOME:-$HOME/.local/share}/ai-chess-coach"
  fi
  exit 0
fi

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    # Prefer native arm64 even when run inside a Rosetta terminal on Apple Silicon.
    if [ "$ARCH" = "x86_64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
      ARCH="arm64"
    fi
    case "$ARCH" in
      arm64)  TARGET="darwin-arm64" ;;
      x86_64) TARGET="darwin-x64" ;;
      *) echo "Unsupported macOS architecture: $ARCH" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
      echo "Standalone Linux bundles require glibc (Ubuntu, Debian, Fedora, Arch, etc.)." >&2
      echo "On musl-based Linux (such as Alpine), install Node.js 22.18+ and run: npx openchesscoach@latest" >&2
      exit 1
    fi
    case "$ARCH" in
      x86_64|amd64)  TARGET="linux-x64" ;;
      aarch64|arm64) TARGET="linux-arm64" ;;
      *) echo "Unsupported Linux architecture: $ARCH" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "Unsupported operating system: $OS" >&2
    exit 1
    ;;
esac

download() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$out" "$url"
  else
    echo "Neither curl nor wget is installed. Please install curl and try again." >&2
    exit 1
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "Neither sha256sum nor shasum is available to verify the download." >&2
    exit 1
  fi
}

ARCHIVE_NAME="openchesscoach-${TARGET}.tar.gz"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if [ -n "$ARCHIVE" ]; then
  TAR_PATH="$ARCHIVE"
else
  if [ "$VERSION" = "latest" ]; then
    BASE_URL="https://github.com/${REPO}/releases/latest/download"
  else
    TAG="$VERSION"
    case "$TAG" in v*) ;; *) TAG="v$TAG" ;; esac
    BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"
  fi
  TAR_PATH="$TMP_DIR/$ARCHIVE_NAME"
  SUMS_PATH="$TMP_DIR/SHA256SUMS.txt"

  echo "Downloading OpenChessCoach (${TARGET})..."
  download "${BASE_URL}/${ARCHIVE_NAME}" "$TAR_PATH"
  download "${BASE_URL}/SHA256SUMS.txt" "$SUMS_PATH"

  EXPECTED="$(awk -v f="$ARCHIVE_NAME" '$2 == f || $2 == "*"f {print tolower($1); exit}' "$SUMS_PATH")"
  if [ -z "$EXPECTED" ]; then
    echo "Could not find checksum for ${ARCHIVE_NAME} in SHA256SUMS.txt." >&2
    exit 1
  fi
  ACTUAL="$(sha256_file "$TAR_PATH" | tr '[:upper:]' '[:lower:]')"
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "Checksum mismatch for ${ARCHIVE_NAME} (expected ${EXPECTED}, got ${ACTUAL})." >&2
    exit 1
  fi
fi

mkdir -p "$TMP_DIR/extract"
tar -xzf "$TAR_PATH" -C "$TMP_DIR/extract"
if [ ! -x "$TMP_DIR/extract/openchesscoach/openchesscoach" ]; then
  echo "Archive did not contain openchesscoach/openchesscoach." >&2
  exit 1
fi

mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR"
BACKUP_DIR="${INSTALL_DIR}.old"
rm -rf "$BACKUP_DIR"
if [ -d "$INSTALL_DIR" ]; then
  mv "$INSTALL_DIR" "$BACKUP_DIR"
fi
if mv "$TMP_DIR/extract/openchesscoach" "$INSTALL_DIR"; then
  rm -rf "$BACKUP_DIR"
else
  [ -d "$BACKUP_DIR" ] && mv "$BACKUP_DIR" "$INSTALL_DIR"
  exit 1
fi

if [ "$OS" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$INSTALL_DIR" 2>/dev/null || true
fi

ln -sf "$INSTALL_DIR/openchesscoach" "$BIN_DIR/openchesscoach"

echo ""
echo "Installed OpenChessCoach to $INSTALL_DIR"

case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    echo "Start it anytime by running:"
    echo "  openchesscoach"
    ;;
  *)
    SHELL_RC=""
    case "${SHELL:-}" in
      */zsh)  SHELL_RC="$HOME/.zshrc" ;;
      */bash) SHELL_RC="$HOME/.bashrc" ;;
      *)      SHELL_RC="$HOME/.profile" ;;
    esac
    EXPORT_LINE="export PATH=\"\$HOME/.local/bin:\$PATH\""
    if [ "$BIN_DIR" != "$HOME/.local/bin" ]; then
      EXPORT_LINE="export PATH=\"${BIN_DIR}:\$PATH\""
    fi
    if [ -n "$SHELL_RC" ] && ! grep -Fq "$BIN_DIR" "$SHELL_RC" 2>/dev/null && ! grep -Fq '.local/bin' "$SHELL_RC" 2>/dev/null; then
      printf '\n# OpenChessCoach\n%s\n' "$EXPORT_LINE" >> "$SHELL_RC"
      echo "Added $BIN_DIR to $SHELL_RC."
    fi
    echo "Open a new terminal (or run: $EXPORT_LINE) and then run:"
    echo "  openchesscoach"
    ;;
esac

if ! command -v claude >/dev/null 2>&1 \
  && [ ! -x "$HOME/.local/bin/claude" ] \
  && [ ! -x "$HOME/.claude/local/claude" ] \
  && [ ! -x "/opt/homebrew/bin/claude" ] \
  && [ ! -x "/usr/local/bin/claude" ]; then
  echo ""
  echo "Next step — install Claude Code and sign in with your Claude Pro/Max account:"
  echo "  curl -fsSL https://claude.ai/install.sh | bash"
  echo "Then open a new terminal, run \"claude\" to sign in, and run \"openchesscoach\"."
fi
