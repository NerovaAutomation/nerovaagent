FROM node:20-bullseye

WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    coturn ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY start.sh ./start.sh
RUN chmod +x ./start.sh

ENV NODE_ENV=production \
    PORT=8080

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["./start.sh"]
