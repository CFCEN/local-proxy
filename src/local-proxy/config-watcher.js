'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.LOCAL_PROXY_CONFIG
  ? path.resolve(process.env.LOCAL_PROXY_CONFIG)
  : path.resolve(__dirname, '../../local-proxy.config.json');
const FALLBACK_CONFIG_PATH = path.resolve(__dirname, '../../local-proxy.config.example.json');

let currentConfig = null;
let watchDebounceTimer = null;
let watchedConfigPath = null;
let watcher = null;

function getReadableConfigPath() {
  if (fs.existsSync(CONFIG_PATH)) {
    return CONFIG_PATH;
  }
  return FALLBACK_CONFIG_PATH;
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(getReadableConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    currentConfig = parsed;
    // console.log('[config] 配置已加载，规则数量:', parsed.rules?.length ?? 0);
    return parsed;
  } catch (err) {
    console.error('[config] 配置解析失败，保留旧配置:', err.message);
    return currentConfig;
  }
}

function getConfig() {
  return currentConfig;
}

function watchConfigFile() {
  const nextConfigPath = getReadableConfigPath();
  if (watchedConfigPath === nextConfigPath) {
    return;
  }

  watcher?.close();
  watchedConfigPath = nextConfigPath;
  watcher = fs.watch(watchedConfigPath, (eventType) => {
    if (eventType !== 'change') return;

    // 防抖：短时间内多次写入只触发一次
    clearTimeout(watchDebounceTimer);
    watchDebounceTimer = setTimeout(() => {
      // console.log('[config] 检测到配置文件变更，重新加载...');
      loadConfig();
      watchConfigFile();
    }, 200);
  });

  // console.log(`[config] 正在监听配置文件: ${watchedConfigPath}`);
}

function startWatcher() {
  loadConfig();
  watchConfigFile();
}

module.exports = { startWatcher, getConfig };
