import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { monitorApi } from './server/api';
import { cfg } from './server/config';

export default defineConfig({
  plugins: [tailwindcss(), react(), monitorApi()],
  server: { port: cfg().port },
  preview: { port: cfg().port },
});
