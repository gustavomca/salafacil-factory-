#!/bin/sh
set -eu
mkdir -p /tmp/client_body /tmp/proxy /tmp/fastcgi /tmp/uwsgi /tmp/scgi
case "${APP_ENV:-local}" in
  production)
    : "${WEB_BIND_IPV4:?Produção exige WEB_BIND_IPV4 explícito}"
    printf '%s\n' "$WEB_BIND_IPV4" | awk -F. 'NR!=1||NF!=4{exit 1} {for(i=1;i<=4;i++)if($i!~/^[0-9]+$/||$i>255||length($i)>3||$i~/^0[0-9]+$/)exit 1; if($1==0||$1>=224)exit 1} END{if(NR!=1)exit 1}' || { printf '%s\n' 'WEB_BIND_IPV4 deve ser IPv4 unicast específico, sem wildcard, multicast ou broadcast.' >&2; exit 1; }
    test -r /run/tls/server.crt && test -r /run/tls/server.key || { printf '%s\n' 'Certificado e chave TLS legíveis são obrigatórios.' >&2; exit 1; }
    cat > /tmp/salafacil-server.conf <<EOF
upstream salafacil_backend { server unix:/run/salafacil/gunicorn.sock; }
server {
  listen ${WEB_BIND_IPV4}:8443 ssl;
  ssl_certificate /run/tls/server.crt;
  ssl_certificate_key /run/tls/server.key;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_tickets off;
  include /etc/salafacil/common.conf;
  add_header Strict-Transport-Security "max-age=31536000" always;
  include /etc/salafacil/locations.conf;
}
EOF
    ;;
  local|test)
    cat > /tmp/salafacil-server.conf <<'EOF'
upstream salafacil_backend { server backend:8000; }
server {
  listen 8080;
  include /etc/salafacil/common.conf;
  include /etc/salafacil/locations.conf;
}
EOF
    ;;
  *) printf '%s\n' 'APP_ENV inválido.' >&2; exit 1 ;;
esac
exec nginx -c /etc/salafacil/nginx.conf -g 'daemon off;'
