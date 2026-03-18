import 'dotenv/config';
import express from 'express';
import path from 'path';
import { initDb } from './db.js';
import { loadConfig } from './config.js';
import { createFeedRouter } from './feed.js';
import { createUiRouter } from './ui/routes.js';
import { startScheduler } from './scheduler.js';
import { initYouTubeState } from './sources/youtube.js';
import { logger } from './logger.js';

const PORT = process.env.PORT || 3000;

async function main() {
  logger.info('Starting Slowfeed...');

  // Initialize database
  await initDb();
  logger.info('Database initialized');

  // Load configuration
  await loadConfig();
  logger.info('Configuration loaded');

  // Initialize YouTube state (restore last poll time)
  await initYouTubeState();

  // Create Express app
  const app = express();

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Serve static files for Web UI
  app.use(express.static(path.join(process.cwd(), 'src/ui/public')));

  // Mount main routers
  app.use(createFeedRouter());
  app.use(createUiRouter());

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Start scheduler
  startScheduler();
  logger.info('Scheduler started');

  // Start server
  app.listen(PORT, () => {
    logger.info(`Slowfeed running on port ${PORT}`);
    logger.info(`Web UI: http://localhost:${PORT}`);
    logger.info(`RSS Feed: http://localhost:${PORT}/feed.rss`);
    logger.info(`Atom Feed: http://localhost:${PORT}/feed.atom`);
  });
}

main().catch((err) => {
  logger.error('Failed to start Slowfeed:', err);
  process.exit(1);
});
