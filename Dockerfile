FROM node:lts-alpine

WORKDIR /usr/src/app

COPY package.json ./
COPY yarn.lock ./
RUN yarn install
COPY . .

CMD [ "node", "./bin/risco-mqtt-local.js" ]
