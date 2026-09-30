# Vatworks — self-hosted resin slicer for the Elegoo Saturn 4 Ultra
# Multi-arch friendly (amd64 + arm64): no native modules, no npm install at build time.
FROM node:22-alpine
LABEL org.opencontainers.image.title="Vatworks" \
      org.opencontainers.image.description="Self-hosted resin (MSLA) slicer for the Elegoo Saturn 4 Ultra" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
# Secure by default: bind to loopback only. To reach Vatworks from other
# devices on your LAN, set HOST=0.0.0.0 AND set VATWORKS_PASSWORD to require a
# login (see docker-compose.yml). Without a password an exposed instance lets
# anyone on the network control your printer.
ENV PORT=8090 HOST=127.0.0.1 NODE_ENV=production
EXPOSE 8090
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" > /dev/null || exit 1
CMD ["node", "server.js"]
