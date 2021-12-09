FROM node:lts-alpine

WORKDIR /usr/src/app

COPY package.json ./
COPY tsconfig.json ./
COPY yarn.lock ./
COPY src/** ./
COPY . .
RUN yarn install
RUN yarn build

CMD [ "node", "./dist/main.js" ]
