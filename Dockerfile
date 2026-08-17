FROM node:22-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3001
# mediasoup RTC UDP range
EXPOSE 40000-40100/udp

ENV NODE_ENV=production
ENV PORT=3001
ENV MEDIASOUP_MIN_PORT=40000
ENV MEDIASOUP_MAX_PORT=40100
ENV MEDIASOUP_ANNOUNCED_IP=127.0.0.1
ENV LMS_ADMIN_PASSWORD=admin

CMD ["node", "server/index.js"]
