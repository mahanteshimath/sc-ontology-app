# Reproducible container image for the Next.js standalone server.
# `snow app deploy` builds from app.yml and does not use this file; it exists so the same image can
# be built and run outside Snowflake App Runtime (local SPCS testing, image scanning, other registries).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build \
 && cp -r .next/static .next/standalone/.next/static \
 && cp -r public .next/standalone/public

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
