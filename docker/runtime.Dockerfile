# syntax=docker/dockerfile:1.7
#
# qwe/agent-runtime — obraz bazowy: zbudowane monorepo (core, voice, pluginy wbudowane, agent server)
# + Chromium dla Playwrighta. Budowany raz (`qwe build --runtime`), potem każdy agent robi FROM z niego.
#
# Build z KORZENIA repo:
#   docker build -f docker/runtime.Dockerfile -t qwe/agent-runtime:0.1.0 .

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo
# manifesty osobno → zmiana źródeł nie unieważnia warstwy install
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/voice/package.json packages/voice/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
COPY plugins/web/package.json plugins/web/
COPY plugins/computer/package.json plugins/computer/
COPY plugins/skills/package.json plugins/skills/
COPY apps/agent/package.json apps/agent/
COPY apps/chat/package.json apps/chat/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY packages ./packages
COPY plugins ./plugins
COPY apps ./apps
RUN pnpm -r run build

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    QWE_IN_DOCKER=1 \
    QWE_HOST=0.0.0.0 \
    QWE_AGENT_PORT=7777 \
    QWE_AGENT_DIR=/agent/workspace \
    QWE_DATA_DIR=/agent/data \
    QWE_COMPUTER_HEADLESS=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /agent
COPY --from=build /repo /agent/runtime
# Chromium + biblioteki systemowe — tylko to, czego Playwright potrzebuje (apt przez --with-deps)
RUN cd /agent/runtime/plugins/computer && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /agent/workspace /agent/data \
 && chown -R node:node /agent /ms-playwright
VOLUME ["/agent/data"]
EXPOSE 7777
USER node
HEALTHCHECK --interval=15s --timeout=3s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.QWE_AGENT_PORT||7777)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings=ExperimentalWarning", "runtime/apps/agent/dist/index.js"]
