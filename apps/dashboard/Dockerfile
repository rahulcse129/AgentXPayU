# Margin dashboard (Next.js). Build from apps/dashboard:
#   docker build -t margin-dashboard .
# NEXT_PUBLIC_ENGINE_URL is baked into the client bundle. The default, "same-origin", calls the engine at
# /api on whatever host serves the page, which is how the AWS stack routes it, so no rebuild per domain.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG NEXT_PUBLIC_ENGINE_URL=same-origin
ENV NEXT_PUBLIC_ENGINE_URL=$NEXT_PUBLIC_ENGINE_URL NEXT_TELEMETRY_DISABLED=1
# Dev deps stay installed: next start loads next.config.ts.
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/next.config.ts ./
USER node
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000", "-H", "0.0.0.0"]
