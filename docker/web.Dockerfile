FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsup.config.ts ./
COPY SKILL.md ./
COPY apps/api/package.json apps/api/package.json
COPY apps/facilitator/package.json apps/facilitator/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci

COPY apps ./apps
COPY packages ./packages

RUN npm run build:web

FROM node:20-bookworm-slim AS runner
LABEL org.opencontainers.image.source=https://github.com/fastxyz/marketplace

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
