# One image for the API and the built UI. The Fastify process serves both from a
# single origin, exactly as the Render deploy does.
#
# Dev dependencies stay in the image on purpose:
#   - The workspace packages export raw TypeScript, and the API runs under tsx.
#   - `pnpm start` applies migrations with the prisma CLI.
# Both of those are devDependencies. Pruning them would need a compile step, and
# this repo deliberately has none. The stages below exist for layer caching, not
# to slim the image.

FROM node:22-slim AS base
# Prisma's query engine links against OpenSSL, which the slim image leaves out.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# The pnpm version comes from package.json `packageManager`, via corepack.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Install from manifests only. This layer stays cached until a package.json or
# the lockfile changes, so ordinary code edits don't trigger a reinstall.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/ui/package.json apps/ui/
COPY packages/adapter/package.json packages/adapter/
COPY packages/core/package.json packages/core/
COPY packages/llm/package.json packages/llm/
COPY packages/simulator/package.json packages/simulator/
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm db:generate && pnpm ui:build

FROM build AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
EXPOSE 3000
# Applies migrations, then boots the API. With SEED_ON_BOOT=true, an empty store
# is seeded through POST /evidence-pack. Assembly runs in replay mode unless
# ASSEMBLY_MODE=live is set, so this image never calls a model by default.
CMD ["pnpm", "start"]
