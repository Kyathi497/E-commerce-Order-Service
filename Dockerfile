FROM node:24-alpine AS build
RUN npm install -g pnpm@11.25.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 4006
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=5 CMD wget -qO- http://127.0.0.1:4006/health/live || exit 1
# Migrations run before start here; in production they move to a one-off job (§11).
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/main.js"]
