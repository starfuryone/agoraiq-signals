module.exports = {
  apps: [
    {
      name: "agoraiq-signals-api",
      script: "src/index.js",
      cwd: "/opt/agoraiq-signals/api",
      instances: 1,
      env: {
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://agoraiq_signals:desf19848@127.0.0.1:5432/agoraiq_signals"
      },
      max_memory_restart: "256M",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "/opt/agoraiq-signals/api/logs/error.log",
      out_file: "/opt/agoraiq-signals/api/logs/out.log",
      merge_logs: true,
    },
    {
      name: "agoraiq-signals-workers",
      script: "src/workers/index.js",
      cwd: "/opt/agoraiq-signals/api",
      instances: 1,
      env: {
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://agoraiq_signals:desf19848@127.0.0.1:5432/agoraiq_signals"
      },
      max_memory_restart: "256M",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "/opt/agoraiq-signals/api/logs/workers-error.log",
      out_file: "/opt/agoraiq-signals/api/logs/workers-out.log",
      merge_logs: true,
    },
  ],
};
