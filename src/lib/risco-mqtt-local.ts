import { IClientOptions } from 'mqtt/types/lib/client';

import merge from 'lodash/merge';
import mqtt from 'mqtt';
import {
  RiscoPanel,
  RiscoLogger,
  Partition,
  PartitionList,
  Output,
  OutputList,
  Zone,
  ZoneList,
  PanelOptions,
} from '@vanackej/risco-lan-bridge/dist';
import pkg from 'winston';
import { cloneDeep } from 'lodash';

const { createLogger, format, transports } = pkg;
const { combine, timestamp, printf, colorize } = format;

const ALARM_TOPIC_REGEX = /^\w+\/alarm\/partitiion\/([0-9]+)\/set$/m;
const ZONE_BYPASS_TOPIC_REGEX = /^\w+\/alarm\/zone\/([0-9]+)-bypass\/set$/m;
const OUTPUT_TOPIC_REGEX = /^\w+\/alarm\/output\/([0-9]+)\/trigger$/m;

type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug';

export interface RiscoMQTTConfig {
  log?: LogLevel,
  logColorize?: boolean,
  ha_discovery_prefix_topic?: string,
  ha_discovery_include_nodeId?: boolean,
  risco_node_id?: string,
  partitions?: {
    default?: PartitionConfig
    [label: string]: PartitionConfig
  },
  zones?: {
    default?: ZoneConfig
    [label: string]: ZoneConfig
  },
  user_outputs?: {
    default?: OutputUserConfig
    [label: string]: OutputUserConfig
  }
  private_outputs?: {
    default?: OutputPrivateConfig
    [label: string]: OutputPrivateConfig
  }
  panel: PanelOptions,
  mqtt?: MQTTConfig
}

export interface MQTTConfig extends IClientOptions {
  url: string
}

export interface PartitionConfig {
  name?: string
  name_prefix?: string
}

export interface ZoneConfig {
  off_delay?: number,
  device_class?: string,
  name?: string
  name_prefix?: string
}

export interface OutputUserConfig {
  device_class?: string,
  name?: string
  name_prefix?: string
}

export interface OutputPrivateConfig {
  device_class?: string,
  name?: string
  name_prefix?: string
}

const CONFIG_DEFAULTS: RiscoMQTTConfig = {
  log: 'info',
  logColorize: false,
  ha_discovery_prefix_topic: 'homeassistant',
  ha_discovery_include_nodeId: false,
  risco_node_id: 'risco-alarm-panel',
  panel: {},
  partitions: {
    default: {
      name_prefix: 'risco alarm panel',
    },
  },
  zones: {
    default: {
      off_delay: 0,
      device_class: 'motion',
      name_prefix: '',
    },
  },
  user_outputs: {
    default: {
      device_class: 'switch',
      name_prefix: '',
    },
  },
  private_outputs: {
    default: {
      device_class: '',
      name_prefix: '',
    },
  },
  mqtt: {
    url: null,
    username: null,
    password: null,
    reconnectPeriod: 5000,
    clientId: 'risco-mqtt-' + Math.random().toString(16).substring(2, 8),
    will: {
      topic: null, payload: 'offline', qos: 1, retain: true, properties: {
        willDelayInterval: 30,
      }
    }
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
  const mqtt_options = {
    clientId: `${config.mqtt.clientId}`,
    reconnectPeriod: config.mqtt.reconnectPeriod,
    username: `${config.mqtt.username}`,
    password: `${config.mqtt.password}`,
    will: {
      topic: `${config.risco_node_id}/alarm/status`,
    }
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
    } else if ((m = OUTPUT_TOPIC_REGEX.exec(topic)) !== null) {
      m.filter((match, groupIndex) => groupIndex !== 0).forEach(async (outputId) => {
        const outputcommand = message.toString();
        logger.info(`[MQTT => Panel] Received output trigger command on topic ${topic} for output ${outputId}`);
        try {
          if (outputcommand !== panel.outputs.byId(outputId).Status) {
            const success = await panel.toggleOutput(outputId);
            if (success) {
              logger.info(`[MQTT => Panel] toggle output command sent on output ${outputId}`);
            } else {
              logger.error(`[MQTT => Panel] Failed to send toggle output command on zone ${outputId}`);
          }
        } else {
          logger.info('[MQTT => Panel] Output is already on the desired output state');
        }
        } catch (err) {
          logger.error(`[MQTT => Panel] Error during output toggle command from topic ${topic} on output ${outputId}`);
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
        return await panel.armHome(partitionId);
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

  function outputState(EventStr: string) {
    if (EventStr === 'Activated') {
      return '1';
    } else if (EventStr === 'Pulsed') {
      return '1';
    } else {
      return '0';
    }
  }

  function publishPartitionStateChanged(partition: Partition) {
    mqttClient.publish(`${config.risco_node_id}/alarm/partition/${partition.Id}/status`, alarmPayload(partition), { qos: 1, retain: true });
    logger.info(`[Panel => MQTT] Published alarm status ${alarmPayload(partition)} on partition ${partition.Id}`);
  }

  function publishZoneStateChange(zone: Zone, publishAttributes: boolean) {
    if (publishAttributes) {
      mqttClient.publish(`${config.risco_node_id}/alarm/zone/${zone.Id}`, JSON.stringify({
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
    mqttClient.publish(`${config.risco_node_id}/alarm/zone/${zone.Id}/status`, zoneStatus, {
      qos: 1, retain: false,
    });
    logger.verbose(`[Panel => MQTT] Published zone status ${zoneStatus} on zone ${zone.Label}`);
  }
  function publishOutputStateChange(output: Output, EventStr: string) {
    const outputStatus = outputState(EventStr)
    const outputId = output.Id
    mqttClient.publish(`${config.risco_node_id}/alarm/output/${output.Id}/status`, outputStatus, {
      qos: 1, retain: false,
    });
    logger.verbose(`[Panel => MQTT] Published output status ${EventStr} on output ${output.Label}`);
  }

  function publishZoneBypassStateChange(zone: Zone) {
    mqttClient.publish(`${config.risco_node_id}/alarm/zone/${zone.Id}-bypass/status`, zone.Bypass ? '1' : '0', {
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
  function activeOutputs(outputs: OutputList): Output[] {
    return outputs.values.filter(o => o.UserUsable !== false);
  }
  function activePrivateOutputs(privateoutputs: OutputList): Output[] {
    return privateoutputs.values.filter(o => o.UserUsable === false && o.Label !=='' && (o.Type === 1 || o.Type === 3));
  }

  function publishOnline() {
    mqttClient.publish(`${config.risco_node_id}/alarm/status`, 'online', {
      qos: 1, retain: true,
    });
    logger.verbose('[Panel => MQTT] Published alarm online');
  }

  function publishOffline() {
    if (mqttReady) {
      mqttClient.publish(`${config.risco_node_id}/alarm/status`, 'offline', {
        qos: 1, retain: true,
      });
      logger.verbose('[Panel => MQTT] Published alarm offline');
    }
  }

  function getDeviceInfo() {
    return {
      manufacturer: 'Risco',
      model: `${panel.riscoComm.panelInfo.PanelModel}/${panel.riscoComm.panelInfo.PanelType}`,
      name: panel.riscoComm.panelInfo.PanelModel,
      sw_version: panel.riscoComm.panelInfo.PanelFW,
      identifiers: `${config.risco_node_id}`,
    };
  }

  function publishHomeAssistantDiscoveryInfo() {
    for (const partition of activePartitions(panel.partitions)) {

      const partitionConf = cloneDeep(config.partitions.default);
      merge(partitionConf, config.partitions?.[partition.Label]);

      const payload = {
        name: partition.Label,
        object_id: `${config.risco_node_id}-${partition.Id}`,
        state_topic: `${config.risco_node_id}/alarm/partition/${partition.Id}/status`,
        unique_id: `${config.risco_node_id}-partition-${partition.Id}`,
        availability: {
          topic: `${config.risco_node_id}/alarm/status`,
        },
        device: getDeviceInfo(),
        command_topic: `${config.risco_node_id}/alarm/partition/${partition.Id}/set`,
      };

      const partitionName = partitionConf.name || partition.Label;
      payload.name = partitionConf.name_prefix + partitionName;

      let partitionIdSegment: string;
      if (config.ha_discovery_include_nodeId) {
        partitionIdSegment = `${partition.Label.replace(/ /g, '-')}/${partition.Id}`;
      } else {
        partitionIdSegment = `${partition.Id}`;
      }

      mqttClient.publish(`${config.ha_discovery_prefix_topic}/alarm_control_panel/${config.risco_node_id}/${partitionIdSegment}/config`, JSON.stringify(payload), {
        qos: 1, retain: true,
      });
      logger.info(`[Panel => MQTT][Discovery] Published alarm_control_panel to HA on partition ${partition.Id}`);
      logger.verbose(`[Panel => MQTT][Discovery] Alarm discovery payload\n${JSON.stringify(payload, null, 2)}`);
    }

    for (const output of activeOutputs(panel.outputs)) {

      const useroutputConf = cloneDeep(config.user_outputs.default);
      merge(useroutputConf, config.user_outputs?.[output.Label]);

      const payload = {
        name: output.Label,
        unique_id: `${config.risco_node_id}-output-${output.Id}`,
        availability: {
          topic: `${config.risco_node_id}/alarm/status`,
        },
        payload_on: '1',
        payload_off: '0',
        state_on: '1',
        state_off: '0',
        device_class: useroutputConf.device_class,
        icon: 'mdi:toggle-switch-off',
        device: getDeviceInfo(),
        qos: 1,
        state_topic: `${config.risco_node_id}/alarm/output/${output.Id}/status`,
        command_topic: `${config.risco_node_id}/alarm/output/${output.Id}/trigger`,
      };

      const useroutputName = useroutputConf.name || output.Label;
      payload.name = useroutputConf.name_prefix + useroutputName;

      let useroutputIdSegment: string;
      if (config.ha_discovery_include_nodeId) {
        useroutputIdSegment = `${output.Label.replace(/ /g, '-')}/${output.Id}`;
      } else {
        useroutputIdSegment = `${output.Id}`;
      }

      mqttClient.publish(`${config.ha_discovery_prefix_topic}/switch/${config.risco_node_id}/${useroutputIdSegment}-output/config`, JSON.stringify(payload), {
        qos: 1, retain: true,
      });
      logger.info(`[Panel => MQTT][Discovery] Published switch to HA on output ${output.Id}`);
      logger.verbose(`[Panel => MQTT][Discovery] Output discovery payload\n${JSON.stringify(payload, null, 2)}`);
    }
    for (const privateoutput of activePrivateOutputs(panel.outputs)) {

      const privateoutputConf = cloneDeep(config.private_outputs.default);
      merge(privateoutputConf, config.private_outputs?.[privateoutput.Label]);

      const payload = {
        name: privateoutput.Label,
        unique_id: `${config.risco_node_id}-privateoutput-${privateoutput.Id}`,
        availability: {
          topic: `${config.risco_node_id}/alarm/status`,
        },
        payload_on: '1',
        payload_off: '0',
        device_class: privateoutputConf.device_class,
        device: getDeviceInfo(),
        qos: 1,
        state_topic: `${config.risco_node_id}/alarm/output/${privateoutput.Id}/status`,
      };

      const outputName = privateoutputConf.name || privateoutput.Label;
      payload.name = privateoutputConf.name_prefix + outputName;

      let privateoutputIdSegment: string;
      if (config.ha_discovery_include_nodeId) {
        privateoutputIdSegment = `${privateoutput.Label.replace(/ /g, '-')}/${privateoutput.Id}`;
      } else {
        privateoutputIdSegment = `${privateoutput.Id}`;
      }
      
      mqttClient.publish(`${config.ha_discovery_prefix_topic}/binary_sensor/${privateoutputIdSegment}-output/config`, JSON.stringify(payload), {
        qos: 1, retain: true,
      });
      logger.info(`[Panel => MQTT][Discovery] Published binary_sensor to HA on output ${privateoutput.Id}`);
      logger.verbose(`[Panel => MQTT][Discovery] Output discovery payload\n${JSON.stringify(payload, null, 2)}`);
    }

    for (const zone of activeZones(panel.zones)) {

      const zoneConf = cloneDeep(config.zones.default);
      merge(zoneConf, config.zones?.[zone.Label]);

      const payload: any = {
        availability: {
          topic: `${config.risco_node_id}/alarm/status`,
        },
        unique_id: `${config.risco_node_id}-zone-${zone.Id}`,
        payload_on: '1',
        payload_off: '0',
        device_class: zoneConf.device_class,
        device: getDeviceInfo(),
        qos: 1,
        state_topic: `${config.risco_node_id}/alarm/zone/${zone.Id}/status`,
        json_attributes_topic: `${config.risco_node_id}/alarm/zone/${zone.Id}`,
      };

      const bypassZonePayload: any = {
        availability: {
          topic: `${config.risco_node_id}/alarm/status`,
        },
        unique_id: `${config.risco_node_id}-zone-${zone.Id}-bypass`,
        payload_on: '1',
        payload_off: '0',
        state_on: '1',
        state_off: '0',
        icon: 'mdi:toggle-switch-off',
        device: getDeviceInfo(),
        qos: 1,
        state_topic: `${config.risco_node_id}/alarm/zone/${zone.Id}-bypass/status`,
        command_topic: `${config.risco_node_id}/alarm/zone/${zone.Id}-bypass/set`,
      };

      if (zoneConf.off_delay) {
        payload.off_delay = zoneConf.off_delay; // If the service is stopped with any activated zone, it can remain forever on without this config
      }

      const zoneName = zoneConf.name || zone.Label;
      payload.name = zoneConf.name_prefix + zoneName;
      bypassZonePayload.name = zoneConf.name_prefix + zoneName + ' Bypass';

      let nodeIdSegment: string;
      if (config.ha_discovery_include_nodeId) {
        nodeIdSegment = `${zone.Label.replace(/ /g, '-')}/${zone.Id}`;
      } else {
        nodeIdSegment = `${zone.Id}`;
      }

      mqttClient.publish(`${config.ha_discovery_prefix_topic}/binary_sensor/${nodeIdSegment}/config`, JSON.stringify(payload), {
        qos: 1,
        retain: true,
      });
      mqttClient.publish(`${config.ha_discovery_prefix_topic}/switch/${nodeIdSegment}-bypass/config`, JSON.stringify(bypassZonePayload), {
        qos: 1,
        retain: true,
      });
      logger.info(`[Panel => MQTT][Discovery] Published binary_sensor to HA: Zone label = ${zone.Label}, HA name = ${payload.name}`);
      logger.info(`[Panel => MQTT][Discovery] Published switch to HA: Zone label = ${zone.Label}, HA name = ${bypassZonePayload.name}`);
      logger.verbose(`[Panel => MQTT][Discovery] Sensor discovery payload\n${JSON.stringify(payload, null, 2)}`);
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
    logger.info(`Publishing initial output states to Home assistant`);
    for (const output of activeOutputs(panel.outputs)) {
      publishOutputStateChange(output, '0');
    }
    for (const privateoutput of activePrivateOutputs(panel.outputs)) {
      publishOutputStateChange(privateoutput, '0');
    }

    if (!listenerInstalled) {
      logger.info(`Subscribing to Home assistant commands topics`);
      for (const partition of activePartitions(panel.partitions)) {
        const partitionCommandsTopic = `${config.risco_node_id}/alarm/partition/${partition.Id}/set`;
        logger.info(`Subscribing to ${partitionCommandsTopic} topic`);
        mqttClient.subscribe(partitionCommandsTopic);
      }
      for (const zone of activeZones(panel.zones)) {
        const zoneBypassTopic = `${config.risco_node_id}/alarm/zone/${zone.Id}-bypass/set`;
        logger.info(`Subscribing to ${zoneBypassTopic} topic`);
        mqttClient.subscribe(zoneBypassTopic);
      }
      for (const output of activeOutputs(panel.outputs)) {
        const outputTopic = `${config.risco_node_id}/alarm/output/${output.Id}/trigger`;
        logger.info(`Subscribing to ${outputTopic} topic`);
        mqttClient.subscribe(outputTopic);
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
          publishZoneStateChange(panel.zones.byId(Id), true);
        }
        if (['LowBattery', 'BatteryOK'].includes(EventStr)) {
          publishZoneStateChange(panel.zones.byId(Id), true);
        }
      });
      logger.info(`Subscribing to panel outputs events`);
      panel.outputs.on('OStatusChanged', (Id, EventStr) => {
        if (['Pulsed', 'Activated', 'Deactivated'].includes(EventStr)) {
          publishOutputStateChange(panel.outputs.byId(Id), EventStr);
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
