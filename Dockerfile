FROM node:20-bookworm-slim

WORKDIR /app

COPY . .

RUN npm ci && npm run build

EXPOSE 4000

CMD ["npm", "run", "serve"]
