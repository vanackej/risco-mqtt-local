const mqtt = require('mqtt')
const RiscoTCPPanel = require('risco-lan-bridge');
const RiscoPanel = RiscoTCPPanel.RiscoPanel;

const ALARM_TOPIC = "riscopanel/alarm"
const ALARM_TOPIC_REGEX = /^riscopanel\/alarm\/([0-9])*\/set$/m
const RISCO_NODE_ID = 'risco-alarm-panel'

module.exports = (config, /** @type {RiscoPanel} */ panel) => {
    let {
        "mqtt-url": mqttURL,
        "mqtt-username": mqttUsername,
        "mqtt-password": mqttPassword,
        "home-assistant-discovery-prefix": HASSIO_DISCOVERY_PREFIX_TOPIC = 'homeassistant',
        "zone-label-prefix": zoneLabelPrefix = ''
    } = config

    if (!mqttURL) throw new Error('mqttURL options is required')

    const mqttClient = mqtt.connect(mqttURL, {
            username: mqttUsername,
            password: mqttPassword,
            will: {
                topic: `${ALARM_TOPIC}/status`,
                payload: 'offline',
                qos: 1,
                willDelayInterval: 30,
                retain: true
            }
        }
    )

    const alarmPayload = (/** @type {Partition} */ partition) => {
        if (!partition.Arm && ! partition.HomeStay) {
            return 'disarmed'
        } else {
            if (partition.HomeStay) {
                return 'armed_home'
            } else {
                return 'armed_away'
            }
        }
    }

    const disarm = async partitionId => {
        await panel.DisarmPart(partitionId);
        return Promise.resolve('disarmed')
    }

    const partiallyArm = async partitionId => {
        await panel.ArmPart(partitionId, 1);
        return Promise.resolve('armed_home')
    }

    const arm = async partitionId => {
        await panel.ArmPart(partitionId, 0);
        return Promise.resolve('armed_away')
    }

    const alarmAction = {'DISARM': disarm, 'ARM_HOME': partiallyArm, 'ARM_NIGHT': partiallyArm, 'ARM_AWAY': arm}

    const changeAlarmStatus = async (code, partitionId) => {
        return alarmAction[code].call(this, partitionId)
    }

    const subscribeAlarmStateChange = (partition) => {
        console.log(`subscribe on ${ALARM_TOPIC}/${partition.Id}/set topic`)
        mqttClient.subscribe(`${ALARM_TOPIC}/${partition.Id}/set`)
    }

    const publishPartitionStateChanged = (partition) => {
        mqttClient.publish(`${ALARM_TOPIC}/${partition.Id}/status`, alarmPayload(partition))
        console.log(`published alarm status ${alarmPayload(partition)} on partition ${partition.Id}`)
    }

    const publishSensorsStateChange = (zone) => {
        const partitionId = zone.Parts[0]
        mqttClient.publish(`${ALARM_TOPIC}/${partitionId}/sensor/${zone.Id}`, JSON.stringify({
            label: zone.Label,
            type: zone.Type,
            typeStr: zone.TypeStr,
            tech: zone.ZTech,
            tamper: zone.Tamper
        }))
        mqttClient.publish(`${ALARM_TOPIC}/${partitionId}/sensor/${zone.Id}/status`, zone.Open ? '1' : '0')
    }

    function activePartitions(partitions) {
        return partitions.filter(p => p.Exist)
    }

    function activeZones(zones) {
        return zones.filter(z => z.ZTech !== 'None' && !z.NotUsed && z.Type !== '0')
    }

    const autoDiscovery = () => {
        for (const partition of activePartitions(panel.Partitions)) {
            const payload = {
                'name': `risco-alarm-panel-${partition.Id}`,
                'state_topic': `${ALARM_TOPIC}/${partition.Id}/status`,
                availability: {
                    topic: `${ALARM_TOPIC}/status`
                },
                'command_topic': `${ALARM_TOPIC}/${partition.Id}/set`
            }
            mqttClient.publish(`${HASSIO_DISCOVERY_PREFIX_TOPIC}/alarm_control_panel/${RISCO_NODE_ID}/${partition.Id}/config`, JSON.stringify(payload))
            console.log(`published alarm_control_panel for homeassistant autodiscovery on partition ${partition.Id}`)
        }

        for (const zone of activeZones(panel.Zones)) {
            const partitionId = zone.Parts[0]
            const nodeId = zone.Label.replace(/ /g, '-')
            const payload = {
                'name': `${zoneLabelPrefix}${zone.Label}`,
                availability: {
                    topic: `${ALARM_TOPIC}/status`
                },
                'device_class': 'motion',
                'payload_on': '1',
                'payload_off': '0',
                'state_topic': `${ALARM_TOPIC}/${partitionId}/sensor/${zone.Id}/status`,
                'json_attributes_topic': `${ALARM_TOPIC}/${partitionId}/sensor/${zone.Id}`
            }
            mqttClient.publish(`${HASSIO_DISCOVERY_PREFIX_TOPIC}/binary_sensor/${nodeId}/${zone.Id}/config`, JSON.stringify(payload))
            console.log(`published binary_sensor for homeassistant autodiscovery : ${payload.name}`)
        }
    }

    mqttClient.on('connect', () => {
        console.log(`connected on mqtt server: ${mqttURL}`)

        panel.on('SystemInitComplete', () => {

            autoDiscovery();

            for (const partition of activePartitions(panel.Partitions)) {
                subscribeAlarmStateChange(partition)
            }

            mqttClient.publish(`${ALARM_TOPIC}/status`, 'online', {
                qos: 1,
                retain: true
            });

            for (const partition of activePartitions(panel.Partitions)) {
                publishPartitionStateChanged(partition);
            }

            panel.Partitions.on('PStatusChanged', (Id, EventStr) => {
                if (['Armed', 'Disarmed', 'HomeStay', 'HomeDisarmed'].includes(EventStr)) {
                    publishPartitionStateChanged(panel.Partitions.ById(Id));
                }
            });

            panel.Zones.on('ZStatusChanged', (Id, EventStr) => {
                if (['Closed', 'Open'].includes(EventStr)) {
                    publishSensorsStateChange(panel.Zones.ById(Id))
                }
            });
        })
    })

    mqttClient.on('message', (topic, message) => {
        let m;
        if ((m = ALARM_TOPIC_REGEX.exec(topic)) !== null) {
            m.filter((match, groupIndex) => groupIndex !== 0).forEach((partitionId) => {
                const command = message.toString()
                console.log(`received change state command ${command} on topic ${topic} in partition ${partitionId}`)
                changeAlarmStatus(command, partitionId).then(result => {
                    console.log(`changed state to ${result} on partiton ${partitionId}`)
                }).catch(err => {
                    console.log(`error during state change command ${command} on topic ${topic} in partition ${partitionId}`)
                    console.log(err)
                })
            });
        }
    })
}