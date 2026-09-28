const express = require('express');
const bodyParser = require('body-parser');

const { load } = require('./src/config');
const { open } = require('./src/db');
const { securityHeaders } = require('./src/security');
const createRoutes = require('./src/routes');

const config = load();
const PORT = config.port;

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(bodyParser.json({ limit: '100kb' }));

// Initialize SQLite database (schema + migrations run before the first request is handled)
const db = open(config.dbPath);
app.use((req, res, next) => { db.ready.then(() => next(), next); });

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// REST API: /register, /login, /habits..., /api/...
app.use(createRoutes({ db, jwtSecret: config.jwtSecret, authRateMax: config.authRateMax }));

// Front-end (this was the missing piece that caused "Cannot GET /")
app.use(express.static(config.publicDir, {
  setHeaders(res, filePath) {
    if (/(index\.html|sw\.js|manifest\.webmanifest)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Error handling
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON', code: 'INVALID_JSON' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large', code: 'TOO_LARGE' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error', code: 'SERVER_ERROR' });
});

app.closeDb = () => db.close();

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
  const shutdown = () => {
    server.close(() => { db.close().catch(() => {}).then(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;
