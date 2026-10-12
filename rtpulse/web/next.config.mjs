

const nextConfig = {
  output: "standalone",

  // Native Node.js modules that should not be bundled
  serverExternalPackages: ["ssh2", "mysql2", "mysql2/promise", "pg", "minio", "fflate"],

  experimental: {
    // Server Action body limit (Next.js 16에서 experimental.serverActions 아래)
    serverActions: {
      bodySizeLimit: "200mb",
    },
  },

  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
        ],
      },
    ];
  },
};

export default nextConfig;
