## Install

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
    "languageId": "YOUR_LANGUAGE_ID", // example: en, it, de etc ...
    "mqttURL": "mqtt://MQTT_HOST:MQTT_PORT",
    "mqttUsername": "MQTT_USERNAME",
    "mqttPassword": "MQTT_PASSWORD"
}

```

## Subscribe Topics

risco-mqtt-home-assistant subscribe to startup one topic for every partition in your risco alarm panel configuration.

Format of the topics are `riscopanel/alarm/${partition.id}/set` where partition.id is the id of the partition

Payload could be : **disarmed** if risco panel is disarmed,**armed_home** if risco panel is **armed_home** and armed_away if risco panel is armed_away.

## Publish Topics

risco-mqtt-home-assistant publish one topic for every partition and for every zones in your risco alarm panel configuration.

Format of partitions topics are `riscopanel/alarm/${partition.id}/status` where **partition.id** is the id of the partition

Payload could be : **disarmed** if risco panel is disarmed,**armed_home** if risco panel is **armed_home** and armed_away if risco panel is armed_away.

Format of zones topics are `riscopanel/alarm/${partition.id}/sensor/${zone.zoneID}/status` where **partition.id** is the id of the partition and **zone.zoneID** is the id of the zone.

Payload could be : **triggered** if zone is curently triggered, and **idle** if zone is currently idle.

In addition for every zones, risco-mqtt-home-assistant publish a topic for every zone with the payload of all the infos of the zone in json format. Format of these topics are `riscopanel/alarm/${partition.id}/sensor/${zone.zoneID}` where **partition.id** is the id of the partition and **zone.zoneID** is the id of the zone.


## Usage

This is the simplest usage you can do with risco-mqtt-home-assistant

### Start risco-mqtt client

```
const riscoMqttHassio = require('../risco-mqtt-home-assistant')
const config = require('./config.json')

riscoMqttHassio(config)
```