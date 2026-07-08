# landingAgent-specific (not upstream openclaw): qa-monitor image.
# qa-monitor has NO third-party runtime deps — it reads the gateway's session
# files from a mounted volume and uses only node built-ins (node:sqlite,
# node:http, node:fs). So the image is just the TS source on a slim node.
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY packages/qa-monitor/package.json ./package.json
COPY packages/qa-monitor/src ./src
RUN mkdir -p /data
EXPOSE 19010
# node runs the TS sources directly via --experimental-strip-types.
CMD ["node", "--experimental-strip-types", "src/index.ts"]
