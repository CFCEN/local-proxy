'use strict';

const http = require('http');
const net = require('net');
const { findRule } = require('./router');
const { createTunnel, forwardHttpRequest, pipe, connectDirect } = require('./forwarder');
const { getConfig } = require('./config-watcher');

function parseHostPort(hostStr, defaultPort) {
  const lastColon = hostStr.lastIndexOf(':');
  if (lastColon === -1) {
    return { host: hostStr, port: defaultPort };
  }
  const port = parseInt(hostStr.slice(lastColon + 1), 10);
  if (isNaN(port)) {
    return { host: hostStr, port: defaultPort };
  }
  return { host: hostStr.slice(0, lastColon), port };
}

function sendError(socket, statusCode, message) {
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${message}\r\nContent-Length: 0\r\nProxy-Connection: close\r\n\r\n`
    );
  } catch (_) {}
  socket.destroy();
}

/**
 * 处理 HTTPS CONNECT 隧道请求
 */
async function handleConnect(req, clientSocket, head) {
  const { host, port } = parseHostPort(req.url, 443);
  const config = getConfig();
  const rule = findRule(host, config.rules || []);
  const upstream = rule ? rule.upstream : null;
  const isDirect = !rule && config.defaultAction === 'direct';

  console.log(
    `[CONNECT] ${host}:${port} -> ${upstream ? `上游 ${upstream.type} ${upstream.host}:${upstream.port}` : '直连'}`
  );

  try {
    let remoteSocket;

    if (upstream) {
      // 将浏览器原始 CONNECT 请求头转发给上游代理
      remoteSocket = await createTunnel(upstream, host, port, req.rawHeaders);
    } else if (isDirect) {
      remoteSocket = await createTunnel(null, host, port, null);
    } else {
      sendError(clientSocket, 403, 'Forbidden');
      return;
    }

    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Connection: keep-alive\r\n\r\n');

    if (head && head.length > 0) {
      remoteSocket.write(head);
    }

    pipe(clientSocket, remoteSocket);
  } catch (err) {
    console.error(`[CONNECT] 连接失败 ${host}:${port} -`, err.message);
    sendError(clientSocket, 502, 'Bad Gateway');
  }
}

/**
 * 处理普通 HTTP 请求（非 CONNECT）
 */
async function handleHttpRequest(req, res) {
  let urlObj;
  try {
    urlObj = new URL(req.url.startsWith('http') ? req.url : `http://${req.headers.host}${req.url}`);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  const host = urlObj.hostname;
  const port = urlObj.port ? parseInt(urlObj.port) : 80;
  const config = getConfig();
  const rule = findRule(host, config.rules || []);
  const upstream = rule ? rule.upstream : null;

  console.log(
    `[HTTP ] ${req.method} ${host}:${port}${urlObj.pathname} -> ${upstream ? `上游 ${upstream.type} ${upstream.host}:${upstream.port}` : '直连'}`
  );

  try {
    if (upstream && (upstream.type === 'http' || upstream.type === 'https')) {
      await forwardHttpViaUpstream(upstream, req, res);
    } else {
      await forwardHttpDirect(upstream, req, res, urlObj);
    }
  } catch (err) {
    console.error(`[HTTP ] 转发失败 ${host} -`, err.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  }
}

/**
 * 通过上游 HTTP 代理转发 HTTP 请求（保留完整 URL，让上游代理去请求目标）
 */
function forwardHttpViaUpstream(upstream, clientReq, clientRes) {
  return new Promise((resolve, reject) => {
    const proxyReq = http.request({
      hostname: upstream.host,
      port: upstream.port,
      method: clientReq.method,
      path: clientReq.url,
      headers: clientReq.headers,
    });

    proxyReq.on('response', (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(clientRes);
      proxyRes.on('end', resolve);
    });

    proxyReq.on('error', (err) => {
      reject(err);
    });

    clientReq.pipe(proxyReq);
  });
}

/**
 * 直连或 SOCKS5 方式转发 HTTP 请求
 */
async function forwardHttpDirect(upstream, clientReq, clientRes, urlObj) {
  const host = urlObj.hostname;
  const port = urlObj.port ? parseInt(urlObj.port) : 80;

  const remoteSocket = await createTunnel(upstream, host, port, null);

  const pathWithQuery = urlObj.pathname + urlObj.search;
  let rawRequest = `${clientReq.method} ${pathWithQuery} HTTP/${clientReq.httpVersion}\r\n`;
  for (let i = 0; i < clientReq.rawHeaders.length; i += 2) {
    rawRequest += `${clientReq.rawHeaders[i]}: ${clientReq.rawHeaders[i + 1]}\r\n`;
  }
  rawRequest += '\r\n';
  remoteSocket.write(rawRequest);

  const clientSocket = clientRes.socket;
  clientReq.pipe(remoteSocket);
  remoteSocket.pipe(clientSocket);

  remoteSocket.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => remoteSocket.destroy());
  remoteSocket.on('close', () => clientSocket.destroy());
  clientSocket.on('close', () => remoteSocket.destroy());
}

function createProxyServer() {
  const server = http.createServer();

  server.on('request', handleHttpRequest);
  server.on('connect', handleConnect);

  server.on('error', (err) => {
    console.error('[server] 服务器错误:', err.message);
  });

  return server;
}

module.exports = { createProxyServer };
