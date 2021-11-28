# risco-mqtt-local

This project is a fork of [risco-mqtt-home-assistant](https://github.com/mancioshell/risco-mqtt-home-assistant) by [Alessandro Mancini](https://github.com/mancioshell), using local APIs instead of RiscoCloud APIs.
Local APIs are based on [TJForc](https://github.com/TJForc) [local RISCO communication library](https://github.com/TJForc/risco-lan-bridge)

## Requirements
* Node.js (currently tested with >=ver. 10.x)
* Mqtt Server - e.g. Mosquitto, HiveMQ, etc.
* Home Assistant

## Features
* Interaction with RISCO alarm control panel using local APIs.
* Interaction with MQTT Alarm Control Panel integration in Home Assistant.
* Interaction with MQTT Binary Sensor integration in Home Assistant.
* Home Assistant MQTT Auto Discovery.
* RISCO multipartitions.

## Installation

```
npm install risco-mqtt-local
```

## Configuration

Create a file config.json in your project directory.

```
{
  "log": "debug", // Optional, default to "info"
  "panel": {
    "Panel_IP": "YOUR_PANEL_IP",
    "Panel_Port": YOUR_PANEL_PORT, // default is 1000
    "Panel_Password": XXXX, //Panel installer code
    "Panel_Id": "0001", // Optional, default to "0001"
    "WatchDogInterval": 10000 // Optional, default to 5000
  },
  "mqtt": {
    "url": "mqtt://MQTT_HOST:MQTT_PORT",
    "username": "MQTT_USERNAME",
    "password": "MQTT_PASSWORD",
    "zone-label-prefix": "Détecteur - " // Will be added as prefix for zones names, in order to get more user friendly names. Default is empty
  }
}

```

## Subscribe Topics

**risco-mqtt-local** subscribes at startup one topic for every partition in your risco alarm panel configuration.

Topics format is `riscopanel/alarm/<partition_id>/set` where **partition_id** is the id of the partition

Payload could be : **disarmed** if risco panel is in disarmed mode,**armed_home** if risco panel is in armed at home mode and **armed_away** if risco panel is in armed away mode.

## Publish Topics

risco-mqtt-local publishes one topic for every partition and for every zones in your risco alarm panel configuration.

Partitions topics format is `riscopanel/alarm/<partition_id>/status` where **partition_id** is the id of the partition

Payload could be : **disarmed** if risco panel is in disarmed mode,**armed_home** if risco panel is in armed at home mode and **armed_away** if risco panel is in armed away mode.

Zones topics format is `riscopanel/alarm/<partition_id>/sensor/<zone_id>/status` where **partition_id** is the id of the partition and **zone_id** is the id of the zone.

Payload could be : **triggered** if zone is curently triggered, and **idle** if zone is currently idle.

In addition to every zones, risco-mqtt-local publishes a topic for every zone with all the info of the zone in the paylaod in json format. Topics format is `riscopanel/alarm/<partition_id>/sensor/<zone_id>` where **partition_id** is the id of the partition and **zone_id** is the id of the zone.

## Home Assistant Auto Discovery

risco-mqtt-local supports [mqtt auto discovery](https://www.home-assistant.io/docs/mqtt/discovery/) feature.

Default `<discovery_prefix>` is **homeassistant**. You can change it by overwriting the value within **home-assistant-discovery-prefix** config.

## Usage

### Using Node

To start risco-mqtt-local you can simply type:

`npx @vanackej/risco-mqtt-local`

### Using Docker image

`docker run -v $(pwd)/config.json:/usr/src/app/config.json vanackej/risco-mqtt-local`

## Credits

Thanks to [TJForc](https://github.com/TJForc) and [Alessandro Mancini](https://github.com/mancioshell) for their initial work