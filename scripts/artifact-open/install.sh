#!/bin/sh
# Installs the handler that asks, in Herdr, whether to show an .html file or a link in the
# Artifact panel or in Chrome. Makes it the default for text/html and http(s) links;
# links not opened from Herdr itself still go straight to the browser.
# Undo: xdg-mime default google-chrome.desktop text/html application/xhtml+xml x-scheme-handler/http x-scheme-handler/https
set -e
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
install -m 755 "$here/herdr-artifact-open" "$HOME/.local/bin/herdr-artifact-open"
cat > "$HOME/.local/share/applications/herdr-artifact-open.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Herdr Artifact
Comment=Show an HTML file or a link in Herdr's Artifact panel or in Chrome
Exec=$HOME/.local/bin/herdr-artifact-open %u
MimeType=text/html;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
NoDisplay=true
Terminal=false
DESKTOP
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
xdg-mime default herdr-artifact-open.desktop text/html application/xhtml+xml x-scheme-handler/http x-scheme-handler/https
echo "installed: html files and Herdr links now ask (panel or Chrome)"
