import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { DigestPost, PostMedia } from '../types/index.js';

/**
 * Shape of a Mastodon status returned by `GET /api/v1/timelines/home`.
 * We only type the fields we actually read — the rest pass through as `unknown`.
 *
 * Ref: https://docs.joinmastodon.org/entities/Status/
 */
interface MastodonAccount {
  id: string;
  username: string;
  /**
   * For local accounts this is just `username`; for remote accounts
   * `username@remote.host`. We normalize to the `user@instance` form in the
   * author field below.
   */
  acct: string;
  display_name: string;
  avatar?: string;
  url?: string;
}

interface MastodonMediaAttachment {
  id: string;
  type: 'image' | 'video' | 'gifv' | 'audio' | 'unknown';
  url: string;
  preview_url?: string;
  remote_url?: string;
  description?: string | null;
}

interface MastodonStatus {
  id: string;
  created_at: string; // ISO 8601
  uri: string;
  url?: string;
  account: MastodonAccount;
  content: string; // HTML
  reblog?: MastodonStatus | null;
  media_attachments: MastodonMediaAttachment[];
  spoiler_text?: string;
}

/** Decode the minimal set of HTML entities Mastodon sprays through `content`. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–');
}

/** Mastodon returns `<p>…</p><p>…</p>` with `<br>` line breaks inside. */
function stripHtmlToPlainText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
      .replace(/<\/?p[^>]*>/gi, '')
      .replace(/<\/?span[^>]*>/gi, '')
      .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1') // keep link text, drop href
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Canonical form for the author field.
 *
 * For remote accounts Mastodon returns `username@remote.host`, for local
 * accounts just `username`. We always render `@user@host` so the origin
 * instance is visible in the client and matches the AP fediverse convention.
 */
function formatAuthor(account: MastodonAccount, instanceHost: string): string {
  if (account.acct.includes('@')) {
    return `@${account.acct}`;
  }
  return `@${account.acct}@${instanceHost}`;
}

function mapMedia(attachments: MastodonMediaAttachment[]): PostMedia[] {
  const out: PostMedia[] = [];
  for (const a of attachments) {
    const alt = a.description?.trim() || undefined;
    if (a.type === 'image') {
      out.push({
        type: 'image',
        url: a.url,
        thumbnailUrl: a.preview_url,
        alt,
      });
    } else if (a.type === 'video' || a.type === 'gifv') {
      out.push({
        type: 'video',
        url: a.url,
        thumbnailUrl: a.preview_url,
        alt,
      });
    }
    // `audio` / `unknown` intentionally skipped — we don't render those yet.
  }
  return out;
}

function statusToDigestPost(
  status: MastodonStatus,
  instanceHost: string,
  repostedBy?: string
): DigestPost {
  const plainText = stripHtmlToPlainText(status.content);
  const spoiler = status.spoiler_text?.trim();
  const content = spoiler ? `${spoiler}\n\n${plainText}` : plainText;

  const media = mapMedia(status.media_attachments);

  return {
    postId: status.id,
    // Mastodon has no editorial title; the client (post-MAR-28) only renders
    // titles for Reddit, so an empty string here is correct.
    title: '',
    content,
    url: status.url || status.uri,
    author: formatAuthor(status.account, instanceHost),
    publishedAt: new Date(status.created_at),
    rawJson: status,
    metadata: {
      avatarUrl: status.account.avatar || undefined,
      displayName: status.account.display_name || undefined,
      repostedBy,
    },
    media: media.length > 0 ? media : undefined,
  };
}

/**
 * Poll the authenticated user's home timeline. Throws on any failure so the
 * "Test Run" UI surfaces the actual error to the user (mirrors Bluesky /
 * Reddit). Disabled-source is the one silent case: returns `[]` so a
 * disabled source doesn't bring down a multi-source scheduled poll.
 */
export async function pollMastodon(): Promise<DigestPost[]> {
  const config = getConfig();

  if (!config.mastodon_enabled) {
    logger.debug('Mastodon polling disabled');
    return [];
  }
  if (!config.mastodon_instance_url) {
    throw new Error('Mastodon instance URL is not set. Enter it in Settings → Mastodon.');
  }
  if (!config.mastodon_access_token) {
    throw new Error('Mastodon access token is not set. Enter it in Settings → Mastodon.');
  }

  // Normalize the instance URL — strip trailing slash, add scheme if missing.
  const instanceBase = config.mastodon_instance_url
    .replace(/\/+$/, '')
    .replace(/^(?!https?:\/\/)/, 'https://');

  const instanceHost = instanceBase.replace(/^https?:\/\//, '');
  const limit = Math.max(1, Math.min(config.mastodon_top_n || 20, 40));
  const url = `${instanceBase}/api/v1/timelines/home?limit=${limit}`;

  logger.info(`Polling Mastodon (${instanceHost}, limit=${limit})...`);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.mastodon_access_token}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Mastodon request to ${instanceHost} failed: ${msg}`);
  }

  if (!response.ok) {
    // Grab a tiny slice of the body so auth and permissions errors are visible.
    let detail = '';
    try {
      const text = await response.text();
      detail = text ? `: ${text.slice(0, 200)}` : '';
    } catch { /* ignore */ }
    throw new Error(`Mastodon ${response.status} ${response.statusText}${detail}`);
  }

  let statuses: MastodonStatus[];
  try {
    const parsed = (await response.json()) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('response was not a JSON array');
    }
    statuses = parsed as MastodonStatus[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Mastodon returned unexpected data: ${msg}`);
  }

  const posts: DigestPost[] = statuses.map((s) => {
    // Boost (reblog): unwrap to the underlying status and surface the booster
    // via `repostedBy` — same pattern as Bluesky.
    if (s.reblog) {
      return statusToDigestPost(s.reblog, instanceHost, s.account.display_name || s.account.acct);
    }
    return statusToDigestPost(s, instanceHost);
  });

  logger.info(`Mastodon poll complete: ${posts.length} posts from ${instanceHost}`);
  return posts;
}
