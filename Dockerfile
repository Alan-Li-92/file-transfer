FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache tar

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY server.js ./server.js
COPY file-transfer.env ./file-transfer.env

RUN mkdir -p /app/storage/uploads /app/storage/chunks

ENV HOST=0.0.0.0
ENV PORT=3011
ENV BASE_PATH=
ENV FILE_TTL_HOURS=24
ENV CLEANUP_INTERVAL_MINUTES=15
ENV MAX_UPLOAD_MB=10240
ENV ROOM_TTL_HOURS=24

VOLUME ["/app/storage"]

EXPOSE 3011

CMD ["node", "server.js"]
