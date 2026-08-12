#!/usr/bin/env bash
source /etc/birdnet/birdnet.conf
my_dir=$HOME/BirdNET-Pi/scripts
set -x

# Find the active PHP-FPM Unix socket. The path is version-specific on
# modern Raspberry Pi OS (e.g. /run/php/php8.2-fpm.sock); the generic
# /run/php/php-fpm.sock only exists if a compat shim is installed, so
# hardcoding it breaks Caddy's php_fastcgi handler on stock Bookworm.
FPM_SOCK=$(ls /run/php/php*-fpm.sock 2>/dev/null | head -n1)
FPM_SOCK=${FPM_SOCK:-/run/php/php-fpm.sock}

[ -d /etc/caddy ] || mkdir /etc/caddy
if [ -f /etc/caddy/Caddyfile ];then
  cp /etc/caddy/Caddyfile{,.original}
fi
# AvianVisitors admin gate, generated rather than hand-added.
#
# This script overwrites the whole Caddyfile, so a hand-edited auth block is
# silently lost the next time anything calls it (clear_all_data.sh,
# install_services.sh, advanced.php, backup_data.sh) - which is exactly how a
# forwarded deploy ends up with an open settings drawer without anyone
# noticing.
#
# Only the endpoints that can mutate state sit behind auth. The read-only
# endpoints the public collage depends on (birdnet-api.php, cutout.php,
# recording.php, wiki.php) stay open, so this deliberately does NOT cover the
# whole /avian/api/ path.
#
# This is load-bearing: the PHP shims only check that an Authorization header
# EXISTS (AV_REQUIRE_AUTH), never that it is valid, so Caddy is the only thing
# actually validating credentials.
AVIAN_ADMIN_PWD="${AVIAN_ADMIN_PWD:-${CADDY_PWD}}"
ADMIN_BLOCK=""
if [ -n "${AVIAN_ADMIN_PWD}" ] && [ -d "${EXTRACTED}/avian" ]; then
  ADMIN_HASH=$(caddy hash-password --plaintext "${AVIAN_ADMIN_PWD}")
  ADMIN_BLOCK=$(cat << EOF
  @avian_admin path /avian/api/menu.php* /avian/api/config.php* /avian/api/birdnet-status.php*
  basic_auth @avian_admin {
    birdnet ${ADMIN_HASH}
  }
EOF
)
fi

if ! [ -z ${CADDY_PWD} ];then
HASHWORD=$(caddy hash-password --plaintext ${CADDY_PWD})
cat << EOF > /etc/caddy/Caddyfile
http:// ${BIRDNETPI_URL} {
  root * ${EXTRACTED}
  # The HTML shell must always revalidate so UI deploys and re-rendered
  # illustrations show up on the next load; versioned assets (?v=) keep
  # caching normally.
  @shell path / /index.html
  header @shell Cache-Control "no-cache"
  file_server browse
  handle /By_Date/* {
    file_server browse
  }
  handle /Charts/* {
    file_server browse
  }
  basicauth /views.php?view=File* {
    birdnet ${HASHWORD}
  }
  basicauth /Processed* {
    birdnet ${HASHWORD}
  }
  basicauth /scripts* {
    birdnet ${HASHWORD}
  }
  basicauth /stream {
    birdnet ${HASHWORD}
  }
  basicauth /phpsysinfo* {
    birdnet ${HASHWORD}
  }
  basicauth /terminal* {
    birdnet ${HASHWORD}
  }
${ADMIN_BLOCK}
  reverse_proxy /stream localhost:8000
  # AvianVisitors overlay drops an index.html alongside BirdNET-Pi's
  # index.php. The default try_files for php_fastcgi prefers index.php
  # over index.html, so override it - this is a no-op on stock installs
  # since EXTRACTED has no index.html there.
  php_fastcgi unix/${FPM_SOCK} {
    try_files {path} {path}/index.html {path}/index.php index.php
  }
  reverse_proxy /log* localhost:8080
  reverse_proxy /stats* localhost:8501
  reverse_proxy /terminal* localhost:8888
}
EOF
else
  cat << EOF > /etc/caddy/Caddyfile
http:// ${BIRDNETPI_URL} {
  root * ${EXTRACTED}
  # The HTML shell must always revalidate so UI deploys and re-rendered
  # illustrations show up on the next load; versioned assets (?v=) keep
  # caching normally.
  @shell path / /index.html
  header @shell Cache-Control "no-cache"
  file_server browse
  handle /By_Date/* {
    file_server browse
  }
  handle /Charts/* {
    file_server browse
  }
${ADMIN_BLOCK}
  reverse_proxy /stream localhost:8000
  # AvianVisitors overlay drops an index.html alongside BirdNET-Pi's
  # index.php. The default try_files for php_fastcgi prefers index.php
  # over index.html, so override it - this is a no-op on stock installs
  # since EXTRACTED has no index.html there.
  php_fastcgi unix/${FPM_SOCK} {
    try_files {path} {path}/index.html {path}/index.php index.php
  }
  reverse_proxy /log* localhost:8080
  reverse_proxy /stats* localhost:8501
  reverse_proxy /terminal* localhost:8888
}
EOF
fi

sudo caddy fmt --overwrite /etc/caddy/Caddyfile
# Fail loudly on a Caddyfile caddy can't parse rather than reloading a broken
# config and reporting success.
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || {
  echo "generated Caddyfile failed validation; not reloading caddy" >&2
  exit 1
}
# reload-or-restart so this also works at install time, when caddy may not be
# running yet (a plain reload would fail there); tolerate a not-yet-ready unit.
sudo systemctl reload-or-restart caddy 2>/dev/null || true
