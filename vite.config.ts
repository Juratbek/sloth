import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { monitorApi } from './server/api';
import { cfg } from './server/config';

export default defineConfig({
  plugins: [tailwindcss(), react(), monitorApi()],
  // Any Host is fine: the API's guard (server/remote.ts) is what keeps a tunnel or a rebound name out.
  // `strictPort` so a second Sloth fails to start instead of taking the next port and watching the same
  // board beside the first — the restart at the end of an update is where that used to happen.
  server: { port: cfg().port, strictPort: true, allowedHosts: true },
  preview: { port: cfg().port, strictPort: true, allowedHosts: true },
});
