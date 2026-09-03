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
  && apt-get install -y --no-install-recommends openssl ca-certificates curl python3 python3-pip \
  && pip3 install --break-system-packages --no-cache-dir "semgrep==${SEMGREP_VERSION}" \
  && apt-get purge -y python3-pip && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
# Prove the binary survives the purge and autoremove above. Without this the
# first sign of a broken install is "semgrep is not installed or not on PATH"
# during an analysis, long after the image shipped.
RUN semgrep --version

# The registry packs are fetched here rather than on every scan. Resolving one
# pack cost 3.9 seconds in a measured scan and seven are configured; worse, it
# makes an analysis depend on semgrep.dev being reachable from the running
# service. Baked in, the rules are also fixed for the life of the image, so two
# scans of the same commit agree with each other.
ARG SEMGREP_PACKS="default owasp-top-ten secrets dockerfile github-actions terraform kubernetes"
RUN mkdir -p /opt/semgrep-rules \
  && for pack in ${SEMGREP_PACKS}; do \
       curl -fsSL "https://semgrep.dev/c/p/${pack}" -o "/opt/semgrep-rules/${pack}.yaml"; \
     done \
  && semgrep --config /opt/semgrep-rules --validate
# Point scans at the local copies. The env var is only set in the image, so a
# developer without these files still resolves the packs from the registry.
ENV SEMGREP_CONFIG=/opt/semgrep-rules
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build /app/apps/api/dist /app/apps/api/dist
COPY --from=build /app/apps/api/prisma /app/apps/api/prisma
COPY --from=build /app/apps/api/package.json /app/apps/api/package.json
EXPOSE 4000
CMD ["node", "dist/index.js"]
