FROM node:18

WORKDIR /usr/src/app

COPY package*.json ./

# Production dependencies only (skips jest/supertest/puppeteer and its Chromium download)
RUN npm ci --omit=dev
RUN npm rebuild sqlite3

COPY . .

# Persistent data (SQLite database + generated JWT secret) lives in /usr/src/app/data
RUN mkdir -p /usr/src/app/data && chown -R node:node /usr/src/app
VOLUME ["/usr/src/app/data"]

USER node
ENV NODE_ENV=production
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
