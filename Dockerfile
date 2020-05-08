FROM node:latest

WORKDIR /usr/src/app

RUN npm install risco-mqtt-home-assistant

CMD [ "npx", "risco-mqtt-home-assistant" ]
