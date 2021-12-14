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
        console.log('file config.json does not exist')
        process.exit(1)
    }
} catch (e) {
    console.log('E config.json is not in json format')
    process.exit(1)
}