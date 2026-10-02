FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
WORKDIR /workspace/tests/e2e
COPY tests/e2e/package.json tests/e2e/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tests/e2e/ ./
RUN mkdir -p /workspace/.factory/artifacts && chown -R pwuser:pwuser /workspace/.factory
USER pwuser
CMD ["npx", "playwright", "test"]
