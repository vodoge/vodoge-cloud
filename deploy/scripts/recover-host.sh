#!/bin/sh
# Run on 43.108.53.126 after a reboot. Does not compile Go or Node on the host.
set -eu
cd /opt/vodoge-cloud/deploy

# Stop leftover heavy builds from the previous attempt.
docker ps -aq --filter ancestor=vodoge-cloud-gateway --filter ancestor=vodoge-cloud-console | xargs -r docker rm -f || true
docker builder prune -f >/dev/null 2>&1 || true

if [ ! -f .env ]; then
  echo "missing deploy/.env" >&2
  exit 1
fi

docker compose --env-file .env -f compose.yaml up -d postgres redis
docker compose --env-file .env -f compose.yaml --profile migrate run --rm migrate

# Prefer a prebuilt linux-amd64 binary if present.
if [ -x ./vodoge-gateway ]; then
  docker build -f Dockerfile.gateway.prebuilt -t vodoge-cloud-gateway:prebuilt .
  docker compose --env-file .env -f compose.yaml up -d --no-build gateway || true
  # Force the prebuilt image onto the gateway service.
  docker rm -f vodoge-cloud-gateway-1 2>/dev/null || true
  docker compose --env-file .env -f compose.yaml up -d postgres redis
  docker run -d --name vodoge-cloud-gateway-1 --restart unless-stopped \
    --env-file .env \
    --network vodoge-cloud_backend \
    --network vodoge-cloud_edge \
    -p 127.0.0.1:18080:8080 \
    -p 444:8443 \
    -v /opt/vodoge-cloud/deploy/certs:/certs:ro \
    -e VODOGE_GATEWAY_ADDR=:8080 \
    -e VODOGE_GATEWAY_TLS_ADDR=:8443 \
    -e VODOGE_GATEWAY_REGION=cn \
    -e VODOGE_BASE_DOMAIN=vodoge.com \
    -e VODOGE_GATEWAY_TLS_CERT=/certs/gateway.crt \
    -e VODOGE_GATEWAY_TLS_KEY=/certs/gateway.key \
    -e VODOGE_GATEWAY_CLIENT_CA=/certs/device-ca.crt \
    -e VODOGE_DEVICE_CA_CERT=/certs/device-ca.crt \
    -e VODOGE_DEVICE_CA_KEY=/certs/device-ca.key \
    vodoge-cloud-gateway:prebuilt
fi

curl -fsS --max-time 5 http://127.0.0.1:18080/healthz
echo
ss -lnt | grep -E '18080|444' || true
