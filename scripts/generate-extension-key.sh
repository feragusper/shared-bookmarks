#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# generate-extension-key.sh
#
# Pin the Chrome Extension ID by generating an RSA key pair and printing
# the values you need to:
#   1) Paste into manifest.example.json / manifest.json as the "key" field.
#   2) Register as the Chrome Extension's "Application ID" (Item ID) in the
#      Google Cloud Console OAuth client.
#
# The resulting Extension ID is derived from the public key, so it stays
# stable no matter where the extension is loaded from. This is what lets a
# CI-built zip (or your partner's install) produce the same ID as your
# local unpacked install.
#
# Usage:
#   ./scripts/generate-extension-key.sh                # writes shared-bookmarks.pem
#   ./scripts/generate-extension-key.sh path/to/key.pem
#
# The .pem is the PRIVATE key — keep it out of git (already covered by
# .gitignore: *.pem). Back it up somewhere safe; if you lose it you'll have
# to recreate the OAuth client with a new Extension ID.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PEM="${1:-shared-bookmarks.pem}"

if [[ ! -f "$PEM" ]]; then
  echo "→ Generating new private key at $PEM"
  openssl genrsa 2048 2>/dev/null \
    | openssl pkcs8 -topk8 -nocrypt -out "$PEM"
  chmod 600 "$PEM"
else
  echo "→ Reusing existing private key at $PEM"
fi

# Public key in DER, base64-encoded — this is the value of manifest.json "key"
KEY_B64=$(openssl rsa -in "$PEM" -pubout -outform DER 2>/dev/null | base64 | tr -d '\n')

# Extension ID = first 32 hex chars of SHA-256(public key DER), mapped a-p
EXT_ID=$(openssl rsa -in "$PEM" -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 -binary \
  | xxd -p -c 256 \
  | cut -c1-32 \
  | tr '0-9a-f' 'a-p')

cat <<EOF

────────────────────────────────────────────────────────────────────────
  Manifest "key" value (paste into manifest.example.json AND manifest.json)
────────────────────────────────────────────────────────────────────────
$KEY_B64

────────────────────────────────────────────────────────────────────────
  Resulting Chrome Extension ID
────────────────────────────────────────────────────────────────────────
$EXT_ID

  → Add this Extension ID to your OAuth client in Google Cloud Console:
    APIs & Services → Credentials → (your Chrome Extension OAuth client)
    → Application ID. Save.

  Then reload the extension in chrome://extensions and the ID shown on
  the card should match the one above.

  PEM file: $PEM   (keep it secret, keep it safe — *.pem is git-ignored)
────────────────────────────────────────────────────────────────────────
EOF

