FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install --workspace @codebase-ai/api --include-workspace-root
COPY apps/api apps/api
# npm workspaces hoist dependencies to the root, so apps/api/node_modules is
# only created when a version conflict forces nesting - usually it does not
# exist at all. The runtime stage copies it unconditionally, so make sure
# there is something to copy. Until this image had a .dockerignore the path
# happened to exist because `COPY apps/api apps/api` pulled in the host's
# node_modules, which meant the image shipped modules resolved for whatever
# platform the build ran on.
RUN npm --workspace @codebase-ai/api run db:generate && npm --workspace @codebase-ai/api run build && mkdir -p /app/apps/api/node_modules

FROM node:22-bookworm-slim
WORKDIR /app/apps/api
# semgrep powers the dataflow analysis step. It is a Python program, so it is
# installed here rather than through npm; the API detects it at runtime and
# skips that step cleanly on images or hosts that do not have it.
#
# The version is pinned because semgrep's findings are user-facing: an
# unpinned install lets two builds of the same commit, a month apart, report
# different vulnerabilities on the same code. Bump it deliberately.
ARG SEMGREP_VERSION=1.175.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates python3 python3-pip \
  && pip3 install --break-system-packages --no-cache-dir "semgrep==${SEMGREP_VERSION}" \
  && apt-get purge -y python3-pip && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
# Prove the binary survives the purge and autoremove above. Without this the
# first sign of a broken install is "semgrep is not installed or not on PATH"
# during an analysis, long after the image shipped.
RUN semgrep --version
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build /app/apps/api/dist /app/apps/api/dist
COPY --from=build /app/apps/api/prisma /app/apps/api/prisma
COPY --from=build /app/apps/api/package.json /app/apps/api/package.json
EXPOSE 4000
CMD ["node", "dist/index.js"]
