/**
 * PM2 process file.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs wolf-stats
 *   pm2 restart wolf-stats
 *
 * The .cjs extension is required, not stylistic. PM2 loads this file with
 * `require`, but package.json declares "type": "module", which makes every
 * .js file an ES module where `module.exports` does not exist. The explicit
 * .cjs extension opts this one file back into CommonJS. The donor project
 * (d:\projects\ponsy) learned this the hard way — do not rename this file.
 *
 * Cluster mode would be safe here — the service is stateless — but it is
 * pointless: every response is served from a 30s cache and the work is
 * waiting on upstream I/O, not CPU. One fork keeps the cache (and the
 * once-a-day snapshot write in src/snapshot.js) unified; two would double
 * the upstream request rate and could race two processes writing the same
 * snapshot file for no gain.
 */
module.exports = {
  apps: [
    {
      name: 'wolf-stats',
      script: 'src/index.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '200M',
      time: true, // timestamps in pm2 logs
      env: { NODE_ENV: 'production' },
    },
  ],
}
