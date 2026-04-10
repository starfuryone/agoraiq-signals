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
        APP_URL: "https://bot.agoraiq.net",
	GEMINI_API_KEY: "AIzaSyD_ob0ti772BbOy0FDxgUZlPLaXdeHPqYk",
  	PPLX_API_KEY: "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",
	OPENROUTER_API_KEY: "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"
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
        DATABASE_URL: "postgresql://agoraiq_signals:desf19848@127.0.0.1:5432/agoraiq_signals",
        SOCKS_PROXY_URL: "socks5://143.198.202.65:1080"
      },
      max_memory_restart: "256M",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "/opt/agoraiq-signals/api/logs/workers-error.log",
      out_file: "/opt/agoraiq-signals/api/logs/workers-out.log",
      merge_logs: true,
    },
  ],
};
