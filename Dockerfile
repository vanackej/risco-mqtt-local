ARG NODE_VERSION="16"
ARG BASE_IMAGE="node:${NODE_VERSION}-alpine"

FROM ${BASE_IMAGE} AS build

WORKDIR /workspace

COPY package.json yarn.lock ./

RUN yarn install

COPY . ./

RUN yarn run build \
    && yarn install --production


FROM scratch AS rootfs

COPY --from=build /workspace/node_modules /app/node_modules

COPY --from=build /workspace/dist /app/dist

COPY --from=build /workspace/config-sample.json /app/


FROM ${BASE_IMAGE}

WORKDIR /data

COPY --from=rootfs / /

CMD [ "node", "/app/dist/main.js" ]
