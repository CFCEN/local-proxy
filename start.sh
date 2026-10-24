npm run adapter:build &&
echo "Adapter built successfully" &&
echo "Stopping existing adapter instances" &&
dist/claude-adapter/cli.js stop &&
echo "Starting new adapter instance" &&
dist/claude-adapter/cli.js start --config ./claude-adapter.config.json