# RTPulse Web — Multi-stage Docker build (Next.js 15 standalone)

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# ffmpeg: HLS → mp4 변환 (NAS 업로드 파이프라인)
RUN apk add --no-cache ffmpeg

RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nextjs

# standalone output
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# 대용량 NAS 업로드용 — Node HTTP requestTimeout(기본 5분) 상향 프리로드
COPY --from=builder --chown=nextjs:nodejs /app/server-timeout.js ./server-timeout.js

# Persistent data directory (mounted from host or GCS sync)
RUN mkdir -p /app/data/cameras && chown -R nextjs:nodejs /app/data

USER nextjs
EXPOSE 3000

CMD ["node", "--require", "./server-timeout.js", "server.js"]
