FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy app source
COPY . .

# Expose port (Koyeb sets PORT env var)
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:${PORT:-8000}/health || exit 1

# Start the app
CMD ["node", "server.js"]
