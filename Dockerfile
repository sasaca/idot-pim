# Dockerfile — Fly.io deploy target for iDOT PIM.
# Multi-stage so the runtime image doesn't carry build tools.

# ---------- Build stage: compile better-sqlite3 native module ----------
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev

# ---------- Runtime stage ----------
FROM node:22-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY . .
# Ensure mount point exists before the volume is attached.
RUN mkdir -p /data /data/uploads
ENV NODE_ENV=production \
    DB_PATH=/data/idot.sqlite \
    UPLOAD_DIR=/data/uploads \
    PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
