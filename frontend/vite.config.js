import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // The Battle tab replays turns with the sidecar's own protocol reducer
    // (../sim/protocol.mjs), which lives outside the Vite root.
    fs: { allow: ['..'] },
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/sim': 'http://127.0.0.1:8001',   // Showdown simulator sidecar (sim/server.mjs)
    },
  },
});
