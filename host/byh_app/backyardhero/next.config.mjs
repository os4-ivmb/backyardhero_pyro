/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/uploads/audio/:filename',
        destination: '/api/shows/audio/:filename',
      },
    ];
  },
};

export default nextConfig;
