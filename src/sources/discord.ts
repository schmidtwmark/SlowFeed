import { getConfig } from '../config.js';
import { logger } from '../logger.js';
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
}

interface DiscordMessage {
  id: string;
  channel_id: string;
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
  message_reference?: {
    message_id?: string;
    channel_id?: string;
    guild_id?: string;
  };
}

interface SelectedChannel {
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
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

function getMessagePreview(message: DiscordMessage): string {
  if (message.content) {
    const preview = message.content.substring(0, 100);
    return preview + (message.content.length > 100 ? '...' : '');
  }
  if (message.attachments.length > 0) {
    return `[${message.attachments.length} attachment(s)]`;
  }
  if (message.embeds.length > 0) {
    return `[${message.embeds.length} embed(s)]`;
  }
  return '(empty message)';
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

      for (const message of messages) {
        const authorName = message.author.global_name || message.author.username;
        const preview = getMessagePreview(message);
        const messageUrl = `https://discord.com/channels/${channel.guildId}/${channel.channelId}/${message.id}`;

        // Build Discord CDN avatar URL
        const avatarUrl = message.author.avatar
          ? `https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.png?size=64`
          : undefined;

        // Build media array from attachments
        const media: PostMedia[] = message.attachments.map(attachment => {
          let type: PostMedia['type'] = 'file';
          if (attachment.content_type?.startsWith('image/')) {
            type = 'image';
          } else if (attachment.content_type?.startsWith('video/')) {
            type = 'video';
          }
          return {
            type,
            url: attachment.url,
            filename: attachment.filename,
            mimeType: attachment.content_type,
          };
        });

        // Build embeds array from Discord embeds with smart source detection
        const embeds: PostEmbed[] = [];
        for (const embed of message.embeds) {
          if (!embed.title && !embed.description && !embed.url) continue;

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
          } else if (provider === 'Twitter' || provider === 'Bluesky' || provider === 'Instagram') {
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
              title: embed.title,
              description: embed.description,
              url: embed.url,
              imageUrl: embed.image?.url || embed.thumbnail?.url,
              provider: provider || undefined,
            });
          }
        }

        digestPosts.push({
          postId: message.id,
          title: `#${channel.channelName} - @${authorName}: ${preview}`,
          content: message.content || '',
          url: messageUrl,
          author: `@${authorName}`,
          publishedAt: new Date(message.timestamp),
          rawJson: message,
          metadata: {
            avatarUrl,
            guildName: channel.guildName,
            channelName: channel.channelName,
            replyToMessageId: message.message_reference?.message_id,
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
