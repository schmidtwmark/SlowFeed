import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { DigestPost } from '../types/index.js';

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
    title?: string;
    description?: string;
    url?: string;
    image?: { url: string };
    thumbnail?: { url: string };
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMessageContent(message: DiscordMessage): string {
  let html = '';

  // Message text content
  if (message.content) {
    html += `<p style="line-height: 1.6; margin: 0 0 12px 0;">${escapeHtml(message.content)}</p>`;
  }

  // Attachments (images, files)
  for (const attachment of message.attachments) {
    if (attachment.content_type?.startsWith('image/')) {
      html += `<p style="margin: 8px 0;"><img src="${escapeHtml(attachment.url)}" alt="${escapeHtml(attachment.filename)}" style="max-width: 100%; border-radius: 8px;"></p>`;
    } else if (attachment.content_type?.startsWith('video/')) {
      html += `<p style="margin: 8px 0;"><video controls style="max-width: 100%; border-radius: 8px;"><source src="${escapeHtml(attachment.url)}" type="${escapeHtml(attachment.content_type)}"></video></p>`;
    } else {
      html += `<p style="margin: 8px 0;"><a href="${escapeHtml(attachment.url)}" style="color: #5865f2;">📎 ${escapeHtml(attachment.filename)}</a></p>`;
    }
  }

  // Embeds
  for (const embed of message.embeds) {
    html += `<div style="border-left: 4px solid #5865f2; padding: 8px 12px; margin: 8px 0; background: #f0f0f5; border-radius: 4px;">`;
    if (embed.title) {
      if (embed.url) {
        html += `<p style="margin: 0 0 4px 0;"><a href="${escapeHtml(embed.url)}" style="font-weight: bold; color: #5865f2;">${escapeHtml(embed.title)}</a></p>`;
      } else {
        html += `<p style="margin: 0 0 4px 0; font-weight: bold;">${escapeHtml(embed.title)}</p>`;
      }
    }
    if (embed.description) {
      html += `<p style="margin: 0; font-size: 14px; color: #333;">${escapeHtml(embed.description)}</p>`;
    }
    if (embed.image?.url) {
      html += `<p style="margin: 8px 0 0 0;"><img src="${escapeHtml(embed.image.url)}" style="max-width: 100%; border-radius: 4px;"></p>`;
    }
    if (embed.thumbnail?.url && !embed.image?.url) {
      html += `<p style="margin: 8px 0 0 0;"><img src="${escapeHtml(embed.thumbnail.url)}" style="max-width: 200px; border-radius: 4px;"></p>`;
    }
    html += `</div>`;
  }

  return html || '<p style="color: #999;">(empty message)</p>';
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

        digestPosts.push({
          postId: message.id,
          title: `#${channel.channelName} - @${authorName}: ${preview}`,
          content: formatMessageContent(message),
          url: messageUrl,
          author: `@${authorName}`,
          publishedAt: new Date(message.timestamp),
          rawJson: message,
          metadata: {
            guildName: channel.guildName,
            channelName: channel.channelName,
            replyToMessageId: message.message_reference?.message_id,
          },
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
