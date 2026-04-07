'use strict';

const net = require('net');
const { SocksClient } = require('socks');

/**
 * 双向管道透传：将 clientSocket 和 remoteSocket 的数据互相转发
 */
function pipe(clientSocket, remoteSocket) {
  remoteSocket.pipe(clientSocket);
  clientSocket.pipe(remoteSocket);

  remoteSocket.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => remoteSocket.destroy());
  remoteSocket.on('close', () => clientSocket.destroy());
  clientSocket.on('close', () => remoteSocket.destroy());
}

/**
 * 建立到目标的 TCP 连接（直连）
 */
function connectDirect(targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: targetHost, port: targetPort }, () => {
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

/**
 * 通过 HTTP 上游代理建立 CONNECT 隧道，返回已建立隧道的 socket
 * @param {object} originalHeaders - 浏览器原始 CONNECT 请求头，原样转发给上游
 */
function connectViaHttpProxy(proxyHost, proxyPort, targetHost, targetPort, originalHeaders) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: proxyHost, port: proxyPort }, () => {
      let connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n`;

      if (originalHeaders) {
        const skip = new Set(['proxy-connection']);
        for (let i = 0; i < originalHeaders.length; i += 2) {
          if (!skip.has(originalHeaders[i].toLowerCase())) {
            connectReq += `${originalHeaders[i]}: ${originalHeaders[i + 1]}\r\n`;
          }
        }
      }
      connectReq += `Host: ${targetHost}:${targetPort}\r\nProxy-Connection: Keep-Alive\r\n\r\n`;

      socket.write(connectReq);
    });

    socket.once('error', reject);

    const chunks = [];
    socket.on('data', function onData(chunk) {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const headerStr = buffer.slice(0, headerEnd).toString();
      const statusLine = headerStr.split('\r\n')[0];
      const statusCode = parseInt(statusLine.split(' ')[1], 10);

      socket.removeListener('data', onData);

      if (statusCode === 200) {
        const extra = buffer.slice(headerEnd + 4);
        if (extra.length > 0) {
          socket.unshift(extra);
        }
        console.log(`[tunnel] 上游隧道已建立 -> ${targetHost}:${targetPort}`);
        resolve(socket);
      } else {
        console.error(`[tunnel] 上游 CONNECT 失败: ${statusLine}`);
        socket.destroy();
        reject(new Error(`上游代理 CONNECT 返回: ${statusLine}`));
      }
    });
  });
}

/**
 * 通过 SOCKS5 上游代理建立连接，返回 socket
 */
async function connectViaSocks5(proxyHost, proxyPort, targetHost, targetPort) {
  const { socket } = await SocksClient.createConnection({
    proxy: { host: proxyHost, port: proxyPort, type: 5 },
    command: 'connect',
    destination: { host: targetHost, port: targetPort },
  });
  return socket;
}

/**
 * 根据 upstream 配置选择连接方式，返回到目标的 socket
 * @param {object|null} upstream - 上游配置，null 表示直连
 * @param {string} targetHost
 * @param {number} targetPort
 */
/**
 * @param {object|null} upstream
 * @param {string} targetHost
 * @param {number} targetPort
 * @param {string[]|null} originalHeaders - 浏览器原始请求的 rawHeaders，转发给上游 HTTP 代理
 */
async function createTunnel(upstream, targetHost, targetPort, originalHeaders) {
  if (!upstream) {
    return connectDirect(targetHost, targetPort);
  }

  switch (upstream.type) {
    case 'http':
    case 'https':
      return connectViaHttpProxy(upstream.host, upstream.port, targetHost, targetPort, originalHeaders);

    case 'socks5':
      return connectViaSocks5(upstream.host, upstream.port, targetHost, targetPort);

    default:
      throw new Error(`不支持的上游代理类型: ${upstream.type}`);
  }
}

/**
 * 将普通 HTTP 请求转发到上游 HTTP 代理（非 CONNECT 隧道方式）
 * 直接把完整请求写给上游代理，让代理访问目标
 */
function forwardHttpRequest(upstream, req, clientSocket, head) {
  return new Promise((resolve, reject) => {
    const proxySocket = net.createConnection({ host: upstream.host, port: upstream.port }, () => {
      // 重建原始请求行和头部，发给上游代理
      let rawRequest = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        rawRequest += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      rawRequest += '\r\n';

      proxySocket.write(rawRequest);
      if (head && head.length > 0) {
        proxySocket.write(head);
      }

      pipe(clientSocket, proxySocket);
      resolve(proxySocket);
    });

    proxySocket.once('error', reject);
  });
}

module.exports = { createTunnel, forwardHttpRequest, pipe, connectDirect };
