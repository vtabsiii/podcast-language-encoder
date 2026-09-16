# syntax=docker/dockerfile:1.7
# apps/api on Node 22. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t polycast/api:<tag> .
# Built and published by `cdk deploy` as a Docker image asset (docs/aws-setup.md "Polycast stacks").

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

FROM base AS build
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY apps/api ./apps/api
# `...` selects the API and every workspace package it depends on (domain, contracts).
RUN pnpm install --frozen-lockfile --filter @polycast/api...
RUN pnpm --filter @polycast/api... run build
# Prunes to production dependencies with workspace packages copied in, ready to run standalone.
RUN pnpm --filter @polycast/api deploy --prod --legacy /out

FROM node:22-slim AS runtime
ENV NODE_ENV=production PORT=4000 HOST=0.0.0.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  # Amazon RDS certificate bundle (all regions) for sslmode=verify-full against Aurora.
  && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
       -o /etc/ssl/certs/aws-rds-global-bundle.pem
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4000/healthz || exit 1
# The migration task overrides this with: node dist/db/migrate-cli.js
CMD ["node", "dist/server.js"]
