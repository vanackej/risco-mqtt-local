#! /bin/sh
echo "Current dir is ${pwd}"
ls
cat options.json
cp options.json config.json
cat /data/config.json
npx @vanackej/risco-mqtt-local