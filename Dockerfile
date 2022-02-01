ARG NODE_VERSION="16"
ARG BASE_IMAGE="node:${NODE_VERSION}-alpine"

FROM ${BASE_IMAGE} AS build

WORKDIR /workspace

COPY package.json yarn.lock ./

RUN yarn install

COPY . ./

RUN yarn run build


FROM scratch AS rootfs

COPY --from=build /workspace/dist /dist

COPY --from=build /workspace/config-sample.json /dist/


FROM ${BASE_IMAGE}

WORKDIR /data

COPY --from=rootfs / /

CMD [ "node", "/dist/main.js" ]
