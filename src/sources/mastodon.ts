import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { DigestPost, PostMedia } from '../types/index.js';

/**
 * Shape of a Mastodon status returned by `GET /api/v1/timelines/home` and
 * `GET /api/v1/statuses/:id/context`. We only type the fields we actually
 * read — the rest pass through as `unknown`.
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

/** Mastodon 4.4+ quote payload. `quoted_status` is only present (non-null)
 *  when `state` is `"accepted"`. */
interface MastodonQuote {
  state: 'accepted' | 'rejected' | 'revoked' | 'pending' | 'deleted' | 'unauthorized';
  quoted_status?: MastodonStatus | null;
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
  /** Non-null when this status is a reply — ID of the parent status. */
  in_reply_to_id?: string | null;
  /** Instance ID of the author of the parent status, when it's a reply. */
  in_reply_to_account_id?: string | null;
  /** Mastodon 4.4+ native quote. */
  quote?: MastodonQuote | null;
  /** Pleroma/Akkoma-style quote shape (same object, different key). */
  pleroma?: { quote?: MastodonStatus | null };
  /** Some implementations just expose the URL. */
  quote_url?: string | null;
}

interface MastodonContext {
  ancestors: MastodonStatus[];
  descendants: MastodonStatus[];
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

/** Extract the quoted status from whichever field the instance exposes. */
function extractQuotedStatus(status: MastodonStatus): MastodonStatus | null {
  if (status.quote?.state === 'accepted' && status.quote.quoted_status) {
    return status.quote.quoted_status;
  }
  if (status.pleroma?.quote) {
    return status.pleroma.quote;
  }
  return null;
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

  // Recursively convert a quoted status when present.
  const quoted = extractQuotedStatus(status);
  const quotedPost = quoted ? statusToDigestPost(quoted, instanceHost) : undefined;

  return {
    postId: status.id,
    // Mastodon has no editorial title; the client (post-MAR-28) only renders
    // titles for Reddit/YouTube, so an empty string here is correct.
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
    quotedPost,
  };
}

/**
 * Fetch the reply context for a status. Returns `{ ancestors, descendants }`.
 * Errors are swallowed and returned as empty arrays — thread fetching is
 * best-effort and should never take down the whole poll.
 */
async function fetchContext(
  instanceBase: string,
  accessToken: string,
  statusId: string
): Promise<MastodonContext> {
  const url = `${instanceBase}/api/v1/statuses/${statusId}/context`;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      logger.debug(`Mastodon context fetch failed for ${statusId}: ${response.status}`);
      return { ancestors: [], descendants: [] };
    }
    const parsed = (await response.json()) as unknown;
    const ctx = parsed as MastodonContext;
    return {
      ancestors: Array.isArray(ctx.ancestors) ? ctx.ancestors : [],
      descendants: Array.isArray(ctx.descendants) ? ctx.descendants : [],
    };
  } catch (err) {
    logger.debug(`Mastodon context fetch threw for ${statusId}: ${(err as Error).message}`);
    return { ancestors: [], descendants: [] };
  }
}

/**
 * Build a root → ... → `leafStatus` tree from the leaf's ancestors. Mirrors
 * `buildThreadTree` in the Bluesky source. `repostedBy` is carried on the
 * leaf only (the repost reason targets the timeline entry, not its ancestors).
 */
function buildThreadTree(
  leafStatus: MastodonStatus,
  ancestors: MastodonStatus[],
  instanceHost: string,
  repostedBy?: string
): DigestPost {
  const leafNode = statusToDigestPost(leafStatus, instanceHost, repostedBy);
  if (ancestors.length === 0) return leafNode;

  // Mastodon returns ancestors in order root → ... → parent (oldest first);
  // wrap from the leaf upward so the outer node is the root and the leaf is
  // the deepest descendant.
  let tree: DigestPost = leafNode;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestorNode = statusToDigestPost(ancestors[i], instanceHost);
    ancestorNode.replies = [tree];
    tree = ancestorNode;
  }
  return tree;
}

/**
 * Merge `incoming.replies` into `existing.replies` by matching postId at each
 * depth. New replies are appended; existing replies recurse.
 */
function mergeIntoTree(existing: DigestPost, incoming: DigestPost): void {
  if (!incoming.replies) return;
  for (const incomingReply of incoming.replies) {
    const existingReply = existing.replies?.find(r => r.postId === incomingReply.postId);
    if (existingReply) {
      mergeIntoTree(existingReply, incomingReply);
    } else if (existing.replies) {
      existing.replies.push(incomingReply);
    } else {
      existing.replies = [incomingReply];
    }
  }
}

/** Collapse trees sharing the same root postId into a single tree. */
function mergeThreadsByRoot(posts: DigestPost[]): DigestPost[] {
  const rootMap = new Map<string, DigestPost>();
  const order: string[] = [];
  for (const post of posts) {
    const rootId = post.postId;
    if (!rootMap.has(rootId)) {
      rootMap.set(rootId, post);
      order.push(rootId);
    } else {
      mergeIntoTree(rootMap.get(rootId)!, post);
    }
  }
  return order.map(id => rootMap.get(id)!);
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
  const timelineUrl = `${instanceBase}/api/v1/timelines/home?limit=${limit}`;

  logger.info(`Polling Mastodon (${instanceHost}, limit=${limit})...`);

  let response: Response;
  try {
    response = await fetch(timelineUrl, {
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

  // Cache context fetches by leaf ID so two timeline entries that happen to
  // reply to the same conversation don't trigger a duplicate API call.
  const contextCache = new Map<string, MastodonContext>();
  async function getContextOnce(id: string): Promise<MastodonContext> {
    const cached = contextCache.get(id);
    if (cached) return cached;
    const ctx = await fetchContext(instanceBase, config.mastodon_access_token, id);
    contextCache.set(id, ctx);
    return ctx;
  }

  const digestPosts: DigestPost[] = [];

  for (const entry of statuses) {
    // Boosts: unwrap to the underlying status; `repostedBy` carries the booster.
    const isBoost = !!entry.reblog;
    const target: MastodonStatus = entry.reblog ?? entry;
    const repostedBy = isBoost
      ? (entry.account.display_name || entry.account.acct)
      : undefined;

    if (target.in_reply_to_id) {
      // Reply: fetch ancestors and build the root → ... → target tree.
      const ctx = await getContextOnce(target.id);
      const tree = buildThreadTree(target, ctx.ancestors, instanceHost, repostedBy);
      digestPosts.push(tree);
    } else {
      digestPosts.push(statusToDigestPost(target, instanceHost, repostedBy));
    }
  }

  // Collapse trees that share a root (e.g. replies A→B and A→C both in the
  // timeline → single tree A→[B,C]) — same pattern as Bluesky.
  const merged = mergeThreadsByRoot(digestPosts);

  logger.info(`Mastodon poll complete: ${merged.length} posts from ${instanceHost} (${digestPosts.length} before thread merge)`);
  return merged;
}
