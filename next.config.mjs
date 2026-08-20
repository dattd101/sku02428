const isGithubActions = process.env.GITHUB_ACTIONS === 'true';
const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? '';
const isUserSite = repositoryName.endsWith('.github.io');
const basePath = isGithubActions && repositoryName && !isUserSite ? `/${repositoryName}` : '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  basePath,
  env: {
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL || 'wss://sku02428wss.vercel.app/api/ws',
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
