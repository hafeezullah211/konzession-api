#!/usr/bin/env sh
# Grant anonymous read (download) on the konzession bucket so browsers can load
# <img src="http://HOST:PORT/konzession/Licenses/..."> without signing in to MinIO.
#
# Usage (MinIO from docker-compose in this repo — host ports 9010 API, 9011 console):
#   ./scripts/minio-public-download.sh
#
# Override defaults:
#   MINIO_ALIAS_URL=http://127.0.0.1:9010 MINIO_USER=minioadmin MINIO_PASSWORD=... \
#     MINIO_BUCKET=konzession ./scripts/minio-public-download.sh
#
# Requires: MinIO Client (mc) — https://min.io/docs/minio/linux/reference/minio-mc.html

set -e
ALIAS_URL="${MINIO_ALIAS_URL:-http://127.0.0.1:9010}"
USER="${MINIO_USER:-minioadmin}"
PASSWORD="${MINIO_PASSWORD:-minioadmin12345}"
BUCKET="${MINIO_BUCKET:-konzession}"
ALIAS_NAME="${MINIO_MC_ALIAS:-localdev}"

mc alias set "$ALIAS_NAME" "$ALIAS_URL" "$USER" "$PASSWORD"
mc mb -p "$ALIAS_NAME/$BUCKET" 2>/dev/null || true
mc anonymous set download "$ALIAS_NAME/$BUCKET"
echo "Anonymous download enabled on $ALIAS_NAME/$BUCKET (public GET for objects)."
