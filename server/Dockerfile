# The game's dedicated server: the game page itself, unchanged, run in headless Chromium in its server mode.
# Build it from the repository root:   docker build -f server/Dockerfile -t superkillers-server .
FROM node:24-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && npm ci --omit=dev --no-audit --no-fund \
 && npx playwright install --with-deps --only-shell chromium \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/* /tmp/* /root/.cache /root/.npm
COPY server/server.js server/health.js ./
COPY index.html game.html
# where guests open the game; the server prints this with '#' and the room code as its join link
ENV JOIN_URL=https://jsxyz.github.io/superkillers/
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 CMD ["node", "/app/health.js"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/server.js"]
