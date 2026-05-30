const nextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  // Allow dev-mode HMR / CSS chunk fetches from 127.0.0.1 (Next 16 default-blocks
  // anything other than `localhost`). Without this, hitting the dev server via
  // 127.0.0.1 serves HTML but the CSS bundle 404s and the page looks unstyled.
  allowedDevOrigins: ['127.0.0.1'],
  // Funnel the stale auto-generated Vercel project domain to the canonical app
  // URL. Path-preserving 308 so deep links keep working. Add more stale hosts to
  // the `value` list as Vercel mints new ones; preview deployments are untouched.
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [
          { type: 'host', value: 'frontend-mu-ebon-n3x8uw2rpx.vercel.app' },
        ],
        destination: 'https://nightline-app.vercel.app/:path*',
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
