# The app image. Node 22 on purpose: the host runs Node 18, and this codebase
# uses `node --test` and ESM without a build step, so the runtime is the
# contract. Build context is this directory; there is nothing outside it.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 8899
CMD ["node", "src/http/server.js"]
