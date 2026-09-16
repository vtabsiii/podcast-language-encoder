# syntax=docker/dockerfile:1.7
# apps/web (Next.js standalone output) on Node 22. Build from the repository root:
#   docker build -f apps/web/Dockerfile -t polycast/web:<tag> .
# Built and published by `cdk deploy` as a Docker image asset (docs/aws-setup.md "Polycast stacks").

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

FROM base AS build
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter @polycast/web...
RUN pnpm --filter @polycast/web... run build
# `public/` is optional in this app; create it so the runtime COPY below never fails.
RUN mkdir -p apps/web/public

FROM node:22-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# In a pnpm workspace the standalone output nests the app under apps/web.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
