FROM node:22-alpine
WORKDIR /app
COPY server/package.json ./package.json
RUN npm install --omit=dev
COPY server/index.mjs ./server/index.mjs
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/index.mjs"]
