/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  eslint: {
    ignoreDuringBuilds: true,
  },
  webpack: (config) => {
    // @deckgauge/shared is ESM ("type": "module") and is consumed as TypeScript
    // SOURCE, not as a build output — its package `exports` point at src/*.ts.
    // ESM requires the extension on a relative specifier, and in TypeScript that
    // extension is the EMITTED one, so `./schemas.ts` is written `./schemas.js`.
    // webpack resolves that literally, finds no such file, and the build dies
    // with "Can't resolve './schemas.js'". extensionAlias is the standard
    // mapping back: try the TypeScript sources first, then a real .js.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;