#!/bin/sh
# Generates the self-signed certificate serve.mjs uses. Run again to renew.
set -e
dir="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$dir"
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout "$dir/key.pem" -out "$dir/cert.pem" \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
echo "Wrote $dir/key.pem and $dir/cert.pem"
