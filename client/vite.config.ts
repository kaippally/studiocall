import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

// Served under /studiocall/ so a host app can proxy and embed it same-origin. Set SC_CERT_DIR to a
// folder holding localhost.pem + localhost-key.pem (mkcert) when the host page is https; without
// it the dev server speaks plain http.
const certDir = process.env.SC_CERT_DIR;
const https = certDir && fs.existsSync(path.join(certDir, 'localhost.pem'))
  ? { key: fs.readFileSync(path.join(certDir!, 'localhost-key.pem')), cert: fs.readFileSync(path.join(certDir!, 'localhost.pem')) }
  : undefined;
const API_TARGET = `http://127.0.0.1:${process.env.STUDIOCALL_PORT ?? 4019}`;

export default defineConfig({
  base: '/studiocall/',
  plugins: [react()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        profile: path.resolve(__dirname, 'profile.html'),
        overlay: path.resolve(__dirname, 'overlay.html'),
      },
    },
  },
  server: {
    host: true,
    port: 5220,
    strictPort: true,
    https,
    hmr: https ? { protocol: 'wss', host: 'localhost', port: 5220 } : undefined,
    headers: { 'Cache-Control': 'no-store' },
    proxy: {
      '/api/studiocall': { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
});
