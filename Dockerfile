FROM node:22-alpine AS build

WORKDIR /app

# Install build tools needed for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

# Install dependencies (layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# --- Production stage (no build tools) ---
FROM node:22-alpine

WORKDIR /app

# Copy node_modules with pre-built native addons
COPY --from=build /app/node_modules ./node_modules

# Copy app source
COPY . .

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:${PORT:-8000}/health || exit 1

# Start the app
CMD ["node", "server.js"]
