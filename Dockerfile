# Vatworks — self-hosted resin slicer for the Elegoo Saturn 4 Ultra
# Multi-arch friendly (amd64 + arm64): no native modules, no npm install at build time.
FROM node:22-alpine
LABEL org.opencontainers.image.title="Vatworks" \
      org.opencontainers.image.description="Self-hosted resin (MSLA) slicer for the Elegoo Saturn 4 Ultra" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV PORT=8090 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 8090
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" > /dev/null || exit 1
CMD ["node", "server.js"]
