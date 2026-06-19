/** @type {import('next').NextConfig} */

// Cloud Builder plan §9.2: in the cloud profile the app is served under
// cloud.backyard-hero.com/builder (same origin as the gateway, so the Supabase
// session cookie is shared). basePath/assetPrefix make Next emit /builder/...
// URLs. Local (on-device) stays at the root.
const isCloud = process.env.BYH_PROFILE === 'cloud';
const basePath = isCloud ? '/builder' : '';

// The desktop bundle (Electron) runs the app via the Next "standalone" server
// output -- a self-contained server.js + minimal node_modules that Electron's
// bundled Node executes directly, with no `npm`/`next start` on the user's
// machine. It's gated behind BYH_BUILD_STANDALONE so the Docker image (which
// uses `next start`) and the cloud/serverless build are completely unaffected.
const standalone = process.env.BYH_BUILD_STANDALONE === '1';

const nextConfig = {
  reactStrictMode: true,
  ...(standalone ? { output: 'standalone' } : {}),
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  // Surface the deploy profile to the browser bundle. basePath is NOT applied
  // by Next to raw fetch()/axios calls, so the client prefixes API URLs with
  // NEXT_PUBLIC_BASE_PATH itself; NEXT_PUBLIC_BYH_PROFILE gates hardware-only
  // client behaviour (e.g. the on-device daemon WebSocket). Both are empty /
  // 'local' for the on-device build, so local runtime is unchanged.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_BYH_PROFILE: isCloud ? 'cloud' : 'local',
  },
  async rewrites() {
    return [
      {
        source: '/uploads/audio/:filename',
        destination: '/api/shows/audio/:filename',
      },
      {
        source: '/uploads/images/:filename',
        destination: '/api/inventory/image/:filename',
      },
    ];
  },
};

export default nextConfig;
