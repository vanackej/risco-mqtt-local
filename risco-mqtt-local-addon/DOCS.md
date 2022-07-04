# Risco MQTT Addon

## Configuration

The addon cannot be configured from the addon configuration page. In order to configure the addon, you need to add/edit the `/config/risco-mqtt.json` file and restart the addon.

To create and edit the configuration file, you can use [Studio Code Server addon](https://github.com/hassio-addons/addon-vscode#readme) or Home assistant File Editor.

## Building from source

The addon just extends the risco-mqtt-local docker image. Therefore, if you make changes to the
source code of the risco-mqtt (and not the addon itself), you will need to rebuild the risco-mqtt image.
