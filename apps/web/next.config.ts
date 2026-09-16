import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  transpilePackages: ['@polycast/ui', '@polycast/domain', '@polycast/contracts'],
  poweredByHeader: false,
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Frame-Options', value: 'DENY' },
      ],
    },
  ],
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      // `@polycast/domain` imports `node:crypto` for uuidv7(), which the browser never calls.
      // Strip the scheme and stub the module so the pure state-machine/time helpers bundle.
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /^node:(.+)$/,
          (resource: { request: string }) => {
            resource.request = resource.request.replace(/^node:/, '');
          },
        ),
      );
      config.resolve.fallback = { ...(config.resolve.fallback ?? {}), crypto: false };
    }
    return config;
  },
};

export default nextConfig;
