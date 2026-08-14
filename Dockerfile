FROM node:24-alpine

WORKDIR /app
COPY package.json server.mjs ./
COPY lib ./lib
COPY public ./public
COPY assets ./assets
COPY data ./data

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.mjs"]
