FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js store.js ./
COPY public ./public
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["node", "server.js"]
