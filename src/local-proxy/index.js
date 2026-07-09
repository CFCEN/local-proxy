'use strict';

const { startWatcher, getConfig } = require('./config-watcher');
const { createProxyServer } = require('./proxy');

// 先加载并监听配置文件
startWatcher();

const config = getConfig();
const port = config.port || 8080;

const server = createProxyServer();

server.listen(port, '127.0.0.1', () => {
  // console.log(`[proxy] 本地代理已启动: http://127.0.0.1:${port}`);
  // console.log('[proxy] 浏览器代理设置: 127.0.0.1:' + port);
  // console.log('[proxy] 快速设置 macOS 系统代理:');
  // console.log(`  networksetup -setwebproxy Wi-Fi 127.0.0.1 ${port}`);
  // console.log(`  networksetup -setsecurewebproxy Wi-Fi 127.0.0.1 ${port}`);
  // console.log('[proxy] 关闭系统代理:');
  // console.log('  networksetup -setwebproxystate Wi-Fi off');
  // console.log('  networksetup -setsecurewebproxystate Wi-Fi off');
});

// 优雅退出
process.on('SIGINT', () => {
  // console.log('\n[proxy] 正在关闭...');
  server.close(() => {
    // console.log('[proxy] 已关闭');
    process.exit(0);
  });
});
