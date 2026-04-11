import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import { initDb } from './db.js';
import { loadConfig } from './config.js';
import { createApiRouter } from './ui/routes.js';
import { startScheduler } from './scheduler.js';
import { initYouTubeState } from './sources/youtube.js';
import { logger } from './logger.js';

const PORT = process.env.PORT || 3000;

async function waitForDb(maxRetries = 10, delayMs = 3000): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await initDb();
      return;
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      logger.info(`Database not ready, retrying in ${delayMs / 1000}s... (${i + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

async function main() {
  logger.info('Starting Slowfeed...');

  // Initialize database with retry logic (for cloud deployments where DB may start slowly)
  await waitForDb();
  logger.info('Database initialized');

  // Load configuration
  await loadConfig();
  logger.info('Configuration loaded');

  // Initialize YouTube state (restore last poll time)
  await initYouTubeState();

  // Create Express app
  const app = express();

  // Middleware
  app.use(compression());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Prevent caching of API responses
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Mount API router
  app.use(createApiRouter());

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Start scheduler
  startScheduler();
  logger.info('Scheduler started');

  // Start server
  app.listen(PORT, () => {
    logger.info(`Slowfeed API running on port ${PORT}`);
  });
}

main().catch((err) => {
  logger.error('Failed to start Slowfeed:', err);
  process.exit(1);
});
