/**
 * PM2 process definitions for public read-only deployment.
 * Usage: pm2 start deploy/backend.ecosystem.config.cjs
 */
module.exports = {
  apps: [
    {
      name: 'mmt-backend',
      cwd: './web/backend',
      script: 'index.js',
      instances: 1,
      exec_mode: 'fork',
      max_restarts: 10,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
        PORT: '3001',
      },
    },
    {
      name: 'mmt-monitor',
      cwd: '.',
      script: 'packages/monitor/src/supervisor.js',
      instances: 1,
      exec_mode: 'fork',
      max_restarts: 10,
      env: {
        MONITOR_BACKEND_URL: 'http://127.0.0.1:3001',
        MONITOR_WS_BASE: 'ws://127.0.0.1:3001',
        MONITOR_INTERVAL_MS: '30000',
      },
    },
  ],
};
