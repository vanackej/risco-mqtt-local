#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
import {riscoMqttHomeAssistant} from './lib';

try {
    const configPath = path.join(process.cwd(), 'config.json')
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