FROM node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS frontend
WORKDIR /workspace/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM frontend AS frontend-test
CMD ["npm", "run", "test"]

FROM nginx:1.30-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94 AS runtime
RUN addgroup -g 10001 app && adduser -D -H -u 10001 -G app app \
    && mkdir -p /run/salafacil && chown app:app /run/salafacil && chmod 0770 /run/salafacil
COPY --from=frontend /workspace/frontend/dist/ /usr/share/nginx/html/
COPY docker/web/nginx.conf docker/web/common.conf docker/web/locations.conf /etc/salafacil/
COPY --chmod=755 docker/web/entrypoint.sh /opt/salafacil/entrypoint.sh
USER 10001:10001
ENTRYPOINT ["/opt/salafacil/entrypoint.sh"]
