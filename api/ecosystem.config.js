module.exports = {
  apps: [
    {
      name: "agoraiq-signals-api",
      script: "src/index.js",
      cwd: "/opt/agoraiq-signals/api",
      instances: 1,
      env: {
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://agoraiq_signals:desf19848@127.0.0.1:5432/agoraiq_signals",
        STRIPE_SECRET_KEY: "sk_test_51SwCYCKy8M3N8YLpYNjeirrUzTzm2iE15P1yEsgLqw7hlqOKsjq5yqNzGG3IRFaTYHH2Kz50jsNA1ksMYW8am9AH00S46Jzddn",
        STRIPE_WEBHOOK_SECRET: "whsec_YtCVacVrl2eDNi4cQvZy26M0ZcWr7m8Q",
        STRIPE_PRICE_PRO: "price_1TFf76Ky8M3N8YLpYKcDnfdq",
        STRIPE_PRICE_PRO_YEARLY: "price_1TFf9OKy8M3N8YLpck08Nb4l",
        STRIPE_PRICE_ELITE: "price_1TFf7gKy8M3N8YLp435leO3D",
        STRIPE_PRICE_ELITE_YEARLY: "price_1TFf8xKy8M3N8YLpN2v6Vbwt",
        APP_URL: "https://bot.agoraiq.net"
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
