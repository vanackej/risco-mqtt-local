const mqtt = require('mqtt')
const {Log_Level} = require("@vanackej/risco-lan-bridge/lib/constants");
const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf } = format;
const RiscoPanel = require('@vanackej/risco-lan-bridge').RiscoPanel;

const ALARM_TOPIC = "riscopanel/alarm"
const ALARM_TOPIC_REGEX = /^riscopanel\/alarm\/([0-9])*\/set$/m
const RISCO_NODE_ID = 'risco-alarm-panel'

module.exports = (config) => {

    let panelReady = false;

    const logLevel = config.log || Log_Level.INFO;

    const winstonLogger = createLogger({
        format: combine(
            timestamp({
                format: () => new Date().toLocaleString()
            }),
            printf(({ level, message, label, timestamp }) => {
                return `${timestamp} [${level}] ${message}`;
            })
        ),
        level: logLevel,
        transports: [
            new transports.Console()
        ]
    });

    config.panel.logger = (log_channel, log_lvl, log_data) => {
        winstonLogger.log({
            level: log_lvl,
            message: log_data
        })
    };

    let {
        "url": mqttURL,
        "username": mqttUsername,
        "password": mqttPassword,
        "reconnectPeriod": reconnectPeriod = 5000,
        "home-assistant-discovery-prefix": HASSIO_DISCOVERY_PREFIX_TOPIC = 'homeassistant',
        "zone-label-prefix": zoneLabelPrefix = ''
    } = config.mqtt

    if (!mqttURL) throw new Error('mqttURL options is required')

    const panel = new RiscoPanel(config.panel);

    panel.on('SystemInitComplete', () => {
        panelReady = true
        winstonLogger.info(`Subscribing to panel partitions and zones events`)
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

        panel.RiscoComm.on('Clock', (data) => {
            publishOnline()
        })
    })

    winstonLogger.info(`Connecting to mqtt server: ${mqttURL}`)
    const mqttClient = mqtt.connect(mqttURL, {
        reconnectPeriod: reconnectPeriod,
        username: mqttUsername,
        password: mqttPassword,
        clientId: 'risco-mqtt',
        will: {
            topic: `${ALARM_TOPIC}/status`, payload: 'offline', qos: 1, retain: true, properties: {
                willDelayInterval: 30
            }
        }
    })

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
        winstonLogger.info(`Subscribe on ${ALARM_TOPIC}/${partition.Id}/set topic`)
        mqttClient.subscribe(`${ALARM_TOPIC}/${partition.Id}/set`)
    }

    function alarmPayload(/** @type {Partition} */ partition) {
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
        mqttClient.publish(`${ALARM_TOPIC}/${partition.Id}/status`, alarmPayload(partition), { qos: 1, retain: true})
        winstonLogger.info(`[Panel => MQTT] Published alarm status ${alarmPayload(partition)} on partition ${partition.Id}`)
    }

    function publishSensorsStateChange(zone) {
        const partitionId = zone.Parts[0]
        mqttClient.publish(`${ALARM_TOPIC}/${partitionId}/sensor/${zone.Id}`, JSON.stringify({
            label: zone.Label, type: zone.Type, typeStr: zone.TypeStr, tech: zone.ZTech, tamper: zone.Tamper
        }), { qos: 1, retain: true})
        let zoneStatus = zone.Open ? '1' : '0';
        mqttClient.publish(`${ALARM_TOPIC}/${partitionId}/sensor/${zone.Id}/status`, zoneStatus)
        winstonLogger.info(`[Panel => MQTT] Published sensor status ${zoneStatus} on zone ${zone.Label}`)
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
        winstonLogger.debug("[Panel => MQTT] Published alarm online")
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
            mqttClient.publish(`${HASSIO_DISCOVERY_PREFIX_TOPIC}/alarm_control_panel/${RISCO_NODE_ID}/${partition.Id}/config`, JSON.stringify(payload), {
                qos: 1, retain: true
            })
            winstonLogger.info(`[Panel => MQTT] Published alarm_control_panel for homeassistant autodiscovery on partition ${partition.Id}`)
        }

        for (const zone of activeZones(panel.Zones)) {
            const partitionId = zone.Parts[0]
            const nodeId = zone.Label.replace(/ /g, '-')
            const payload = {
                'name': `${zoneLabelPrefix}${zone.Label}`,
                availability: {
                    topic: `${ALARM_TOPIC}/status`
                },
                unique_id: `risco-alarm-panel-${partitionId}-zone-${zone.Id}`,
                'device_class': 'motion',
                'payload_on': '1',
                'payload_off': '0',
                off_delay: 30, // If the service is stopped with any activated zone, it can remain forever on without this config
                qos: 1,
                'state_topic': `${ALARM_TOPIC}/${partitionId}/sensor/${zone.Id}/status`,
                'json_attributes_topic': `${ALARM_TOPIC}/${partitionId}/sensor/${zone.Id}`
            }
            mqttClient.publish(`${HASSIO_DISCOVERY_PREFIX_TOPIC}/binary_sensor/${nodeId}/${zone.Id}/config`, JSON.stringify(payload), {
                qos: 1,
                retain: true
            })
            winstonLogger.info(`[Panel => MQTT] Published binary_sensor for homeassistant autodiscovery : ${payload.name}`)
        }
    }

    function allReady() {
        winstonLogger.info(`Panel and MQTT communications are ready`)
        winstonLogger.info(`Publishing Home Assistant discovery info`)
        publishHomeAssistantDiscoveryInfo();

        winstonLogger.info(`Subscribing to Home assistant commands topics`)
        for (const partition of activePartitions(panel.Partitions)) {
            subscribeAlarmStateChange(partition)
        }
        publishOnline();

        winstonLogger.info(`Publishing initial partitions and zones state to Home assistant`)
        for (const partition of activePartitions(panel.Partitions)) {
            publishPartitionStateChanged(partition);
        }

        for (const zone of activeZones(panel.Zones)) {
            publishSensorsStateChange(zone);
        }

        winstonLogger.info(`Initialization completed`)
    }

    mqttClient.on('connect', () => {
        winstonLogger.info(`Connected on mqtt server: ${mqttURL}`)
        if (panelReady) {
            allReady()
        } else {
            panel.on('SystemInitComplete', () => {
                allReady()
            })
        }
    })

    mqttClient.on('error', (error) => {
        winstonLogger.error(`MQTT connection error: ${error}`)
    })

    mqttClient.on('message', (topic, message) => {
        let m;
        if ((m = ALARM_TOPIC_REGEX.exec(topic)) !== null) {
            m.filter((match, groupIndex) => groupIndex !== 0).forEach(async (partitionId) => {
                const command = message.toString()
                winstonLogger.info(`[MQTT => Panel] Received change state command ${command} on topic ${topic} in partition ${partitionId}`)
                try {
                    const success = await changeAlarmStatus(command, partitionId)
                    if (success) {
                        winstonLogger.info(`[MQTT => Panel] ${command} command sent on partition ${partitionId}`)
                    } else {
                        winstonLogger.error(`[MQTT => Panel] Failed to send ${command} command on partition ${partitionId}`)
                    }
                } catch (err) {
                    winstonLogger.error(`[MQTT => Panel] Error during state change command ${command} from topic ${topic} on partition ${partitionId}`)
                    winstonLogger.error(err)
                }
            });
        }
    })
}