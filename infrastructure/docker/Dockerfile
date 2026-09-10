# Node image manifest verified against Docker Hub on 2026-09-09.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
RUN npm install --global npm@11.17.0 --no-audit --no-fund
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/config/package.json ./packages/config/package.json
RUN npm ci --no-audit --no-fund

FROM dependencies AS builder
COPY . .
# The canary build requires no Supabase connection or credentials.
ENV APP_BASE_URL=http://127.0.0.1:3000
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

# Standalone tracing starts at the monorepo root. Static/public are not traced.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
RUN mkdir -p /app/apps/web/.next/cache \
    && chown node:node /app/apps/web/.next/cache

USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health/live',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
