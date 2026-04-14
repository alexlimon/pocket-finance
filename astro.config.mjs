import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import fs from 'fs';

const isDev = process.env.NODE_ENV !== 'production';

const httpsConfig = isDev && fs.existsSync('./certs/key.pem') && fs.existsSync('./certs/cert.pem')
  ? { key: fs.readFileSync('./certs/key.pem'), cert: fs.readFileSync('./certs/cert.pem') }
  : undefined;

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    platformProxy: { enabled: true },
  }),
  integrations: [
    react(),
    tailwind(),
  ],
  vite: {
    server: {
      https: httpsConfig,
    },
  },
});
