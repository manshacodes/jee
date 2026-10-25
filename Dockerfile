# syntax=docker/dockerfile:1

FROM node:22-alpine

# Run as the unprivileged user the base image already provides.
ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first so a code-only change reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# Scraped notices, settings, push subscriptions and the VAPID key pair live
# here. Mount a volume at this path to keep them across restarts.
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
