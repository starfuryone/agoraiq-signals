module.exports = {
  apps: [{
    name: "providers-api",
    script: "index.js",
    cwd: "/opt/agoraiq-signals/providers-api",
    instances: 1,
    env: { NODE_ENV: "production", PROVIDERS_PORT: "4400" },
    max_memory_restart: "128M",
    error_file: "/opt/agoraiq-signals/providers-api/error.log",
    out_file:   "/opt/agoraiq-signals/providers-api/out.log",
    merge_logs: true
  }]
};
