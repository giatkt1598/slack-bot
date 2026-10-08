FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN mkdir -p /data
VOLUME ["/data"]

CMD ["npm", "run", "start:bot"]
