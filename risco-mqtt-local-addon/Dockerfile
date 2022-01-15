ARG BUILD_FROM
FROM $BUILD_FROM

RUN apk add --no-cache nodejs npm
RUN npm install -g npx
RUN npm install -g @vanackej/risco-mqtt-local@0.3.3

WORKDIR /data

COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]