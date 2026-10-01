# Immutable Debian Node base; first supported publication platform is linux/amd64.
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --registry=https://registry.npmjs.org/

FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS runtime
ARG VERSION
ARG REVISION=unknown
LABEL org.opencontainers.image.title="TextGraph renderer" \
      org.opencontainers.image.source="https://github.com/drawmotive/textgraph-renderer" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$REVISION \
      dev.drawmotive.textgraph.provenance="/app/provenance.json"
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json LICENSE ./
COPY src ./src
COPY scripts/provenance.mjs ./scripts/provenance.mjs
# Derive installed SDK/engine identity, preserving all dependency and font licenses.
RUN EXPECTED_SERVICE_VERSION="$VERSION" node scripts/provenance.mjs /app/provenance.json
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 CMD ["node", "--input-type=module", "-e", "const r=await fetch('http://127.0.0.1:'+process.env.PORT+'/health',{signal:AbortSignal.timeout(4000)});process.exit(r.ok?0:1)"]
CMD ["node", "src/main.js"]
