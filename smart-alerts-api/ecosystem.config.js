// Path-agnostic PM2 config. Resolves paths from this file's own
// location, so the same ecosystem works whether the service is
// deployed at /opt/agoraiq-smart-alerts (standalone) or inside the
// monorepo at /opt/agoraiq-signals/smart-alerts-api.

const path = require("path");
const BASE = __dirname;
const LOGS = path.join(BASE, "logs");

module.exports = {
  apps: [
    {
      name: "smart-alerts-api",
      script: path.join(BASE, "src/index.js"),
      cwd: BASE,
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production" },
      max_memory_restart: "256M",
      error_file: path.join(LOGS, "api.err.log"),
      out_file:   path.join(LOGS, "api.out.log"),
      merge_logs: true,
      time: true,
      kill_timeout: 5000
    },
    {
      name: "smart-alerts-worker",
      script: path.join(BASE, "src/worker.js"),
      cwd: BASE,
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production" },
      max_memory_restart: "256M",
      error_file: path.join(LOGS, "worker.err.log"),
      out_file:   path.join(LOGS, "worker.out.log"),
      merge_logs: true,
      time: true,
      kill_timeout: 10000
    }
  ]
};
