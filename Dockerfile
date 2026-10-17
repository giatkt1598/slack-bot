FROM node:24-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Node 24 runs the TypeScript sources directly (type stripping); no build step.
COPY src ./src

RUN mkdir -p /data
VOLUME ["/data"]

CMD ["npm", "run", "start:bot"]
