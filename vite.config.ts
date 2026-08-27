import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { monitorApi } from './server/api';
import { cfg, envValue } from './server/config';

// Vite answers only to localhost unless the hostname a tunnel presents is allowed — SLOTH_HOST names it.
const host = envValue('SLOTH_HOST');
const allowedHosts = host ? [host] : undefined;

export default defineConfig({
  plugins: [tailwindcss(), react(), monitorApi()],
  server: { port: cfg().port, allowedHosts },
  preview: { port: cfg().port, allowedHosts },
});
