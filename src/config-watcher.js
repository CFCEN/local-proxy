'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.resolve(__dirname, '../config.json');

let currentConfig = null;
let watchDebounceTimer = null;

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    currentConfig = parsed;
    console.log('[config] 配置已加载，规则数量:', parsed.rules?.length ?? 0);
    return parsed;
  } catch (err) {
    console.error('[config] 配置解析失败，保留旧配置:', err.message);
    return currentConfig;
  }
}

function getConfig() {
  return currentConfig;
}

function startWatcher() {
  loadConfig();

  fs.watch(CONFIG_PATH, (eventType) => {
    if (eventType !== 'change') return;

    // 防抖：短时间内多次写入只触发一次
    clearTimeout(watchDebounceTimer);
    watchDebounceTimer = setTimeout(() => {
      console.log('[config] 检测到配置文件变更，重新加载...');
      loadConfig();
    }, 200);
  });

  console.log(`[config] 正在监听配置文件: ${CONFIG_PATH}`);
}

module.exports = { startWatcher, getConfig };
