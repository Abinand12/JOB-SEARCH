# Railway builds this automatically. Only the server is deployed; the extension
# runs in your own Chrome.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/src ./src
COPY server/public ./public
USER node
CMD ["node", "src/index.js"]
