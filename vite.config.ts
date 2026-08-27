import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { monitorApi } from './server/api';
import { cfg } from './server/config';

export default defineConfig({
  plugins: [tailwindcss(), react(), monitorApi()],
  // Any Host is fine: the API's guard (server/remote.ts) is what keeps a tunnel or a rebound name out.
  server: { port: cfg().port, allowedHosts: true },
  preview: { port: cfg().port, allowedHosts: true },
});
