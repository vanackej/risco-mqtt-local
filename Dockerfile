FROM node:latest

WORKDIR /usr/src/app

RUN npm install risco-mqtt-home-assistant

COPY config/ .

CMD [ "npx", "risco-mqtt-home-assistant" ]