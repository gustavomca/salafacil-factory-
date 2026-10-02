#!/bin/sh
set -eu
case "${1:-serve}" in
  init)
    if [ "${APP_ENV:-local}" = production ]; then
      python /opt/salafacil/migrate_local.py
    else
      python /opt/salafacil/migrate_local.py
      python manage.py seed_local
    fi
    ;;
  serve)
    if [ "${APP_ENV:-local}" = production ] && [ "${BACKEND_TRANSPORT:-tcp}" != unix ]; then
      printf '%s\n' 'Produção exige transporte Unix privado.' >&2
      exit 1
    fi
    exec gunicorn --config /opt/salafacil/gunicorn.conf.py config.wsgi:application
    ;;
  *) exec "$@" ;;
esac
