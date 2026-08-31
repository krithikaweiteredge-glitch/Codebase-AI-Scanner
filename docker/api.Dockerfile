FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install --workspace @codebase-ai/api --include-workspace-root
COPY apps/api apps/api
RUN npm --workspace @codebase-ai/api run db:generate && npm --workspace @codebase-ai/api run build

FROM node:22-bookworm-slim
WORKDIR /app/apps/api
# semgrep powers the dataflow analysis step. It is a Python program, so it is
# installed here rather than through npm; the API detects it at runtime and
# skips that step cleanly on images or hosts that do not have it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates python3 python3-pip \
  && pip3 install --break-system-packages --no-cache-dir semgrep \
  && apt-get purge -y python3-pip && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build /app/apps/api/dist /app/apps/api/dist
COPY --from=build /app/apps/api/prisma /app/apps/api/prisma
COPY --from=build /app/apps/api/package.json /app/apps/api/package.json
EXPOSE 4000
CMD ["node", "dist/index.js"]
