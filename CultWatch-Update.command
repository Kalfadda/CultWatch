#!/bin/bash
# Double-click updater for macOS teammates who cloned via git.
# Pulls the latest version, installs any new dependencies, then launches.
cd "$(dirname "$0")" || exit 1

echo ""
echo "  ================================================"
echo "     CultWatch  -  Update to the latest version"
echo "  ================================================"
echo ""

if ! command -v git >/dev/null 2>&1; then
  echo "  This updater needs Git, which isn't installed."
  echo "  Opening the download page — install it, then run this again."
  open "https://git-scm.com/download/mac" 2>/dev/null
  read -r -p "  Press Return to close." _
  exit 1
fi

if [ ! -d ".git" ]; then
  echo "  This folder wasn't set up with 'git clone', so it can't"
  echo "  auto-update. Ask Kaleb for the clone link, or replace this"
  echo "  folder with the newest copy."
  read -r -p "  Press Return to close." _
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js isn't installed. Double-click CultWatch.command first"
  echo "  to set everything up, then use this updater."
  read -r -p "  Press Return to close." _
  exit 1
fi

echo "  Checking for updates..."
echo ""
if ! git pull --ff-only; then
  echo ""
  echo "  Couldn't pull the latest version — either no internet, or"
  echo "  you edited files here. If you changed nothing, try again."
  read -r -p "  Press Return to close." _
  exit 1
fi

echo ""
echo "  Updating components (installs anything new)..."
echo ""
if ! npm install; then
  echo ""
  echo "  Downloaded the update but couldn't finish installing —"
  echo "  usually a flaky connection. Run this again to retry."
  read -r -p "  Press Return to close." _
  exit 1
fi

echo ""
echo "  Up to date! Launching CultWatch..."
npm start
