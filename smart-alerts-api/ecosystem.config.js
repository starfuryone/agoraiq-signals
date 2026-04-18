module.exports = {
  apps: [
    {
      name: "smart-alerts-api",
      script: "src/index.js",
      cwd: "/opt/agoraiq-smart-alerts",
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production" },
      max_memory_restart: "256M",
      error_file: "/opt/agoraiq-smart-alerts/logs/api.err.log",
      out_file: "/opt/agoraiq-smart-alerts/logs/api.out.log",
      merge_logs: true,
      time: true,
      kill_timeout: 5000
    },
    {
      name: "smart-alerts-worker",
      script: "src/worker.js",
      cwd: "/opt/agoraiq-smart-alerts",
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production" },
      max_memory_restart: "256M",
      error_file: "/opt/agoraiq-smart-alerts/logs/worker.err.log",
      out_file: "/opt/agoraiq-smart-alerts/logs/worker.out.log",
      merge_logs: true,
      time: true,
      kill_timeout: 10000
    }
  ]
};
