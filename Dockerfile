# syntax=docker/dockerfile:1

# ---- build -------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@10
WORKDIR /app

# Install dependencies with only the manifests first (better layer caching).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/engine/package.json packages/engine/
COPY packages/mcp-server/package.json packages/mcp-server/
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild

COPY . .
RUN pnpm --filter @cutline/web build \
 && pnpm --filter @cutline/mcp-server build \
 && pnpm --filter @cutline/mcp-server deploy --legacy --prod /out

# ---- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim
# ffmpeg powers perception tools and server-side export; DejaVu fonts are used for text.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /out ./
COPY --from=build /app/apps/web/dist ./web
RUN mkdir -p /data /media && chown -R node:node /data /app

ENV NODE_ENV=production \
    CUTLINE_HOST=0.0.0.0 \
    CUTLINE_PORT=4100 \
    CUTLINE_DATA_DIR=/data \
    CUTLINE_MEDIA_ROOTS=/media:/data \
    CUTLINE_WEB_DIST=/app/web \
    CUTLINE_PUBLIC_URL=http://localhost:4100 \
    CUTLINE_MODEL_DIR=/data/models

USER node
VOLUME ["/data"]
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/cli.js"]
