FROM node:18

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci
RUN npm rebuild sqlite3

COPY . .

EXPOSE 8080

CMD ["npm", "start"]