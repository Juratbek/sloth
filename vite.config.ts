import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { monitorApi } from './server/api';
import { PORT } from './server/config';

export default defineConfig({
  plugins: [tailwindcss(), react(), monitorApi()],
  server: { port: PORT },
  preview: { port: PORT },
});
