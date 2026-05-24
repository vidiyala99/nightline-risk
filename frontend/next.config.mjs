const nextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  // Allow dev-mode HMR / CSS chunk fetches from 127.0.0.1 (Next 16 default-blocks
  // anything other than `localhost`). Without this, hitting the dev server via
  // 127.0.0.1 serves HTML but the CSS bundle 404s and the page looks unstyled.
  allowedDevOrigins: ['127.0.0.1'],
};

export default nextConfig;
