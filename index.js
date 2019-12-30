const mqtt = require('mqtt')
const nodeRiscoClient = require('node-risco-client')

const ALARM_TOPIC = "riscopanel/alarm"
const ALARM_TOPIC_REGEX = /^riscopanel\/alarm\/([0-9])*\/set$/m
const RISCO_NODE_ID = 'risco-alarm-panel'

module.exports = (config) => {
    let {
        username,
        password,
        pin,
        "language-id": languageId,
        "mqtt-url": mqttURL,
        "mqtt-username": mqttUsername,
        "mqtt-password": mqttPassword,
        "home-assistant-discovery-prefix": HASSIO_DISCOVERY_PREFIX_TOPIC = 'homeassistant',
        "interval-polling": INTERVAL_POLLING = 5000
    } = config

    if (!username) throw new Error('username options is required')
    if (!password) throw new Error('password options is required')
    if (!pin) throw new Error('pin options is required')
    if (!languageId) throw new Error('languageId options is required')
    if (!mqttURL) throw new Error('mqttURL options is required')

    const riscoClient = nodeRiscoClient({ username, password, pin, languageId })
    const mqttClient = mqtt.connect(mqttURL, { username: mqttUsername, password: mqttPassword })

    const alarmPayload = { 1: 'disarmed', 2: 'armed_home', 3: 'armed_away' }
    const sensorPayload = { 0: 'idle', 1: 'triggered' }

    const disarm = async partitionId => {
        await riscoClient.disarm();
        mqttClient.publish(`${ALARM_TOPIC}/${partitionId}/status`, 'disarmed')
        return Promise.resolve('disarmed')
    }

    const partiallyArm = async partitionId => {
        await riscoClient.partiallyArm();
        mqttClient.publish(`${ALARM_TOPIC}/${partitionId}/status`, 'armed_home')
        return Promise.resolve('armed_home')
    }

    const arm = async partitionId => {
        await riscoClient.arm();
        mqttClient.publish(`${ALARM_TOPIC}/${partitionId}/status`, 'armed_away')
        return Promise.resolve('armed_home')
    }

    const alarmAction = { 'DISARM': disarm, 'ARM_HOME': partiallyArm, 'ARM_NIGHT': partiallyArm, 'ARM_AWAY': arm }

    const changeAlarmStatus = async (code, partitionId) => {
        return alarmAction[code].call(this, partitionId)
    }

    const subscribeAlarmStateChange = (partitions) => {
        for (const partition of partitions) {
            console.log(`subscribe on ${ALARM_TOPIC}/${partition.id}/set topic`)
            mqttClient.subscribe(`${ALARM_TOPIC}/${partition.id}/set`)
        }
        setInterval(retrieveAlarmStatus, INTERVAL_POLLING);
    }

    const publishAlarmStateChange = (partitions) => {
        for (const partition of partitions) {
            let state = partition.armedState
            mqttClient.publish(`${ALARM_TOPIC}/${partition.id}/status`, alarmPayload[state])
            console.log(`published alarm status ${alarmPayload[state]} on partition ${partition.id}`)
        }
    }

    const publishSensorsStateChange = (zones) => {
        for (const zone of zones) {
            const partitionId = zone.part - 1
            mqttClient.publish(`${ALARM_TOPIC}/${partitionId}/sensor/${zone.zoneID}`, JSON.stringify(zone))
            mqttClient.publish(`${ALARM_TOPIC}/${partitionId}/sensor/${zone.zoneID}/status`, sensorPayload[zone.status])
        }
    }

    const autoDiscovery = (partitions, zones) => {
        for (const partition of partitions) {
            const payload = {
                'name': `risco-alarm-panel-${partition.id}`,
                'state_topic': `${ALARM_TOPIC}/${partition.id}/status`,
                'command_topic': `${ALARM_TOPIC}/${partition.id}/set`
            }
            mqttClient.publish(`${HASSIO_DISCOVERY_PREFIX_TOPIC}/alarm_control_panel/${RISCO_NODE_ID}/${partition.id}/config`, JSON.stringify(payload))
            console.log(`published alarm_control_panel for homeassistant autodiscovery on partition ${partition.id}`)
        }

        for (const zone of zones) {
            const partitionId = zone.part - 1
            const nodeId = zone.zoneName.replace(' ', '-')
            const payload = {
                'name': `${zone.zoneName}`,
                'payload_on': 'triggered',
                'payload_off': 'idle',
                'state_topic': `${ALARM_TOPIC}/${partitionId}/sensor/${zone.zoneID}/status`,
                'json_attributes_topic': `${ALARM_TOPIC}/${partitionId}/sensor/${zone.zoneID}`
            }            
            mqttClient.publish(`${HASSIO_DISCOVERY_PREFIX_TOPIC}/binary_sensor/${nodeId}/${zone.zoneID}/config`, JSON.stringify(payload))
        }
        console.log(`published ${zones.length} binary_sensor for homeassistant autodiscovery`)
    }

    const retrieveAlarmStatus = () => {
        Promise.all([riscoClient.getPartitions(), riscoClient.getZones()]).then(([partitions, zones]) => {
            publishAlarmStateChange(partitions)
            publishSensorsStateChange(zones)
        }).catch(err => {
            console.log(`error during retrieve status fo partitions and zones`)
            console.log(err)
        })
    }

    mqttClient.on('connect', () => {
        console.log(`connected on mqtt server: ${mqttURL}`)
        Promise.all([riscoClient.getPartitions(), riscoClient.getZones()]).then(([partitions, zones]) => {
            subscribeAlarmStateChange(partitions)
            autoDiscovery(partitions, zones)
        }).catch(err => {
            console.log(`error during get partitions and zones on connect`)
            console.log(err)
            process.exit(1)
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