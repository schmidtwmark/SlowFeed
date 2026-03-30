#!/usr/bin/env npx tsx
/**
 * CLI tool to test source polling and inspect structured JSON output.
 *
 * Usage:
 *   npx tsx scripts/poll-test.ts all \
 *     --reddit-cookies "..." \
 *     --bluesky-handle you.bsky.social --bluesky-password xxxx \
 *     --discord-token "..." --discord-channels '[{...}]' \
 *     --youtube-cookies "..." \
 *     --top-n 5
 *
 *   npx tsx scripts/poll-test.ts reddit --reddit-cookies "..."
 *   npx tsx scripts/poll-test.ts bluesky --bluesky-handle x --bluesky-password x
 */

import { parseArgs } from 'node:util';
import { setConfig } from '../src/config.js';
import type { DigestPost } from '../src/types/index.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'reddit-cookies':    { type: 'string' },
    'bluesky-handle':    { type: 'string' },
    'bluesky-password':  { type: 'string' },
    'discord-token':     { type: 'string' },
    'discord-channels':  { type: 'string' },
    'youtube-cookies':   { type: 'string' },
    'top-n':             { type: 'string', default: '5' },
    'comments':          { type: 'boolean', default: false },
    'comment-depth':     { type: 'string', default: '3' },
    'compact':           { type: 'boolean', default: false },
    'help':              { type: 'boolean', short: 'h', default: false },
  },
});

const source = positionals[0];
const ALL_SOURCES = ['reddit', 'bluesky', 'youtube', 'discord'] as const;

if (values.help || !source) {
  console.log(`Usage: npx tsx scripts/poll-test.ts <source> [options]

Sources:
  all         Run all sources that have credentials provided
  reddit      Requires --reddit-cookies
  bluesky     Requires --bluesky-handle and --bluesky-password
  youtube     Requires --youtube-cookies (Netscape cookie file format)
  discord     Requires --discord-token and --discord-channels

Credentials:
  --reddit-cookies <s>     Reddit cookie header string
  --bluesky-handle <s>     Bluesky handle (e.g. you.bsky.social)
  --bluesky-password <s>   Bluesky app password
  --discord-token <s>      Discord bot/user token
  --discord-channels <json> JSON array of {guildId, guildName, channelId, channelName}
  --youtube-cookies <s>    YouTube cookies in Netscape format

Options:
  --top-n <n>              Posts to fetch per source (default: 5)
  --comments               Include Reddit comments
  --comment-depth <n>      Reddit comment depth (default: 3)
  --compact                Compact JSON output
  -h, --help               Show this help`);
  process.exit(0);
}

const topN = parseInt(values['top-n'] || '5', 10);
const commentDepth = parseInt(values['comment-depth'] || '3', 10);

const hasReddit   = !!values['reddit-cookies'];
const hasBluesky  = !!values['bluesky-handle'] && !!values['bluesky-password'];
const hasYouTube  = !!values['youtube-cookies'];
const hasDiscord  = !!values['discord-token'] && !!values['discord-channels'];

const sources = source === 'all'
  ? ALL_SOURCES.filter(s => {
      if (s === 'reddit') return hasReddit;
      if (s === 'bluesky') return hasBluesky;
      if (s === 'youtube') return hasYouTube;
      if (s === 'discord') return hasDiscord;
      return false;
    })
  : [source];

if (source === 'all' && sources.length === 0) {
  console.error('No sources configured. Provide credentials for at least one source.');
  console.error('Run with --help for usage.');
  process.exit(1);
}

setConfig({
  reddit_enabled:           sources.includes('reddit'),
  reddit_cookies:           values['reddit-cookies'] || '',
  reddit_top_n:             topN,
  reddit_include_comments:  values.comments || false,
  reddit_comment_depth:     commentDepth,

  bluesky_enabled:          sources.includes('bluesky'),
  bluesky_handle:           values['bluesky-handle'] || '',
  bluesky_app_password:     values['bluesky-password'] || '',
  bluesky_top_n:            topN,

  youtube_enabled:          sources.includes('youtube'),
  youtube_cookies:          values['youtube-cookies'] || '',

  discord_enabled:          sources.includes('discord'),
  discord_token:            values['discord-token'] || '',
  discord_channels:         values['discord-channels'] || '[]',
  discord_top_n:            topN,
});

async function pollSource(name: string): Promise<DigestPost[]> {
  switch (name) {
    case 'reddit': {
      const { pollReddit } = await import('../src/sources/reddit.js');
      return await pollReddit();
    }
    case 'bluesky': {
      const { pollBluesky } = await import('../src/sources/bluesky.js');
      return await pollBluesky();
    }
    case 'youtube': {
      const { pollYouTube } = await import('../src/sources/youtube.js');
      return await pollYouTube();
    }
    case 'discord': {
      const { pollDiscord } = await import('../src/sources/discord.js');
      return await pollDiscord();
    }
    default:
      console.error(`Unknown source: ${name}`);
      return [];
  }
}

function printSummary(name: string, posts: Omit<DigestPost, 'rawJson'>[]) {
  console.error(`\n--- ${posts.length} posts from ${name} ---`);
  let htmlCount = 0;

  for (const post of posts) {
    const mediaCount = post.media?.length || 0;
    const linkCount = post.links?.length || 0;
    const commentCount = post.comments?.length || 0;
    const embedCount = post.embeds?.length || 0;
    const contentPreview = (post.content || '').substring(0, 80).replace(/\n/g, ' ');
    const hasHtml = /<[a-z][\s\S]*>/i.test(post.content || '');
    if (hasHtml) htmlCount++;

    console.error(
      `  ${post.postId.substring(0, 12).padEnd(12)} ` +
      `${(post.title || '').substring(0, 50).padEnd(50)} ` +
      `media=${mediaCount} links=${linkCount} comments=${commentCount} embeds=${embedCount}` +
      (hasHtml ? ' ⚠️  HTML' : '') +
      (contentPreview ? `\n    content: "${contentPreview}${post.content && post.content.length > 80 ? '...' : ''}"` : '')
    );
  }

  if (htmlCount > 0) {
    console.error(`  ⚠️  ${htmlCount}/${posts.length} posts contain HTML in content field`);
  }
}

async function run() {
  const results: Record<string, Omit<DigestPost, 'rawJson'>[]> = {};

  for (const name of sources) {
    console.error(`Polling ${name}...`);
    try {
      const posts = await pollSource(name);
      const clean = posts.map(({ rawJson, ...rest }) => rest);
      results[name] = clean;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${name} failed: ${msg}`);
      results[name] = [];
    }
  }

  // JSON output to stdout
  const output = sources.length === 1 ? results[sources[0]] : results;
  const indent = values.compact ? undefined : 2;
  console.log(JSON.stringify(output, null, indent));

  // Summaries to stderr
  for (const name of sources) {
    printSummary(name, results[name]);
  }

  const total = Object.values(results).reduce((n, posts) => n + posts.length, 0);
  if (sources.length > 1) {
    console.error(`\n=== Total: ${total} posts from ${sources.length} sources ===`);
  }
}

run().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
