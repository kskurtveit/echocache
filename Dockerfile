FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY README.md AGENTS.md LICENSE ./

ENV ECHOCACHE_DB_PATH=/data/cache.db
VOLUME /data

ENTRYPOINT ["node", "dist/index.js"]
