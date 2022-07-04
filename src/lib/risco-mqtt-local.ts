import { IClientOptions } from 'mqtt/types/lib/client';

import merge from 'lodash/merge';
import mqtt from 'mqtt';
import {
  RiscoPanel,
  RiscoLogger,
  Partition,
  PartitionList,
  Zone,
  ZoneList,
  PanelOptions,
} from '@vanackej/risco-lan-bridge/dist';
import pkg from 'winston';
import { cloneDeep } from 'lodash';

const { createLogger, format, transports } = pkg;
const { combine, timestamp, printf, colorize } = format;

type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug';

export interface RiscoMQTTConfig {
  log?: LogLevel,
  logColorize?: boolean,
  ha_discovery_prefix_topic?: string,
  panel_name?: string,
  panel_node_id?: string,
  zones?: {
    default?: ZoneConfig
    [label: string]: ZoneConfig
  }
  panel: PanelOptions,
  mqtt?: MQTTConfig
}

export interface MQTTConfig extends IClientOptions {
  url: string;
}

export interface ZoneConfig {
  off_delay?: number,
  device_class?: string,
  name?: string
  name_prefix?: string
}

const CONFIG_DEFAULTS: RiscoMQTTConfig = {
  log: 'info',
  logColorize: false,
  ha_discovery_prefix_topic: 'homeassistant',
  panel_name: 'Risco Alarm',
  panel_node_id: null,
  panel: {},
  zones: {
    default: {
      off_delay: 0,
      device_class: 'motion',
      name_prefix: '',
    },
  },
  mqtt: {
    url: null,
    username: null,
    password: null,
    reconnectPeriod: 5000,
    clientId: null,
    will: {
      topic: null, payload: 'offline', qos: 1, retain: true, properties: {
        willDelayInterval: 30,
      },
    },
  },
};

export function riscoMqttHomeAssistant(userConfig: RiscoMQTTConfig) {

  const config = merge(CONFIG_DEFAULTS, userConfig);

  let format = combine(
    timestamp({
      format: () => new Date().toLocaleString(),
    }),
    printf(({ level, message, label, timestamp }) => {
      return `${timestamp} [${level}] ${message}`;
    }),
  );
  if (config.logColorize) {
    format = combine(
      colorize({
        all: false,
        level: true,
      }),
      format,
    );
  }
  config.panel_name = config.panel_name.trim();
  if (!config.panel_node_id) {
    config.panel_node_id = config.panel_name.replace(/\s+/g, "_").toLowerCase();
  }

  const logger = createLogger({
    format: format,
    level: config.log || 'info',
    transports: [
      new transports.Console(),
    ],
  });

  logger.debug(`User config:\n${JSON.stringify(userConfig, null, 2)}`);
  logger.debug(`Merged config:\n${JSON.stringify(config, null, 2)}`);

  class WinstonRiscoLogger implements RiscoLogger {
    log(log_lvl: LogLevel, log_data: any) {
      logger.log(log_lvl, log_data);
    }
  }

  config.panel.logger = new WinstonRiscoLogger();

  let panelReady = false;
  let mqttReady = false;
  let listenerInstalled = false;

  if (!config.mqtt?.url) throw new Error('mqtt url option is required');

  const panel = new RiscoPanel(config.panel);

  panel.on('SystemInitComplete', () => {
    panel.riscoComm.tcpSocket.on('Disconnected', () => {
      panelReady = false;
      publishOffline();
    });
    if (!panelReady) {
      panelReady = true;
      panelOrMqttConnected();
    }
  });

  logger.info(`Connecting to mqtt server: ${config.mqtt.url}`);
  const mqtt_options: any = {
    will: {
      topic: getStatusTopic(),
    },
  };
  if (!config.mqtt.clientId) {
    mqtt_options.clientId = `risco-mqtt-${config.panel_node_id}-${Math.random().toString(16).substring(2, 8)}`;
  }
  const mqtt_merge = merge(config.mqtt, mqtt_options);

  const mqttClient = mqtt.connect(config.mqtt.url, mqtt_merge);

  mqttClient.on('connect', () => {
    logger.info(`Connected on mqtt server: ${config.mqtt.url}`);
    if (!mqttReady) {
      mqttReady = true;
      panelOrMqttConnected();
    }
  });

  mqttClient.on('reconnect', () => {
    logger.info('MQTT reconnect');
  });

  mqttClient.on('disconnect', () => {
    logger.info('MQTT disconnect');
    mqttReady = false;
  });

  mqttClient.on('close', () => {
    logger.info('MQTT close');
    mqttReady = false;
  });

  mqttClient.on('error', (error) => {
    logger.error(`MQTT connection error: ${error}`);
    mqttReady = false;
  });

  const ALARM_TOPIC_REGEX = new RegExp(`^riscopanel/${config.panel_node_id}/partition/([0-9]+)/set$`);
  const ZONE_BYPASS_TOPIC_REGEX = new RegExp(`^riscopanel/${config.panel_node_id}/zone/([0-9]+)-bypass/set$`);

  mqttClient.on('message', (topic, message) => {
    let m;
    if ((m = ALARM_TOPIC_REGEX.exec(topic)) !== null) {
      m.filter((match, groupIndex) => groupIndex !== 0).forEach(async (partitionId) => {
        const command = message.toString();
        logger.info(`[MQTT => Panel] Received change state command ${command} on topic ${topic} in partition ${partitionId}`);
        try {
          const success = await changeAlarmStatus(command, partitionId);
          if (success) {
            logger.info(`[MQTT => Panel] ${command} command sent on partition ${partitionId}`);
          } else {
            logger.error(`[MQTT => Panel] Failed to send ${command} command on partition ${partitionId}`);
          }
        } catch (err) {
          logger.error(`[MQTT => Panel] Error during state change command ${command} from topic ${topic} on partition ${partitionId}`);
          logger.error(err);
        }
      });
    } else if ((m = ZONE_BYPASS_TOPIC_REGEX.exec(topic)) !== null) {
      m.filter((match, groupIndex) => groupIndex !== 0).forEach(async (zoneId) => {
        const bypass = parseInt(message.toString(), 10) == 1;
        logger.info(`[MQTT => Panel] Received bypass zone command ${bypass} on topic ${topic} for zone ${zoneId}`);
        try {
          if (bypass !== panel.zones.byId(zoneId).Bypass) {
            const success = await panel.toggleBypassZone(zoneId);
            if (success) {
              logger.info(`[MQTT => Panel] toggle bypass command sent on zone ${zoneId}`);
            } else {
              logger.error(`[MQTT => Panel] Failed to send toggle bypass command on zone ${zoneId}`);
            }
          } else {
            logger.info('[MQTT => Panel] Zone is already on the desired bypass state');
          }
        } catch (err) {
          logger.error(`[MQTT => Panel] Error during zone bypass toggle command from topic ${topic} on zone ${zoneId}`);
          logger.error(err);
        }
      });
    } else if (topic == `${config.ha_discovery_prefix_topic}/status`) {
      if (message.toString() === 'online') {
        logger.info('Home Assistant is back online');
        panelOrMqttConnected();
      } else {
        logger.info('Home Assistant has gone offline');
      }
    }
  });

  async function changeAlarmStatus(code: string, partitionId: number) {
    switch (code) {
      case 'DISARM':
        return await panel.disarmPart(partitionId);
      case 'ARM_HOME':
      case 'ARM_NIGHT':
        return await panel.armHome(partitionId);
      case 'ARM_AWAY':
        return await panel.armAway(partitionId);
    }
  }

  function alarmPayload(partition: Partition) {
    if (partition.Alarm) {
      return 'triggered';
    } else if (!partition.Arm && !partition.HomeStay) {
      return 'disarmed';
    } else {
      if (partition.HomeStay) {
        return 'armed_home';
      } else {
        return 'armed_away';
      }
    }
  }

  function publishPartitionStateChanged(partition: Partition) {
    mqttClient.publish(`${getPartitionTopic(partition.Id)}/status`, alarmPayload(partition), {
      qos: 1,
      retain: true,
    });
    logger.info(`[Panel => MQTT] Published alarm status ${alarmPayload(partition)} on partition ${partition.Id}`);
  }

  function getStatusTopic() {
    return `riscopanel/${config.panel_node_id}/status`;
  }

  function getPartitionTopic(partitionId: number) {
    return `riscopanel/${config.panel_node_id}/partition/${partitionId}`;
  }

  function getZoneTopic(zoneId: number) {
    return `riscopanel/${config.panel_node_id}/zone/${zoneId}`;
  }

  function getZoneBypassTopic(zoneId: number) {
    return `riscopanel/${config.panel_node_id}/zone/${zoneId}-bypass`;
  }

  function publishZoneStateChange(zone: Zone, publishAttributes: boolean) {
    if (publishAttributes) {
      mqttClient.publish(getZoneTopic(zone.Id), JSON.stringify({
        id: zone.Id,
        label: zone.Label,
        type: zone.type,
        typeLabel: zone.typeLabel,
        tech: zone.tech,
        techLabel: zone.techLabel,
        tamper: zone.Tamper,
        low_battery: zone.LowBattery,
        bypass: zone.Bypass,
      }), { qos: 1, retain: true });
    }
    let zoneStatus = zone.Open ? '1' : '0';
    mqttClient.publish(`${getZoneTopic(zone.Id)}/status`, zoneStatus, {
      qos: 1, retain: false,
    });
    logger.verbose(`[Panel => MQTT] Published zone status ${zoneStatus} on zone ${zone.Label}`);
  }

  function publishZoneBypassStateChange(zone: Zone) {
    mqttClient.publish(`riscopanel/${config.panel_node_id}/zone/${zone.Id}-bypass/status`, zone.Bypass ? '1' : '0', {
      qos: 1, retain: false,
    });
    logger.verbose(`[Panel => MQTT] Published zone bypass status ${zone.Bypass} on zone ${zone.Label}`);
  }

  function activePartitions(partitions: PartitionList): Partition[] {
    return partitions.values.filter(p => p.Exist);
  }

  function activeZones(zones: ZoneList): Zone[] {
    return zones.values.filter(z => !z.NotUsed);
  }

  function publishOnline() {
    mqttClient.publish(getStatusTopic(), 'online', {
      qos: 1, retain: true,
    });
    logger.verbose('[Panel => MQTT] Published alarm online');
  }

  function publishOffline() {
    if (mqttReady) {
      mqttClient.publish(getStatusTopic(), 'offline', {
        qos: 1, retain: true,
      });
      logger.verbose('[Panel => MQTT] Published alarm offline');
    }
  }

  function getDeviceInfo() {
    return {
      manufacturer: 'Risco',
      model: `${panel.riscoComm.panelInfo.PanelModel}/${panel.riscoComm.panelInfo.PanelType}`,
      name: config.panel_name,
      sw_version: panel.riscoComm.panelInfo.PanelFW,
      identifiers: config.panel_node_id,
    };
  }

  function publishHomeAssistantDiscoveryInfo() {
    for (const partition of activePartitions(panel.partitions)) {
      const partitionPayload = {
        name: partition.Label,
        command_topic: `${getPartitionTopic(partition.Id)}/set`,
        state_topic: `${getPartitionTopic(partition.Id)}/status`,
        unique_id: `${config.panel_node_id}-partition_${partition.Id}`,
        availability: {
          topic: getStatusTopic(),
        },
        device: getDeviceInfo(),
      };
      mqttClient.publish(`${config.ha_discovery_prefix_topic}/alarm_control_panel/${config.panel_node_id}/${partitionPayload.unique_id}/config`, JSON.stringify(partitionPayload), {
        qos: 1, retain: true,
      });
      logger.info(`[Panel => MQTT][Discovery] Published alarm_control_panel to HA on partition ${partition.Id}`);
      logger.verbose(`[Panel => MQTT][Discovery] Alarm discovery payload\n${JSON.stringify(partitionPayload, null, 2)}`);
    }

    for (const zone of activeZones(panel.zones)) {

      const zoneConf = cloneDeep(config.zones.default);
      merge(zoneConf, config.zones?.[zone.Label]);

      const zonePayload: any = {
        availability: {
          topic: getStatusTopic(),
        },
        unique_id: `${config.panel_node_id}-zone_${zone.Id}`,
        payload_on: '1',
        payload_off: '0',
        device_class: zoneConf.device_class,
        device: getDeviceInfo(),
        qos: 1,
        state_topic: `${getZoneTopic(zone.Id)}/status`,
        json_attributes_topic: getZoneTopic(zone.Id),
      };

      const bypassZonePayload: any = {
        availability: {
          topic: getStatusTopic(),
        },
        unique_id: `${config.panel_node_id}-zone_${zone.Id}-bypass`,
        payload_on: '1',
        payload_off: '0',
        state_on: '1',
        state_off: '0',
        icon: 'mdi:toggle-switch-off',
        device: getDeviceInfo(),
        qos: 1,
        state_topic: `${getZoneBypassTopic(zone.Id)}/status`,
        command_topic: `${getZoneBypassTopic(zone.Id)}/set`,
      };

      if (zoneConf.off_delay) {
        zonePayload.off_delay = zoneConf.off_delay; // If the service is stopped with any activated zone, it can remain forever on without this config
      }

      const zoneName = zoneConf.name || zone.Label;
      zonePayload.name = zoneConf.name_prefix + zoneName;
      bypassZonePayload.name = zoneConf.name_prefix + zoneName + ' Bypass';

      mqttClient.publish(`${config.ha_discovery_prefix_topic}/binary_sensor/${config.panel_node_id}/${zonePayload.unique_id}/config`, JSON.stringify(zonePayload), {
        qos: 1,
        retain: true,
      });
      mqttClient.publish(`${config.ha_discovery_prefix_topic}/switch/${config.panel_node_id}/${bypassZonePayload.unique_id}/config`, JSON.stringify(bypassZonePayload), {
        qos: 1,
        retain: true,
      });
      logger.info(`[Panel => MQTT][Discovery] Published binary_sensor to HA: Zone label = ${zone.Label}, HA name = ${zonePayload.name}`);
      logger.info(`[Panel => MQTT][Discovery] Published switch to HA: Zone label = ${zone.Label}, HA name = ${bypassZonePayload.name}`);
      logger.verbose(`[Panel => MQTT][Discovery] Sensor discovery payload\n${JSON.stringify(zonePayload, null, 2)}`);
      logger.verbose(`[Panel => MQTT][Discovery] Bypass switch discovery payload\n${JSON.stringify(bypassZonePayload, null, 2)}`);
    }
  }

  function panelOrMqttConnected() {
    if (!panelReady) {
      logger.info(`Panel is not connected, waiting`);
      return;
    }
    if (!mqttReady) {
      logger.info(`MQTT is not connected, waiting`);
      return;
    }
    logger.info(`Panel and MQTT communications are ready`);
    logger.info(`Publishing Home Assistant discovery info`);
    publishHomeAssistantDiscoveryInfo();
    publishOnline();

    logger.info(`Publishing initial partitions and zones state to Home assistant`);
    for (const partition of activePartitions(panel.partitions)) {
      publishPartitionStateChanged(partition);
    }

    for (const zone of activeZones(panel.zones)) {
      publishZoneStateChange(zone, true);
      publishZoneBypassStateChange(zone);
    }

    if (!listenerInstalled) {
      logger.info(`Subscribing to Home assistant commands topics`);
      for (const partition of activePartitions(panel.partitions)) {
        const partitionCommandsTopic = getPartitionTopic(partition.Id) + `/set`;
        logger.info(`Subscribing to ${partitionCommandsTopic} topic`);
        mqttClient.subscribe(partitionCommandsTopic);
      }
      for (const zone of activeZones(panel.zones)) {
        const zoneBypassTopic = getZoneBypassTopic(zone.Id) + `/set`;
        logger.info(`Subscribing to ${zoneBypassTopic} topic`);
        mqttClient.subscribe(zoneBypassTopic);
      }
      logger.info(`Subscribing to panel partitions events`);
      panel.partitions.on('PStatusChanged', (Id, EventStr) => {
        if (['Armed', 'Disarmed', 'HomeStay', 'HomeDisarmed', 'Alarm', 'StandBy'].includes(EventStr)) {
          publishPartitionStateChanged(panel.partitions.byId(Id));
        }
      });
      logger.info(`Subscribing to panel zones events`);
      panel.zones.on('ZStatusChanged', (Id, EventStr) => {
        if (['Closed', 'Open'].includes(EventStr)) {
          publishZoneStateChange(panel.zones.byId(Id), false);
        }
        if (['Bypassed', 'UnBypassed'].includes(EventStr)) {
          publishZoneBypassStateChange(panel.zones.byId(Id));
        }
      });
      logger.info(`Subscribing to Home Assistant online status`);
      mqttClient.subscribe(`${config.ha_discovery_prefix_topic}/status`, { qos: 0 }, function(error, granted) {
        if (error) {
          logger.error(`Error subscribing to ${config.ha_discovery_prefix_topic}/status`);
        } else {
          logger.info(`${granted[0].topic} was subscribed`);
        }
      });
      panel.riscoComm.on('Clock', publishOnline);

      listenerInstalled = true;
    } else {
      logger.info('Listeners already installed, skipping listeners registration');
    }

    logger.info(`Initialization completed`);
  }

}
