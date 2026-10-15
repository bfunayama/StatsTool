#!/usr/bin/env bash
# Build StatsTool.app (macOS) — a standalone double-click app for testers.
# Run from the repo root:  ./build_macos.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 1/3  Building the frontend…"
export NVM_DIR="$HOME/.nvm"
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && . "/opt/homebrew/opt/nvm/nvm.sh"
( cd frontend && npm install && npm run build )

echo "==> 2/3  Preparing the Python build environment…"
# shellcheck disable=SC1091
source backend/.venv/bin/activate
python -m pip install --quiet --upgrade pip pyinstaller

echo "==> 3/3  Building StatsTool.app (this can take a few minutes)…"
cd backend
rm -rf build dist
pyinstaller --clean --noconfirm StatsTool.spec

echo ""
echo "✅ Done.  App: backend/dist/StatsTool.app"
echo ""
echo "Before sending it to testers (so macOS doesn't block it), run:"
echo "   xattr -dr com.apple.quarantine backend/dist/StatsTool.app"
echo "Then zip it:"
echo "   ditto -c -k --keepParent backend/dist/StatsTool.app ~/Desktop/StatsTool.zip"
