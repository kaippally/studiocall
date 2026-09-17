// The StudioCall processes. start.ps1 starts whichever is missing and never restarts one that is
// online — restarting studiocall-audio drops the room's audio.
//
// Default is the shareable shape: the server serves the built UI. STUDIOCALL_DEV=1 (start.ps1 -Dev)
// runs the server under `tsx watch` and adds the Vite dev server.
const path = require('path');

const dev = process.env.STUDIOCALL_DEV === '1';

module.exports = {
  apps: [
    {
      // Agora RTC leg. Electron, because agora-electron-sdk is built against Electron's ABI.
      name: 'studiocall-audio',
      script: 'node_modules/electron/cli.js',
      args: '.',
      interpreter: 'node',
      cwd: __dirname,
      autorestart: true,
    },
    {
      // Clubhouse API, room pumps, WebSocket, and (built) the UI on :4019.
      name: 'studiocall-server',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: dev ? 'watch src/index.ts' : 'src/index.ts',
      interpreter: 'node',
      cwd: path.join(__dirname, 'server'),
      env: { NODE_ENV: dev ? 'development' : 'production' },
      autorestart: true,
      exp_backoff_restart_delay: 1000,
    },
    ...(dev ? [{
      // Hot-reloading UI on :5220/studiocall/.
      name: 'studiocall-client',
      script: 'node_modules/vite/bin/vite.js',
      interpreter: 'node',
      cwd: path.join(__dirname, 'client'),
      autorestart: true,
      exp_backoff_restart_delay: 1000,
    }] : []),
  ],
};
