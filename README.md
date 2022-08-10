[![license badge](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/vanackej/risco-mqtt-local/blob/main/LICENSE)
[![Package Version](https://shields.io/npm/v/@vanackej/risco-mqtt-local/latest)](https://www.npmjs.com/package/@vanackej/risco-mqtt-local)
[![Docker Pulls](https://img.shields.io/docker/pulls/vanackej/risco-mqtt-local)](https://hub.docker.com/r/vanackej/risco-mqtt-local)
[![Node Version](https://shields.io/node/v/@vanackej/risco-mqtt-local)](https://www.npmjs.com/package/@vanackej/risco-mqtt-local)
[![Maintenance badge](https://shields.io/badge/maintenance-yes-green.svg)](https://www.npmjs.com/package/@vanackej/risco-mqtt-local)

[![Add to Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fvanackej%2Frisco-mqtt-local)

# Risco MQTT Local integration

Provide Risco alarm panels integration to Home Assistant using Local TCP communication with Panel (no cloud access required)

Low level communication to the Risco Panel is provided by [Risco Lan library](https://github.com/vanackej/risco-lan-bridge)

## Requirements

- Node.js (currently tested with >=ver. 10.x)
- Mqtt Server - e.g. Mosquitto, HiveMQ, etc.
- Home Assistant

## Features

- Interaction with RISCO alarm control panel using local APIs.
- Interaction with MQTT Alarm Control Panel integration in Home Assistant.
- Interaction with MQTT Binary Sensor integration in Home Assistant.
- Home Assistant MQTT Auto Discovery.
- RISCO multipartitions.
- Bypass zones in Home Assistant (additional switch created for each zone)
- Multiple systems now supported with configurable alarm topic.

## Installation

```
npm install @vanackej/risco-mqtt-local
```

## Configuration

Create a file config.json in your project directory.

```
{
  "log": "info", // Optional, default to "info"
  "panel": {
    "panelIp": "192.168.1.150",
    "panelPort": 1000,
    "panelPassword": "1234",
    "panelId": 1,
    "watchDogInterval": 10000,
    "commandsLog": false // If enabled, dump all commands in a file named risco-commands-${date}.csv
  },
  "ha_discovery_prefix_topic": "homeassistant", //Optional
  "panel_name": "alarm", // Optional custom panel name
  "mqtt": {
    "url": "mqtt://192.168.1.10:1883",
    "username": "MQTT_USERNAME",
    "password": "MQTT_PASSWORD"
  },
  "zones": {
    "default": { // Default zones configuration
      "off_delay": 30, // Optional auto off configuration for detectors. 0 to disable (default value: disabled)
      "name_prefix": "Sensor - " // A common prefix, added before all zone name
    },
    "GARAGE": { // Override config for an individual zone (based on zone label)
      "off_delay": 0, // Disable off_delay for this zone.
      "device_class": "garage_door", // override device class for binary sensor. default to "motion". see HA documentation for available values
      "name": "Garage Door", // Override default name for this zone. Default to zone label
      "name_prefix": "" // Force zone name prefix to empty for this zone
    },
  "user_outputs": {
    "default": {
      "name_prefix": ""
    },
    "Up/over Trigger": { 
      "device_class": "garage", 
      "name": "Garage door trigger RISCO", 
      "name_prefix": "" 
    }
  },
  "system_outputs": {
    "default": {
      "name_prefix": ""
    },
    "Bell": { 
      "device_class": "sound", 
      "name": "Alarm Bell", 
      "name_prefix": "" 
    },
    "Strobe": { 
      "device_class": "light", 
      "name": "Alarm Strobe", 
      "name_prefix": "" 
    }
  }
}

```

The panel full configuration options are described here : https://github.com/vanackej/risco-lan-bridge#configuration

NB Ensure that zone description matches label stored in panel exactly (including case) to ensure that config is correctly represented.

### Multiple panels support

To integrate multiple panels to a single HA instance, you must start one process/docker container instance for each panel.
Each panel must have a unique **panel_name** value in its configuration file. 
`panel_name` is automatically converted to a suitable `panel_node_id`, used in various topics definitions and subscriptions. 
`panel_name` is also used as HA device name

## Subscribe Topics

**risco-mqtt-local** subscribes at startup one topic for every partition in your risco alarm panel configuration.

Topics format is `riscopanel/${panel_node_id}/<partition_id>/set` where **partition_id** is the id of the partition

Payload could be : **disarmed** if risco panel is in disarmed mode,**armed_home** if risco panel is in armed at home mode and **armed_away** if risco panel is in armed away mode.

## Publish Topics

risco-mqtt-local publishes one topic for every partition and for every zones in your risco alarm panel configuration.

Partitions topics format is `riscopanel/${panel_node_id}/<partition_id>/status` where **partition_id** is the id of the partition

Payload could be : **disarmed** if risco panel is in disarmed mode,**armed_home** if risco panel is in armed at home mode and **armed_away** if risco panel is in armed away mode.

Zones topics format is `riscopanel/${panel_node_id}/<partition_id>/sensor/<zone_id>/status` where **partition_id** is the id of the partition and **zone_id** is the id of the zone.

Payload could be : **triggered** if zone is currently triggered, and **idle** if zone is currently idle.

In addition to every zones, risco-mqtt-local publishes a topic for every zone with all the info of the zone in the payload in json format. Topics format is `riscopanel/${panel_node_id}/<partition_id>/sensor/<zone_id>` where **partition_id** is the id of the partition and **zone_id** is the id of the zone.

## Home Assistant Auto Discovery

risco-mqtt-local supports [mqtt auto discovery](https://www.home-assistant.io/docs/mqtt/discovery/) feature.

Default `<discovery_prefix>` is **homeassistant**. You can change it by overwriting the value within **home-assistant-discovery-prefix** config.

Home assistant auto discovery republished on Home Assistant restart.

## Usage

First, create the `config.json` file.

### Using Node

To start risco-mqtt-local you can simply type:

`npx @vanackej/risco-mqtt-local`

### Using Docker image

`docker run -v $(pwd)/config.json:/data/config.json vanackej/risco-mqtt-local`

## Support

### Bug reports

Please use the bug issue template and fill all requested informations, including debug logs and commands logs.

## Credits

Thanks to [TJForc](https://github.com/TJForc) for the initial local communication library and [Alessandro Mancini](https://github.com/mancioshell) for his initial work
