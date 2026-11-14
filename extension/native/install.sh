#!/bin/sh
# Lets the Lichess extension (Chrome) start and stop the openings app. Run once
# (again only if you move the app folder):   sh extension/native/install.sh
#
# Sets up two things:
#  1. a launchd job, com.openings.app, that runs ./start.sh when asked
#     (log: ~/Library/Logs/openings-app.log). It does not run at login.
#  2. Chrome's helper (native messaging), which asks launchd to start that job
#     when a Lichess page opens and runs ./stop.sh when the last one closes.
#     Only the extension with this folder's manifest key (its fixed id) may use it.
# Started this way (OPENINGS_MANAGED=1), the app also stops by itself after two
# minutes without hearing from the extension, for when Chrome quits or crashes
# before it can say so (backend/idle_exit.py).
#
# Undo:  sh extension/native/install.sh --uninstall
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL=com.openings.app
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
SUPPORT="$HOME/Library/Application Support/OpeningsForLichess"
HOSTS="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
# The extension's id follows from the public key in its manifest.
EXT_ID="$(/usr/bin/python3 -c 'import base64,hashlib,json,sys; d=base64.b64decode(json.load(open(sys.argv[1]))["key"]); print("".join(chr(97+int(c,16)) for c in hashlib.sha256(d).hexdigest()[:32]))' "$ROOT/extension/manifest.json")"
# The earlier Firefox version of this helper (our own file, nothing of Firefox's).
rm -f "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/openings_app.json"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# Removing a running job takes a moment; registering it again before that
# finishes fails with "Bootstrap failed: 5: Input/output error".
i=0
while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && [ "$i" -lt 20 ]; do
  sleep 0.5; i=$((i + 1))
done
if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$AGENT" "$HOSTS/openings_app.json"
  rm -rf "$SUPPORT"
  echo "Removed."
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$SUPPORT" "$HOSTS" "$HOME/Library/Logs"

cat > "$AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$ROOT/start.sh</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>OPENINGS_MANAGED</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/openings-app.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/openings-app.log</string>
</dict>
</plist>
EOF
i=0
until launchctl bootstrap "$DOMAIN" "$AGENT" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 10 ]; then
    echo "Could not register $LABEL with launchd. Try again in a few seconds." >&2
    exit 1
  fi
  sleep 1
done

cp "$ROOT/extension/native/openings_host.py" "$SUPPORT/openings_host.py"
cat > "$SUPPORT/openings-host" <<EOF
#!/bin/sh
export OPENINGS_ROOT="$ROOT"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec /usr/bin/python3 "$SUPPORT/openings_host.py"
EOF
chmod +x "$SUPPORT/openings-host"

cat > "$HOSTS/openings_app.json" <<EOF
{
  "name": "openings_app",
  "description": "Starts the openings app for the Openings for Lichess extension",
  "path": "$SUPPORT/openings-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
rm -f "$ROOT/extension/native/openings-host"  # the old helper inside the app folder
echo "Installed: launchd job $LABEL and Chrome's helper for extension $EXT_ID."
