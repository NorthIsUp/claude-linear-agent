# Multi-stage build keeps the runtime image small and free of devDeps + tsc.
# Build stage: install all deps, compile TypeScript to dist/.
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production-only deps, non-root user.
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Create and run as a non-root user. The image has no persistent state to
# protect, but running as root in a container is needless risk.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3001

# The bridge reads BASE_URL/PORT/etc from the environment at startup and
# fails fast if BASE_URL or the Anthropic creds are missing.
CMD ["node", "dist/index.js"]
