FROM node:24-alpine

WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
COPY data ./data

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.mjs"]
