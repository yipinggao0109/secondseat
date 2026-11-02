import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    // Vinext defaults multipart request bodies to 1 MB. Allow the UI's full
    // advertised capacity of eight 16 MB checklist images plus form overhead.
    serverActions: {
      bodySizeLimit: '160mb',
    },
  },
};

export default nextConfig;
