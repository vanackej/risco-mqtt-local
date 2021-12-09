import {IClientOptions} from 'mqtt/types/lib/client';

import * as _ from 'lodash';

const mqtt = require('mqtt')
const {createLogger, format, transports} = require('winston');
const {combine, timestamp, printf} = format;
const RiscoPanel = require('@vanackej/risco-lan-bridge').RiscoPanel;

const ALARM_TOPIC = "riscopanel/alarm"
const ALARM_TOPIC_REGEX = /^riscopanel\/alarm\/([0-9])*\/set$/m
const RISCO_NODE_ID = 'risco-alarm-panel'

type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug';

export interface RiscoMQTTConfig {
    log?: LogLevel
    ha_discovery_prefix_topic?: string
    zones?: {
        default?: ZoneConfig
        [label: string]: ZoneConfig
    }
    panel: {
        Panel_IP?: string
        Panel_Port?: number
        Panel_Password?: number,
        Panel_Id?: number,
        WatchDogInterval?: number,
        logger?: any
    },
    mqtt?: MQTTConfig
}

export interface MQTTConfig extends IClientOptions {
    url: string
}

export interface ZoneConfig {
    off_delay?: number,
    device_class?: string,
    name?: string
    name_prefix?: string
}

const CONFIG_DEFAULTS: RiscoMQTTConfig = {
    log: 'info',
    ha_discovery_prefix_topic: 'homeassistant',
    panel: {
    },
    zones: {
        default: {
            off_delay: 0,
            device_class: 'motion',
            name_prefix: ''
        }
    },
    mqtt: {
        url: null,
        reconnectPeriod: 5000,
        clientId: 'risco-mqtt',
        will: {
            topic: `${ALARM_TOPIC}/status`, payload: 'offline', qos: 1, retain: true, properties: {
                willDelayInterval: 30
            }
        }
    }
}

export function riscoMqttHomeAssistant(userConfig: RiscoMQTTConfig) {

    const config = _.merge(CONFIG_DEFAULTS, userConfig)

    const logger = createLogger({
        format: combine(
            timestamp({
                format: () => new Date().toLocaleString()
            }),
            printf(({level, message, label, timestamp}) => {
                return `${timestamp} [${level}] ${message}`;
            })
        ),
        level: config.log || 'info',
        transports: [
            new transports.Console()
        ]
    });

    logger.debug(`User config:\n${JSON.stringify(userConfig, null, 2)}`)
    logger.debug(`Merged config:\n${JSON.stringify(config, null, 2)}`)

    config.panel.logger = (log_channel, log_lvl, log_data) => {
        logger.log({
            level: log_lvl,
            message: log_data
        })
    };

    let panelReady = false;

    if (!config.mqtt?.url) throw new Error('mqtt url options is required')

    const panel = new RiscoPanel(config.panel);

    panel.on('SystemInitComplete', () => {
        panelReady = true
        logger.info(`Subscribing to panel partitions and zones events`)
        panel.Partitions.on('PStatusChanged', (Id, EventStr) => {
            if (['Armed', 'Disarmed', 'HomeStay', 'HomeDisarmed', 'Alarm', 'StandBy'].includes(EventStr)) {
                publishPartitionStateChanged(panel.Partitions.ById(Id));
            }
        });

        panel.Zones.on('ZStatusChanged', (Id, EventStr) => {
            if (['Closed', 'Open'].includes(EventStr)) {
                publishSensorsStateChange(panel.Zones.ById(Id))
            }
        });

        panel.RiscoComm.on('Clock', () => {
            publishOnline()
        })
    })

    logger.info(`Connecting to mqtt server: ${config.mqtt.url}`)
    const mqttClient = mqtt.connect(config.mqtt.url, config.mqtt)

    async function changeAlarmStatus(code, partitionId) {
        switch (code) {
            case 'DISARM':
                return await panel.DisarmPart(partitionId);
            case 'ARM_HOME':
            case 'ARM_NIGHT':
                return await panel.ArmPart(partitionId, 1);
            case 'ARM_AWAY':
                return await panel.ArmPart(partitionId, 0);
        }
    }

    function subscribeAlarmStateChange(partition) {
        logger.info(`Subscribe on ${ALARM_TOPIC}/${partition.Id}/set topic`)
        mqttClient.subscribe(`${ALARM_TOPIC}/${partition.Id}/set`)
    }

    function alarmPayload(partition) {
        if (partition.Alarm) {
            return 'triggered'
        } else if (!partition.Arm && !partition.HomeStay) {
            return 'disarmed'
        } else {
            if (partition.HomeStay) {
                return 'armed_home'
            } else {
                return 'armed_away'
            }
        }
    }

    function publishPartitionStateChanged(partition) {
        mqttClient.publish(`${ALARM_TOPIC}/${partition.Id}/status`, alarmPayload(partition), {qos: 1, retain: true})
        logger.info(`[Panel => MQTT] Published alarm status ${alarmPayload(partition)} on partition ${partition.Id}`)
    }

    function publishSensorsStateChange(zone) {
        const partitionId = zone.Parts[0]
        mqttClient.publish(`${ALARM_TOPIC}/${partitionId}/sensor/${zone.Id}`, JSON.stringify({
            label: zone.Label, type: zone.Type, typeStr: zone.TypeStr, tech: zone.ZTech, tamper: zone.Tamper
        }), {qos: 1, retain: true})
        let zoneStatus = zone.Open ? '1' : '0';
        mqttClient.publish(`${ALARM_TOPIC}/${partitionId}/sensor/${zone.Id}/status`, zoneStatus)
        logger.info(`[Panel => MQTT] Published sensor status ${zoneStatus} on zone ${zone.Label}`)
    }

    function activePartitions(partitions) {
        return partitions.filter(p => p.Exist)
    }

    function activeZones(zones) {
        return zones.filter(z => z.ZTech !== 'None' && !z.NotUsed && z.Type !== '0')
    }

    function publishOnline() {
        mqttClient.publish(`${ALARM_TOPIC}/status`, 'online', {
            qos: 1, retain: true
        });
        logger.debug("[Panel => MQTT] Published alarm online")
    }

    function publishHomeAssistantDiscoveryInfo() {
        for (const partition of activePartitions(panel.Partitions)) {
            const payload = {
                'name': `risco-alarm-panel-${partition.Id}`,
                'state_topic': `${ALARM_TOPIC}/${partition.Id}/status`,
                unique_id: `risco-alarm-panel-${partition.Id}`,
                availability: {
                    topic: `${ALARM_TOPIC}/status`
                },
                'command_topic': `${ALARM_TOPIC}/${partition.Id}/set`
            }
            mqttClient.publish(`${config.ha_discovery_prefix_topic}/alarm_control_panel/${RISCO_NODE_ID}/${partition.Id}/config`, JSON.stringify(payload), {
                qos: 1, retain: true
            })
            logger.info(`[Panel => MQTT][Discovery] Published alarm_control_panel to HA on partition ${partition.Id}`)
            logger.debug(`[Panel => MQTT][Discovery] Alarm discovery payload\n${JSON.stringify(payload, null, 2)}`)
        }

        for (const zone of activeZones(panel.Zones)) {
            const partitionId = zone.Parts[0]
            const nodeId = zone.Label.replace(/ /g, '-')

            const zoneConf = _.merge(config.zones.default, config.zones?.[zone.Label]);

            const payload: any = {
                availability: {
                    topic: `${ALARM_TOPIC}/status`
                },
                unique_id: `risco-alarm-panel-${partitionId}-zone-${zone.Id}`,
                payload_on: '1',
                payload_off: '0',
                device_class: zoneConf.device_class,
                qos: 1,
                state_topic: `${ALARM_TOPIC}/${partitionId}/sensor/${zone.Id}/status`,
                json_attributes_topic: `${ALARM_TOPIC}/${partitionId}/sensor/${zone.Id}`
            }

            if (zoneConf.off_delay) {
                payload.off_delay = zoneConf.off_delay // If the service is stopped with any activated zone, it can remain forever on without this config
            }

            const zoneName = zoneConf.name || zone.Label;
            payload.name = zoneConf.name_prefix + zoneName

            mqttClient.publish(`${config.ha_discovery_prefix_topic}/binary_sensor/${nodeId}/${zone.Id}/config`, JSON.stringify(payload), {
                 qos: 1,
                 retain: true
            });
            logger.info(`[Panel => MQTT][Discovery] Published binary_sensor to HA: Zone label = ${zone.Label}, HA name = ${payload.name}`)
            logger.debug(`[Panel => MQTT][Discovery] Sensor discovery payload\n${JSON.stringify(payload, null, 2)}`)
        }
    }

    function allReady() {
        logger.info(`Panel and MQTT communications are ready`)
        logger.info(`Publishing Home Assistant discovery info`)
        publishHomeAssistantDiscoveryInfo();

        logger.info(`Subscribing to Home assistant commands topics`)
        for (const partition of activePartitions(panel.Partitions)) {
            subscribeAlarmStateChange(partition)
        }
        publishOnline();

        logger.info(`Publishing initial partitions and zones state to Home assistant`)
        for (const partition of activePartitions(panel.Partitions)) {
            publishPartitionStateChanged(partition);
        }

        for (const zone of activeZones(panel.Zones)) {
            publishSensorsStateChange(zone);
        }

        logger.info(`Initialization completed`)
    }

    mqttClient.on('connect', () => {
        logger.info(`Connected on mqtt server: ${config.mqtt.url}`)
        if (panelReady) {
            allReady()
        } else {
            panel.on('SystemInitComplete', () => {
                allReady()
            })
        }
    })

    mqttClient.on('error', (error) => {
        logger.error(`MQTT connection error: ${error}`)
    })

    mqttClient.on('message', (topic, message) => {
        let m;
        if ((m = ALARM_TOPIC_REGEX.exec(topic)) !== null) {
            m.filter((match, groupIndex) => groupIndex !== 0).forEach(async (partitionId) => {
                const command = message.toString()
                logger.info(`[MQTT => Panel] Received change state command ${command} on topic ${topic} in partition ${partitionId}`)
                try {
                    const success = await changeAlarmStatus(command, partitionId)
                    if (success) {
                        logger.info(`[MQTT => Panel] ${command} command sent on partition ${partitionId}`)
                    } else {
                        logger.error(`[MQTT => Panel] Failed to send ${command} command on partition ${partitionId}`)
                    }
                } catch (err) {
                    logger.error(`[MQTT => Panel] Error during state change command ${command} from topic ${topic} on partition ${partitionId}`)
                    logger.error(err)
                }
            });
        }
    })
}