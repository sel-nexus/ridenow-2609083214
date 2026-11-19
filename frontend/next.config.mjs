/** Proxy browser API requests to the configured backend. */
const backend = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
const config = {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${backend}/api/:path*` }];
  },
};
export default config;
