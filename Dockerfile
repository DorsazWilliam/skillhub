# SkillHub on Node: one image for docker run, Compose and Kubernetes (docs/SELF_HOSTING.md).
# Default: SQLite and uploads on /data. Set DATABASE_URL=postgres://... and STORAGE=s3 for Postgres and a bucket.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY . .
RUN node scripts/build-web.mjs && node scripts/build-node.mjs

FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_URL=sqlite:/data/skillhub.db \
    STORAGE=disk \
    STORAGE_DIR=/data/files \
    MIGRATIONS_DIR=/app/migrations \
    ASSETS_DIR=/app/web/dist
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY migrations ./migrations
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/livez').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--no-warnings", "--enable-source-maps", "dist/server.mjs"]
