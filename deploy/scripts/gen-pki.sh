#!/bin/sh
set -eu

# Device CA + gateway server cert + one lab edge device certificate.
# CN=device UUID, O=tenant UUID, OU=region.

DIR=${1:-./certs}
TENANT_ID=${TENANT_ID:-a0000000-0000-4000-8000-00000000000a}
DEVICE_ID=${DEVICE_ID:-b0000000-0000-4000-8000-00000000000b}
REGION=${REGION:-cn}

mkdir -p "$DIR"
cd "$DIR"

if [ ! -f device-ca.key ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
    -keyout device-ca.key -out device-ca.crt \
    -subj "/CN=VoDoge Device CA"
fi

if [ ! -f gateway.key ]; then
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout gateway.key -out gateway.csr \
    -subj "/CN=a.vodoge.com"
  cat > gateway.ext <<EOF
subjectAltName=DNS:a.vodoge.com,DNS:vodoge.com,IP:43.108.53.126
extendedKeyUsage=serverAuth
keyUsage=digitalSignature
EOF
  openssl x509 -req -in gateway.csr -CA device-ca.crt -CAkey device-ca.key -CAcreateserial \
    -days 825 -out gateway.crt -extfile gateway.ext
  rm -f gateway.csr gateway.ext
fi

if [ ! -f device.key ]; then
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout device.key -out device.csr \
    -subj "/CN=${DEVICE_ID}/O=${TENANT_ID}/OU=${REGION}"
  cat > device.ext <<EOF
extendedKeyUsage=clientAuth
keyUsage=digitalSignature
EOF
  openssl x509 -req -in device.csr -CA device-ca.crt -CAkey device-ca.key -CAcreateserial \
    -days 825 -out device.crt -extfile device.ext
  rm -f device.csr device.ext
fi

chmod 600 device-ca.key gateway.key device.key
echo "wrote $(pwd)"
echo "device_id=${DEVICE_ID}"
echo "tenant_id=${TENANT_ID}"
echo "region=${REGION}"
