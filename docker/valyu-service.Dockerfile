FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsup.config.ts ./
COPY patches ./patches
COPY apps/api/package.json apps/api/package.json
COPY apps/apify-service/package.json apps/apify-service/package.json
COPY apps/facilitator/package.json apps/facilitator/package.json
COPY apps/tavily-service/package.json apps/tavily-service/package.json
COPY apps/valyu-service/package.json apps/valyu-service/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci

COPY apps ./apps
COPY packages ./packages

RUN npm run build:runtime

FROM node:20-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY patches ./patches
COPY apps/api/package.json apps/api/package.json
COPY apps/apify-service/package.json apps/apify-service/package.json
COPY apps/facilitator/package.json apps/facilitator/package.json
COPY apps/tavily-service/package.json apps/tavily-service/package.json
COPY apps/valyu-service/package.json apps/valyu-service/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 4050

CMD ["npm", "run", "start:valyu-service"]
