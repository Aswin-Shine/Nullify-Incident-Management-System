# ============================================================
# Nullify — Frontend Dockerfile (multi-stage)
# Stage 1: builder  — Node 20, npm ci, vite build
# Stage 2: runtime  — nginx:alpine serves static dist/
# ============================================================

# ── Stage 1: builder ────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /build

# Copy lockfile first — layer cache: npm ci only reruns when lockfile changes
COPY package.json package-lock.json ./

# Clean install — exact versions from lockfile, no network after this layer
RUN npm ci --silent

# Copy source and build
COPY . .

# Build arg for API URL — in Docker, nginx proxies /api so base is just ""
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build
# Output: /build/dist/


# ── Stage 2: runtime ────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

LABEL org.opencontainers.image.title="nullify-frontend"
LABEL org.opencontainers.image.description="Nullify IMS — React frontend (static)"

# Remove default nginx content
RUN rm -rf /usr/share/nginx/html/*

# Copy built assets from builder
COPY --from=builder /build/dist /usr/share/nginx/html

# Nginx config — SPA routing + reverse proxy to backend
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Non-root: nginx can run as nginx user (already exists in image)
# Nginx master process stays root to bind :80, workers drop to nginx
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
