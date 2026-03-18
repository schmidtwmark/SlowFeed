import { BskyAgent, AppBskyNotificationListNotifications } from '@atproto/api';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { DigestPost } from '../types/index.js';

let agent: BskyAgent | null = null;
let lastLoginTime: number = 0;
const SESSION_DURATION = 60 * 60 * 1000; // 1 hour

type Notification = AppBskyNotificationListNotifications.Notification;

async function getAgent(): Promise<BskyAgent | null> {
  const config = getConfig();

  if (!config.bluesky_handle || !config.bluesky_app_password) {
    return null;
  }

  // Reuse agent if session is still valid
  if (agent && Date.now() - lastLoginTime < SESSION_DURATION) {
    return agent;
  }

  try {
    agent = new BskyAgent({ service: 'https://bsky.social' });

    await agent.login({
      identifier: config.bluesky_handle,
      password: config.bluesky_app_password,
    });

    lastLoginTime = Date.now();
    return agent;
  } catch (err) {
    logger.error('Bluesky login failed:', err);
    agent = null;
    return null;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getNotificationUrl(notification: Notification): string {
  // Extract rkey from URI
  const uri = notification.uri;
  const parts = uri.split('/');
  const rkey = parts[parts.length - 1];

  return `https://bsky.app/profile/${notification.author.handle}/post/${rkey}`;
}

function getNotificationTitle(notification: Notification): string {
  const author = `@${notification.author.handle}`;

  switch (notification.reason) {
    case 'reply':
      return `[Reply] ${author} replied to your post`;
    case 'mention':
      return `[Mention] ${author} mentioned you`;
    case 'quote':
      return `[Quote] ${author} quoted your post`;
    case 'like':
      return `[Like] ${author} liked your post`;
    case 'repost':
      return `[Repost] ${author} reposted your post`;
    case 'follow':
      return `[Follow] ${author} followed you`;
    default:
      return `[Notification] ${author}`;
  }
}

function getNotificationContent(notification: Notification): string {
  const record = notification.record as { text?: string } | undefined;

  if (record?.text) {
    return `<p>${escapeHtml(record.text)}</p>`;
  }

  // For likes/reposts/follows, include author info
  if (['like', 'repost', 'follow'].includes(notification.reason)) {
    let content = `<div class="bluesky-notification-author">`;
    if (notification.author.avatar) {
      content += `<img src="${notification.author.avatar}" alt="" style="width: 48px; height: 48px; border-radius: 50%;">`;
    }
    content += `<p><strong>${escapeHtml(notification.author.displayName || notification.author.handle)}</strong></p>`;
    if (notification.author.description) {
      content += `<p>${escapeHtml(notification.author.description)}</p>`;
    }
    content += `</div>`;
    return content;
  }

  return '';
}

export async function pollBlueskyNotifications(): Promise<DigestPost[]> {
  const config = getConfig();

  if (!config.bluesky_enabled) {
    logger.debug('Bluesky notifications polling disabled');
    return [];
  }

  const bskyAgent = await getAgent();

  if (!bskyAgent) {
    logger.warn('Bluesky not authenticated, skipping notification poll');
    return [];
  }

  logger.info('Polling Bluesky notifications...');

  try {
    // Fetch notifications
    const notifications = await bskyAgent.listNotifications({ limit: 50 });

    if (!notifications.success) {
      throw new Error('Failed to fetch Bluesky notifications');
    }

    const digestPosts: DigestPost[] = [];

    // Filter for relevant notification types
    const relevantTypes = ['reply', 'mention', 'quote'];

    for (const notification of notifications.data.notifications) {
      // Only process replies, mentions, and quotes as feed items
      // (likes, reposts, and follows are less important)
      if (!relevantTypes.includes(notification.reason)) {
        continue;
      }

      const title = getNotificationTitle(notification);
      const content = getNotificationContent(notification);
      const url = getNotificationUrl(notification);

      // Use CID as the unique identifier
      const postId = `notif_${notification.cid}`;

      digestPosts.push({
        postId,
        title,
        content,
        url,
        author: `@${notification.author.handle}`,
        publishedAt: new Date(notification.indexedAt),
        isNotification: true,
        rawJson: notification,
      });
    }

    // Mark notifications as seen
    if (notifications.data.notifications.length > 0) {
      try {
        await bskyAgent.updateSeenNotifications();
      } catch (err) {
        logger.warn('Failed to mark Bluesky notifications as seen:', err);
      }
    }

    logger.info(`Bluesky notifications poll complete: found ${digestPosts.length} notifications`);
    return digestPosts;
  } catch (err) {
    logger.error('Bluesky notifications polling failed:', err);
    throw err;
  }
}
