#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const riscoMqttHomeAssistant = require('../')

try {
    const configPath = path.join(process.cwd(), 'config.json')
    if (fs.existsSync(configPath)) {
        const config = require(configPath)
        riscoMqttHomeAssistant(config)
    } else {
        console.log('file config.json does not exist')
        process.exit(1)
    }
} catch (e) {
    console.log('file config.json does not in json format')
    process.exit(1)
}