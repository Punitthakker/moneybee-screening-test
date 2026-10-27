FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

# Downloaded UN list is cached here, mounted as a volume by docker-compose
VOLUME ["/app/data"]

CMD ["node", "server.js"]
