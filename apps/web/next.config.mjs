const workerInternalUrl = process.env.WORKER_INTERNAL_URL || "http://127.0.0.1:8787";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@personaldrive/shared", "@personaldrive/upload-engine"],
  typedRoutes: false,
  allowedDevOrigins: ["*.e2b.app"],
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${workerInternalUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;
