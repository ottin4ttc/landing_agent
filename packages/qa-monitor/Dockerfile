# landingAgent-specific (not upstream openclaw): image for the qa-monitor
# service. Built on the BCC self-hosted runner with CN mirrors. Two stages:
# a full workspace install that builds the gateway-client dep, then `pnpm
# deploy` to produce a standalone package dir, run on a slim node image.
# node:sqlite is built into node 24 (no native module to install).

FROM node:24-bookworm AS build
WORKDIR /app
COPY . .
# CN build mirrors + network tuning (see .github/workflows/deploy.yml rationale)
RUN echo "registry=https://registry.npmmirror.com/" >> .npmrc \
 && printf '\nnetworkConcurrency: 2\nfetchTimeout: 1800000\nfetchRetries: 6\n' >> pnpm-workspace.yaml
RUN corepack enable \
 && pnpm install --frozen-lockfile \
      --config.supportedArchitectures.os=linux \
      --config.supportedArchitectures.cpu="$(node -p 'process.arch')" \
      --config.supportedArchitectures.libc=glibc
# gateway-client (and its gateway-protocol dep) ship as TS; build their dist
# so the deployed qa-monitor can import them at runtime.
RUN pnpm --filter @openclaw/gateway-protocol --filter @openclaw/gateway-client build
# Produce a self-contained deploy dir with qa-monitor + its prod deps.
RUN pnpm --filter @openclaw/qa-monitor deploy --prod /out

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
RUN mkdir -p /data
EXPOSE 19010
# qa-monitor's start script runs src/index.ts via --experimental-strip-types;
# the openclaw type-only import is erased at strip time, so it needs no source.
CMD ["node", "--experimental-strip-types", "src/index.ts"]
