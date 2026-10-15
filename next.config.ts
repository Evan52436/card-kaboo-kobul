import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The engine is pure TypeScript with no framework imports; nothing special is needed
  // to bundle it. Kept minimal on purpose.

  /**
   * The deck never changes between deploys, and a deal can ask for a dozen cards
   * at once, so let the browser keep them. A day rather than a year: the
   * filenames are the card names, not a content hash, so a re-rendered deck
   * would otherwise be invisible to anyone who had already played.
   */
  async headers() {
    return [
      {
        source: '/cards/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' },
        ],
      },
    ];
  },
};

export default nextConfig;
