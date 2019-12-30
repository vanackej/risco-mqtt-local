# risco-mqtt-home-assistant

This project is  highly inspired by [risco-mqtt-bridge](https://github.com/lucacalcaterra/risco-mqtt-bridge) by [Luca Calcaterra](https://github.com/lucacalcaterra) but differ from it because use Risco REST API sniffed from [iRISCO](https://play.google.com/store/apps/details?id=com.homeguard&hl=it) app. 

## Motivations

Sometimes Risco Cloud Web API (that is the basis on which [risco-mqtt-bridge](https://github.com/lucacalcaterra/risco-mqtt-bridge) was developed) does not respond at sensors change state unless you force to update alarm panel change state. So i have decided to change the source of informations about risco alarm panel from Web APIs to REST APIs like from the mobile App.

**risco-mqtt-home-assistant** supports also Home Assistant Auto Discovery.

## Requirements
* Node.js (currently tested with >=ver. 10.x)
* Mqtt Server - e.g. Mosquitto, HiveMQ, etc.
* Home Assistant

## Installation

```
npm install --save risco-mqtt-home-assistant
```

## Configuration

Create a file config.json in your project directory.

```
{
    "username": "YOUR_RISCO_EMAIL",
    "password": "YOUR_RISCO_PASSWORD",
    "pin": "YOUR_CENTRAL_PIN_CODE",
    "language-id": "YOUR_LANGUAGE_ID", // example: en, it, de etc ...
    "mqtt-url": "mqtt://MQTT_HOST:MQTT_PORT",
    "mqtt-username": "MQTT_USERNAME",
    "mqtt-password": "MQTT_PASSWORD",
    "interval-polling": "RISCO_INTERVAL_POLLING", // default is 5000
    "home-assistant-discovery-prefix" : "YOUR_HOME-ASSISTANT-DISCOVERY-PREFIX" // default is homeassistant
}

```

## Subscribe Topics

**risco-mqtt-home-assistant** subscribes at startup one topic for every partition in your risco alarm panel configuration.

Topics format is `riscopanel/alarm/<partition_id>/set` where **partition_id** is the id of the partition

Payload could be : **disarmed** if risco panel is in disarmed mode,**armed_home** if risco panel is in armed at home mode and **armed_away** if risco panel is in armed away mode.

## Publish Topics

risco-mqtt-home-assistant publishes one topic for every partition and for every zones in your risco alarm panel configuration.

Partitions topics format is `riscopanel/alarm/<partition_id>/status` where **partition_id** is the id of the partition

Payload could be : **disarmed** if risco panel is in disarmed mode,**armed_home** if risco panel is in armed at home mode and **armed_away** if risco panel is in armed away mode.

Zones topics format is `riscopanel/alarm/<partition_id>/sensor/<zone_id>/status` where **partition_id** is the id of the partition and **zone_id** is the id of the zone.

Payload could be : **triggered** if zone is curently triggered, and **idle** if zone is currently idle.

In addition for every zones, risco-mqtt-home-assistant publishes a topic for every zone with all the infos of the zone in the paylaod in json format. Topics format is `riscopanel/alarm/<partition_id>/sensor/<zone_id>` where **partition_id** is the id of the partition and **zone_id** is the id of the zone.

## Home Assistant Auto Discovery

risco-mqtt-home-assistant supports [mqtt auto discovery](https://www.home-assistant.io/docs/mqtt/discovery/) feature.

Default `<discovery_prefix>` is **homeassistant**. You can change it overwriting in **home-assistant-discovery-prefix** config.

## Usage

To start risco-mqtt-home-assistant you can simply type:

`npx risco-mqtt-home-assistant`