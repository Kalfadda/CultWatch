#!/bin/bash
# Double-clickable launcher for macOS teammates.
# Installs CultWatch on first run, just launches it afterward.
cd "$(dirname "$0")" || exit 1

echo ""
echo "  ================================================"
echo "     CultWatch  -  Happy's Humble Burger Cult"
echo "  ================================================"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is required but not installed."
  echo "  Opening the download page — install it, then run this again."
  open "https://nodejs.org/en/download/prebuilt-installer" 2>/dev/null
  read -r -p "  Press Return to close." _
  exit 1
fi

if [ ! -f node_modules/electron/package.json ]; then
  echo "  First-time setup: installing CultWatch (a few minutes)..."
  echo ""
  if ! npm install; then
    echo ""
    echo "  Setup failed — check your internet and run this again."
    read -r -p "  Press Return to close." _
    exit 1
  fi
  echo "  Setup complete!"
fi

echo "  Launching CultWatch..."
npm start
