import { logger } from '../logger.js';
import type { DigestPost } from '../types/index.js';

// Reddit inbox requires authentication which is no longer available
// This is a no-op placeholder

export async function pollRedditNotifications(): Promise<DigestPost[]> {
  logger.debug('Reddit notifications polling disabled (requires API access)');
  // Reddit inbox scraping would require login cookies which we don't support
  // Users can check their inbox directly on Reddit
  return [];
}
