import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { fetchInstagramPreview } from '../link-preview.js';
import type { DigestPost, PostMedia, PostEmbed } from '../types/index.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
}

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  guild_id?: string;
  /** True when the channel is marked Age-Restricted in Discord. */
  nsfw?: boolean;
}

interface DiscordUnfurledMedia {
  url: string;
  proxy_url?: string;
  content_type?: string;
  /** Present when the media was uploaded with the message, in which case it's
   *  also listed in `attachments`. */
  attachment_id?: string;
}

/** A Components V2 node, with only the fields we read. */
interface DiscordComponent {
  type: number;
  components?: DiscordComponent[];  // Action Row, Section, Container
  accessory?: DiscordComponent;     // Section
  content?: string;                 // Text Display
  media?: DiscordUnfurledMedia;     // Thumbnail
  description?: string;             // Thumbnail
  items?: Array<{ media: DiscordUnfurledMedia; description?: string }>;  // Media Gallery
  file?: DiscordUnfurledMedia;      // File
  name?: string;                    // File
  label?: string;                   // Button
  url?: string;                     // Button (link style)
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  /** 0 = default, 19 = reply; most others are system messages (joins, pins…). */
  type?: number;
  flags?: number;
  author: {
    id: string;
    username: string;
    discriminator: string;
    global_name?: string;
    avatar?: string;
  };
  content: string;
  timestamp: string;
  attachments: Array<{
    id: string;
    filename: string;
    url: string;
    content_type?: string;
  }>;
  embeds: Array<{
    type?: string;           // 'rich', 'image', 'video', 'link', 'article'
    title?: string;
    description?: string;
    url?: string;
    color?: number;
    image?: { url: string; width?: number; height?: number };
    thumbnail?: { url: string; width?: number; height?: number };
    video?: { url: string; width?: number; height?: number };
    author?: { name?: string; url?: string; icon_url?: string };
    provider?: { name?: string; url?: string };
    footer?: { text?: string; icon_url?: string };
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
  }>;
  /** With the IS_COMPONENTS_V2 flag, `content` and `embeds` are empty and the
   *  whole message lives here. Embed-fixing bots post their cards this way. */
  components?: DiscordComponent[];
  message_reference?: {
    message_id?: string;
    channel_id?: string;
    guild_id?: string;
  };
  /** A forward's own fields are empty; what was forwarded is in here. */
  message_snapshots?: Array<{
    message: Partial<Pick<DiscordMessage, 'content' | 'attachments' | 'embeds' | 'components'>>;
  }>;
}

const COMPONENT_BUTTON = 2;
const COMPONENT_TEXT_DISPLAY = 10;
const COMPONENT_THUMBNAIL = 11;
const COMPONENT_MEDIA_GALLERY = 12;
const COMPONENT_FILE = 13;

/** Message types that hold user or bot content, as opposed to system notices. */
const CONTENT_MESSAGE_TYPES = new Set([0, 19, 20, 23]);

interface SelectedChannel {
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
  /** Marked Age-Restricted in Discord. Older saved configs don't have this
   *  field — treat absent as `false`. */
  channelNSFW?: boolean;
}

function getDiscordToken(): string {
  try {
    const config = getConfig();
    return config.discord_token || '';
  } catch {
    return '';
  }
}

async function discordFetch<T>(endpoint: string, token?: string): Promise<T> {
  const authToken = token || getDiscordToken();

  if (!authToken) {
    throw new Error('Discord token not configured');
  }

  // Add timeout to prevent hanging
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

  try {
    const response = await fetch(`${DISCORD_API_BASE}${endpoint}`, {
      headers: {
        'Authorization': authToken,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Invalid Discord token');
      }
      if (response.status === 403) {
        throw new Error('Access forbidden - check permissions');
      }
      if (response.status === 429) {
        throw new Error('Rate limited - try again later');
      }
      throw new Error(`Discord API error: ${response.status}`);
    }

    return response.json() as Promise<T>;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Discord API timeout - try again');
    }
    throw err;
  }
}

export async function fetchGuilds(token?: string): Promise<DiscordGuild[]> {
  return discordFetch<DiscordGuild[]>('/users/@me/guilds', token);
}

export async function fetchChannels(guildId: string, token?: string): Promise<DiscordChannel[]> {
  const channels = await discordFetch<DiscordChannel[]>(`/guilds/${guildId}/channels`, token);
  // Filter to only text channels (type 0) and announcement channels (type 5)
  return channels.filter(ch => ch.type === 0 || ch.type === 5);
}

async function fetchMessages(channelId: string, limit: number = 50): Promise<DiscordMessage[]> {
  return discordFetch<DiscordMessage[]>(`/channels/${channelId}/messages?limit=${limit}`);
}

export async function testDiscordConnection(): Promise<{ success: boolean; error?: string; username?: string }> {
  try {
    const token = await getDiscordToken();
    if (!token) {
      return { success: false, error: 'Discord token not configured' };
    }

    // Try to get current user info
    const user = await discordFetch<{ id: string; username: string; global_name?: string }>('/users/@me', token);

    return {
      success: true,
      username: user.global_name || user.username
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Connection failed'
    };
  }
}

function getMessagePreview(content: string, mediaCount: number, embedCount: number): string {
  if (content) {
    const preview = content.substring(0, 100);
    return preview + (content.length > 100 ? '...' : '');
  }
  if (mediaCount > 0) {
    return `[${mediaCount} attachment(s)]`;
  }
  return `[${embedCount} embed(s)]`;
}

/** An embed's body text. Bot-built embeds often carry it all in `fields`. */
function embedText(embed: DiscordMessage['embeds'][0]): string | undefined {
  const fields = (embed.fields ?? []).map(field => `${field.name}: ${field.value}`);
  return [embed.description, ...fields].filter(Boolean).join('\n') || undefined;
}

/**
 * Reduce a card's Discord markdown to plain text. The client shows markdown
 * literally, apart from `[text](url)` links, which are left in place.
 */
function plainCardText(markdown: string): string {
  return markdown
    .replace(/^(?:#{1,3}\s+|-#\s+|>{1,3}\s?)/gm, '')  // headings, subtext, quotes
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/(^|\s)__(.+?)__(?=\s|$)/gm, '$1$2')
    .replace(/<a?:\w+:\d+>\s?/g, '')  // custom emoji
    .replace(/<t:(\d+)(?::\w)?>/g, (_, seconds) => new Date(Number(seconds) * 1000).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    }))
    .replace(/<(https?:[^>\s]+)>/g, '$1')  // also turns `[text](<url>)` into `[text](url)`
    .trim();
}

/** A gallery item or thumbnail as post media. Items uploaded with the message
 *  are skipped: they're already in `attachments`. */
function componentMedia(
  item: DiscordUnfurledMedia,
  attachmentIds: Set<string>,
  alt?: string,
): PostMedia | undefined {
  if (item.attachment_id && attachmentIds.has(item.attachment_id)) return undefined;
  // `attachment://` only means something inside Discord.
  const url = item.url?.startsWith('http') ? item.url : item.proxy_url;
  if (!url) return undefined;

  const isVideo = item.content_type?.startsWith('video/') || /\.(?:mp4|mov|webm|m4v)(?:[?#]|$)/i.test(url);
  // Only Discord's own proxy can produce a still frame.
  const proxied = item.proxy_url ?? (url.startsWith('https://cdn.discordapp.com/') ? url : undefined);
  return {
    type: isVideo ? 'video' : 'image',
    url,
    mimeType: item.content_type,
    ...(alt ? { alt } : {}),
    ...(isVideo && proxied ? { thumbnailUrl: discordVideoThumbnailURL(proxied) } : {}),
  };
}

/**
 * Flatten a Components V2 tree into text and media. Link buttons become
 * `[label](url)` spans at the end of the text. A thumbnail is usually just the
 * author's avatar beside the text, so it's only used when the card has nothing
 * else to show.
 */
function readComponents(
  components: DiscordComponent[],
  attachmentIds: Set<string>,
): { text: string; media: PostMedia[] } {
  const paragraphs: string[] = [];
  const links: string[] = [];
  const media: PostMedia[] = [];
  const thumbnails: PostMedia[] = [];

  const visit = (component: DiscordComponent): void => {
    const add = (list: PostMedia[], item: PostMedia | undefined) => {
      if (item) list.push(item);
    };
    if (component.type === COMPONENT_TEXT_DISPLAY && component.content) {
      const text = plainCardText(component.content);
      if (text) paragraphs.push(text);
    } else if (component.type === COMPONENT_MEDIA_GALLERY) {
      for (const item of component.items ?? []) {
        add(media, componentMedia(item.media, attachmentIds, item.description));
      }
    } else if (component.type === COMPONENT_THUMBNAIL && component.media) {
      add(thumbnails, componentMedia(component.media, attachmentIds, component.description));
    } else if (component.type === COMPONENT_FILE && component.file) {
      const url = component.file.url?.startsWith('http') ? component.file.url : component.file.proxy_url;
      const uploaded = component.file.attachment_id && attachmentIds.has(component.file.attachment_id);
      if (url && !uploaded) {
        media.push({ type: 'file', url, filename: component.name, mimeType: component.file.content_type });
      }
    } else if (component.type === COMPONENT_BUTTON && component.url && component.label) {
      links.push(`[${component.label.replace(/[[\]]/g, '')}](${component.url})`);
    }
    component.components?.forEach(visit);
    if (component.accessory) visit(component.accessory);
  };
  components.forEach(visit);

  if (links.length > 0) paragraphs.push(links.join(' · '));
  return {
    text: paragraphs.join('\n\n'),
    media: media.length > 0 || paragraphs.length > 0 ? media : thumbnails,
  };
}

/** The shape of a message we couldn't render, for the logs. No message text. */
function describeMessageShape(message: DiscordMessage): string {
  const componentTypes = (components: DiscordComponent[] = []): number[] =>
    components.flatMap(component => [component.type, ...componentTypes(component.components)]);
  return JSON.stringify({
    type: message.type,
    flags: message.flags,
    components: componentTypes(message.components),
    embedKeys: message.embeds?.map(embed => Object.keys(embed)),
    attachments: message.attachments?.length,
    snapshots: message.message_snapshots?.length,
  });
}

/**
 * Detect the source provider from a Discord embed's provider field or URL patterns
 */
function detectProvider(embed: DiscordMessage['embeds'][0]): string | null {
  const providerName = embed.provider?.name?.toLowerCase();
  if (providerName) {
    if (providerName.includes('twitter') || providerName.includes('x')) return 'Twitter';
    if (providerName.includes('youtube')) return 'YouTube';
    if (providerName.includes('instagram')) return 'Instagram';
    if (providerName.includes('bluesky') || providerName.includes('bsky')) return 'Bluesky';
    if (providerName.includes('reddit')) return 'Reddit';
    if (providerName.includes('tiktok')) return 'TikTok';
  }

  // Fall back to URL pattern matching
  const url = embed.url || '';
  if (/twitter\.com|x\.com|fxtwitter|vxtwitter|nitter/i.test(url)) return 'Twitter';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'YouTube';
  if (/instagram\.com|ddinstagram/i.test(url)) return 'Instagram';
  if (/bsky\.app|bsky\.social/i.test(url)) return 'Bluesky';
  if (/reddit\.com|redd\.it/i.test(url)) return 'Reddit';
  if (/tiktok\.com/i.test(url)) return 'TikTok';

  return null;
}

/**
 * Extract YouTube video ID from a URL
 */
function extractYouTubeVideoId(url: string): string | null {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
  return match?.[1] || null;
}

/**
 * Build a thumbnail URL for a Discord video attachment. Discord's
 * media proxy (`media.discordapp.net`) returns a JPEG still frame of
 * the video when the URL has `?format=jpeg`. The signed-CDN auth
 * params (`ex`, `is`, `hm`) carry over through the proxy unchanged.
 *
 * Returns `undefined` if the input isn't a parseable URL.
 */
function discordVideoThumbnailURL(videoUrl: string): string | undefined {
  try {
    const u = new URL(videoUrl);
    if (u.hostname === 'cdn.discordapp.com') {
      u.hostname = 'media.discordapp.net';
    }
    u.searchParams.set('format', 'jpeg');
    return u.toString();
  } catch {
    return undefined;
  }
}

/**
 * Instagram embeds render as quote cards. Mirrors like oginstagram send
 * Discord a "component embed", which the messages API returns as a bare
 * URL with no title, description or image — so when the embed is empty,
 * read the page's Open Graph tags ourselves. A reel's video goes into
 * `media` so it plays like an attachment.
 *
 * Returns `undefined` when there's nothing to show beyond the link.
 */
async function buildInstagramEmbed(
  embed: DiscordMessage['embeds'][0],
  media: PostMedia[],
): Promise<PostEmbed | undefined> {
  const isEmpty = !embed.title && !embed.description && !embed.image && !embed.thumbnail && !embed.video;
  const preview = isEmpty && embed.url ? await fetchInstagramPreview(embed.url) : undefined;

  const author = embed.author?.name ?? preview?.author;
  const text = embed.description ?? preview?.caption;
  const imageUrl = embed.image?.url ?? embed.thumbnail?.url ?? preview?.imageUrl;
  // Mirrors put an MP4 in `video`; an instagram.com one would be an HTML
  // embed page AVPlayer can't play.
  const discordVideo = embed.video?.url && !/^https?:\/\/(?:www\.)?instagram\.com\//i.test(embed.video.url)
    ? embed.video.url
    : undefined;
  const videoUrl = discordVideo ?? preview?.videoUrl;
  if (!author && !text && !embed.title && !imageUrl && !videoUrl) return undefined;

  if (videoUrl) {
    media.push({ type: 'video', url: videoUrl, thumbnailUrl: imageUrl });
  }
  return {
    type: 'quote',
    author,
    authorAvatarUrl: embed.author?.icon_url,
    text,
    title: embed.title,
    url: preview?.url ?? embed.url,
    // A video's thumbnail already shows the image.
    imageUrl: videoUrl ? undefined : imageUrl,
    provider: 'Instagram',
    publishedAt: preview?.publishedAt,
  };
}

export async function pollDiscord(): Promise<DigestPost[]> {
  const config = getConfig();

  if (!config.discord_enabled) {
    logger.debug('Discord polling disabled');
    return [];
  }

  const token = await getDiscordToken();
  if (!token) {
    logger.warn('Discord enabled but no token configured');
    return [];
  }

  let selectedChannels: SelectedChannel[] = [];
  try {
    selectedChannels = JSON.parse(config.discord_channels || '[]');
  } catch {
    logger.warn('Failed to parse discord_channels config');
    return [];
  }

  if (selectedChannels.length === 0) {
    logger.debug('No Discord channels selected');
    return [];
  }

  logger.info(`Polling Discord (${selectedChannels.length} channels)...`);

  const digestPosts: DigestPost[] = [];
  const topN = config.discord_top_n || 20;

  for (const channel of selectedChannels) {
    try {
      const messages = await fetchMessages(channel.channelId, topN);

      // Discord API returns newest first — reverse to chronological order
      messages.reverse();

      for (const message of messages) {
        const authorName = message.author.global_name || message.author.username;
        const messageUrl = `https://discord.com/channels/${channel.guildId}/${channel.channelId}/${message.id}`;
        const body = message.message_snapshots?.[0]?.message ?? message;
        const attachments = body.attachments ?? [];

        // Build Discord CDN avatar URL
        const avatarUrl = message.author.avatar
          ? `https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.png?size=64`
          : undefined;

        // Build media array from attachments
        const media: PostMedia[] = attachments.map(attachment => {
          let type: PostMedia['type'] = 'file';
          if (attachment.content_type?.startsWith('image/')) {
            type = 'image';
          } else if (attachment.content_type?.startsWith('video/')) {
            type = 'video';
          }
          // Discord doesn't ship a thumbnail in the attachment object,
          // but its media proxy (media.discordapp.net) returns a JPEG
          // still frame of a video when the URL has `?format=jpeg`.
          // The original signed-CDN auth params stay valid through the
          // proxy so the same `?ex=&is=&hm=` works.
          const thumbnailUrl = type === 'video'
            ? discordVideoThumbnailURL(attachment.url)
            : undefined;
          return {
            type,
            url: attachment.url,
            filename: attachment.filename,
            mimeType: attachment.content_type,
            thumbnailUrl,
          };
        });

        const card = readComponents(body.components ?? [], new Set(attachments.map(a => a.id)));
        media.push(...card.media);
        const content = [body.content, card.text].filter(Boolean).join('\n\n');

        // Build embeds array from Discord embeds with smart source detection
        const embeds: PostEmbed[] = [];
        for (const embed of body.embeds ?? []) {
          const title = embed.title ?? embed.author?.name;
          const description = embedText(embed);

          if (!title && !description && !embed.url) {
            // Nothing to make a card from, but bots do post embeds that are
            // just an image or video.
            const imageUrl = embed.image?.url ?? embed.thumbnail?.url;
            if (embed.video?.url) {
              media.push({ type: 'video', url: embed.video.url, thumbnailUrl: imageUrl });
            } else if (imageUrl) {
              media.push({ type: 'image', url: imageUrl });
            }
            continue;
          }

          const provider = detectProvider(embed);

          if (provider === 'YouTube' && embed.video) {
            // YouTube: extract video as PostMedia for inline playback
            const videoId = extractYouTubeVideoId(embed.url || embed.video.url);
            if (videoId) {
              media.push({
                type: 'video',
                url: embed.url || embed.video.url,
                thumbnailUrl: embed.thumbnail?.url || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
              });
            }
            // Also add as a link_card for title/description context
            embeds.push({
              type: 'link_card',
              title: embed.title,
              description: embed.description,
              url: embed.url,
              imageUrl: embed.thumbnail?.url,
              provider: 'YouTube',
            });
          } else if (provider === 'Instagram') {
            const instagram = await buildInstagramEmbed(embed, media);
            if (instagram) embeds.push(instagram);
          } else if (provider === 'Twitter' || provider === 'Bluesky') {
            // Social posts: render as quote embeds to show content inline
            embeds.push({
              type: 'quote',
              author: embed.author?.name,
              authorAvatarUrl: embed.author?.icon_url,
              text: embed.description,
              title: embed.title,
              url: embed.url,
              imageUrl: embed.image?.url || embed.thumbnail?.url,
              provider,
            });
          } else {
            // Generic link card
            embeds.push({
              type: 'link_card',
              title,
              description,
              url: embed.url,
              imageUrl: embed.image?.url || embed.thumbnail?.url,
              provider: provider || undefined,
            });
          }
        }

        if (!content && media.length === 0 && embeds.length === 0) {
          // A blank row helps nobody. System notices (joins, pins, boosts) are
          // expected here; anything else is a payload we don't read yet.
          const shape = describeMessageShape(message);
          if (message.type === undefined || CONTENT_MESSAGE_TYPES.has(message.type)) {
            logger.warn(`Discord: skipping message ${message.id} in #${channel.channelName} with nothing to show: ${shape}`);
          } else {
            logger.debug(`Discord: skipping system message ${message.id}: ${shape}`);
          }
          continue;
        }

        const preview = getMessagePreview(content, media.length, embeds.length);

        digestPosts.push({
          postId: message.id,
          title: `#${channel.channelName} - @${authorName}: ${preview}`,
          content,
          url: messageUrl,
          author: `@${authorName}`,
          publishedAt: new Date(message.timestamp),
          rawJson: message,
          metadata: {
            avatarUrl,
            guildName: channel.guildName,
            channelName: channel.channelName,
            replyToMessageId: message.message_reference?.message_id,
            ...(channel.channelNSFW === true ? { nsfw: true } : {}),
          },
          ...(media.length > 0 ? { media } : {}),
          ...(embeds.length > 0 ? { embeds } : {}),
        });
      }

      // Small delay between channels to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (err) {
      logger.error(`Failed to fetch messages from channel ${channel.channelId}:`, err);
    }
  }

  logger.info(`Discord poll complete: found ${digestPosts.length} messages`);
  return digestPosts;
}
