# Build: docker build --platform linux/amd64 -t mech-bot .
# The match runs it with no network, a read-only root (writable /tmp), 1 CPU, 512 MB, uid 65534, and the map at /arena.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
WORKDIR /bot
COPY src/ ./src/
# Bundle at build time: no runtime transpiling on the read-only disk, faster cold start.
RUN bun build src/main.ts --target=bun --outfile=/bot/bot.js
ENTRYPOINT ["bun", "/bot/bot.js"]
