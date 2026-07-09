# local-proxy

这个项目包含两个本地代理服务：

- `local-proxy`：基于域名规则的本地 HTTP/HTTPS 正向代理，可以按规则选择直连、HTTP 上游代理或 SOCKS5 上游代理。
- `claude-adapter`：Anthropic Claude Messages API 到 OpenAI Chat Completions API 兼容接口的本地适配代理。

## 目录结构

```text
src/
  local-proxy/       # 传统 JS 本地正向代理
  claude-adapter/    # Claude API 兼容适配代理
```

## 安装依赖

```bash
npm install
```

项目要求 Node.js 20 或以上版本。由于当前依赖 `undici` 要求 Node.js `>=20.18.1`，建议使用 Node.js 20.18.1 或更新版本运行 `claude-adapter`。

## 敏感配置说明

真实配置文件包含代理地址、上游 API key、内部域名等敏感信息，默认不会提交到 Git：

```text
local-proxy.config.json
claude-adapter.config.json
```

仓库中提供两个示例配置文件：

```text
local-proxy.config.example.json
claude-adapter.config.example.json
```

首次使用时可以复制示例配置：

```bash
cp local-proxy.config.example.json local-proxy.config.json
cp claude-adapter.config.example.json claude-adapter.config.json
```

然后按你的本地环境修改真实配置文件。

## local-proxy：本地正向代理

### 配置文件

默认读取项目根目录下的：

```text
local-proxy.config.json
```

如果该文件不存在，会 fallback 到：

```text
local-proxy.config.example.json
```

也可以通过环境变量指定配置文件路径：

```bash
LOCAL_PROXY_CONFIG=/path/to/local-proxy.config.json npm start
```

### 配置示例

```json
{
  "port": 8080,
  "rules": [
    {
      "match": "example.internal",
      "matchType": "exact",
      "upstream": {
        "type": "http",
        "host": "127.0.0.1",
        "port": 8899
      }
    },
    {
      "match": "*.example.internal",
      "matchType": "suffix",
      "upstream": {
        "type": "http",
        "host": "127.0.0.1",
        "port": 8899
      }
    }
  ],
  "defaultAction": "direct"
}
```

字段说明：

- `port`：本地代理监听端口。
- `rules`：域名匹配规则列表，按顺序匹配，命中后使用对应 `upstream`。
- `match`：匹配内容。
- `matchType`：匹配类型。
  - `exact`：精确匹配，例如 `example.internal`。
  - `suffix`：后缀匹配，例如 `*.example.internal`。
  - `regex`：正则匹配。
- `upstream.type`：上游代理类型，支持：
  - `http`
  - `https`
  - `socks5`
- `upstream.host`：上游代理地址。
- `upstream.port`：上游代理端口。
- `defaultAction`：未命中规则时的默认行为。
  - `direct`：直连目标。
  - 其他值会让未命中的 CONNECT 请求返回 `403 Forbidden`。

### 启动 local-proxy

生产/普通启动：

```bash
npm start
```

开发模式，文件变化自动重启：

```bash
npm run dev
```

默认监听：

```text
127.0.0.1:<port>
```

其中 `<port>` 来自 `local-proxy.config.json` 的 `port` 字段，示例中是 `8080`。

### 使用 local-proxy

启动后，把需要走代理的客户端代理地址设置为：

```text
HTTP 代理：127.0.0.1:8080
HTTPS 代理：127.0.0.1:8080
```

macOS 可以按需执行：

```bash
networksetup -setwebproxy Wi-Fi 127.0.0.1 8080
networksetup -setsecurewebproxy Wi-Fi 127.0.0.1 8080
```

关闭系统代理：

```bash
networksetup -setwebproxystate Wi-Fi off
networksetup -setsecurewebproxystate Wi-Fi off
```

如果你的配置里使用了其他端口，请把命令里的 `8080` 替换为实际端口。

## claude-adapter：Claude API 兼容适配代理

`claude-adapter` 提供 Anthropic Claude Messages API 形式的本地接口，并把请求转发到 OpenAI Chat Completions 兼容上游。

### 配置文件

默认读取项目根目录下的：

```text
claude-adapter.config.json
```

如果该文件不存在，会 fallback 到：

```text
claude-adapter.config.example.json
```

也可以通过环境变量或启动参数指定配置文件路径，配置文件结构与 `claude-adapter.config.example.json` 一致：

```bash
CLAUDE_ADAPTER_CONFIG=/path/to/claude-adapter.config.json npm run adapter:start
```

构建后也可以直接用 `--config` 或 `-c` 指定：

```bash
./dist/claude-adapter/cli.js start --config /path/to/claude-adapter.config.json
./dist/claude-adapter/cli.js start -c /path/to/claude-adapter.config.json
```

也支持通过环境变量覆盖上游地址和 API key：

```bash
CLAUDE_ADAPTER_UPSTREAM_BASE_URL=http://127.0.0.1:8888 \
CLAUDE_ADAPTER_UPSTREAM_API_KEY=your-api-key \
npm run adapter:start
```

### 配置示例

```json
{
  "listen": {
    "host": "127.0.0.1",
    "port": 8989
  },
  "upstream": {
    "baseUrl": "http://127.0.0.1:8888",
    "apiKey": ""
  },
  "logging": {
    "enabled": false,
    "conversationDir": "logs/claude-adapter"
  },
  "models": {
    "claude-fable-5": "gpt-5.5",
    "gpt-5.5": "gpt-5.5"
  }
}
```

字段说明：

- `listen.host`：本地监听地址。
- `listen.port`：本地监听端口。
- `upstream.baseUrl`：OpenAI Chat Completions 兼容上游服务地址。
- `upstream.apiKey`：默认上游 API key。请求头里传入的 key 会优先生效。
- `logging.enabled`：是否开启对话日志，默认关闭。
- `logging.conversationDir`：对话日志目录。
- `models`：模型名映射表。左侧是客户端请求使用的模型名，右侧是转发给上游的模型名。

### 启动 claude-adapter

开发模式，直接运行 TypeScript 源码：

```bash
npm run adapter:start:src -- --config ./claude-adapter.config.json
```

默认构建 portable 产物：

```bash
npm run build
```

portable 产物不会自动读取当前目录的 `claude-adapter.config.json`，启动时必须显式指定配置文件：

```bash
npm run adapter:start -- --config ./claude-adapter.config.json
```

也可以直接执行构建后的 CLI，并指定配置文件：

```bash
./dist/claude-adapter/cli.js start --config ./claude-adapter.config.json
```

如果你明确要构建本机自用版本，可以指定 `local` 参数：

```bash
npm run build -- local
```

local 模式下，如果启动时没有传 `--config`，才会按原逻辑读取当前目录的 `claude-adapter.config.json`，不存在时再 fallback 到 `claude-adapter.config.example.json`：

```bash
npm run adapter:start
```

如果通过 `npm link` 或作为 npm 包安装，也可以使用 bin 命令：

```bash
claude-adapter start --config ./claude-adapter.config.json
```

开发模式，文件变化自动重启：

```bash
npm run adapter:dev -- --config ./claude-adapter.config.json
```

默认监听：

```text
http://127.0.0.1:8989
```

### 使用 claude-adapter

健康检查：

```bash
curl http://127.0.0.1:8989/health
```

列出模型：

```bash
curl http://127.0.0.1:8989/v1/models
```

调用 Messages API：

```bash
curl http://127.0.0.1:8989/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: your-api-key' \
  -d '{
    "model": "claude-fable-5",
    "max_tokens": 1024,
    "messages": [
      {
        "role": "user",
        "content": "你好"
      }
    ]
  }'
```

如果 `claude-adapter.config.json` 中已经配置了 `upstream.apiKey`，请求时可以不传 `x-api-key`。如果请求里传了 `x-api-key` 或 `authorization`，请求里的 key 会覆盖配置里的默认 key。

### 配置 Claude Code 使用 claude-adapter

启动 `claude-adapter` 后，可以把 Claude Code 的 API base URL 指向本地代理。例如：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8989
export ANTHROPIC_AUTH_TOKEN=your-api-key
```

然后正常使用 Claude Code。实际环境变量名称以你的 Claude Code 版本和配置方式为准。

### 对话日志

`claude-adapter` 默认不记录对话日志：

```json
"logging": {
  "enabled": false,
  "conversationDir": "logs/claude-adapter"
}
```

需要调试时改成：

```json
"logging": {
  "enabled": true,
  "conversationDir": "logs/claude-adapter"
}
```

开启后，每次启动 `claude-adapter` 会创建一个新的 session 日志文件，后续所有请求都会追加写入这个文件，而不是每次请求创建一个文件。

日志目录 `logs/` 已在 `.gitignore` 中忽略。

## 构建和测试

构建 `claude-adapter`：

```bash
npm run adapter:build
```

运行 `claude-adapter` 测试：

```bash
npm run adapter:test
```

## 常见问题

### 配置文件不存在怎么办？

复制 example 文件即可：

```bash
cp local-proxy.config.example.json local-proxy.config.json
cp claude-adapter.config.example.json claude-adapter.config.json
```

### 为什么真实配置不提交到 Git？

真实配置可能包含内部域名、上游代理地址、API key 等敏感信息，所以被 `.gitignore` 忽略。需要共享配置结构时，请更新对应的 `*.example.json` 文件。

### 修改 local-proxy 配置后需要重启吗？

`local-proxy` 会监听配置文件变化，修改配置后会自动重新加载。

### 修改 claude-adapter 配置后需要重启吗？

需要。`claude-adapter` 在启动时读取配置，修改配置后请重启服务。
