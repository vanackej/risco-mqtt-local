#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
import {riscoMqttHomeAssistant} from './lib';

try {
    let configPath = ""
    if ("RISCO_MQTT_HA_CONFIG_FILE" in process.env) {
        // if this var is set, we know we are running in the addon
        configPath = process.env.RISCO_MQTT_HA_CONFIG_FILE
        // check if is file
        const sampleConfigPath = path.join(__dirname, "../config-sample.json")
        if (!fs.existsSync(configPath) && fs.existsSync(sampleConfigPath)) {
            fs.copyFileSync(sampleConfigPath, configPath);
        }
    } else {
        configPath = path.join(process.cwd(), 'config.json')
    }
    console.log('Loading config from: ' + configPath)
    if (fs.existsSync(configPath)) {
        const config = require(configPath)
        riscoMqttHomeAssistant(config)
    } else {
        console.log(`file ${configPath} does not exist`)
        process.exit(1)
    }
} catch (e) {
    console.error('Startup error', e)
    process.exit(1)
}