// Slowfeed Web UI

const API_BASE = '';
let sessionId = localStorage.getItem('sessionId');
let currentPage = 1;
let currentSource = '';
let feedToken = '';
let previewSimpleMode = false;

// API Helper
async function api(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (sessionId) {
    headers['X-Session-Id'] = sessionId;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    sessionId = null;
    localStorage.removeItem('sessionId');
    showLoginScreen();
    throw new Error('Unauthorized');
  }

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

// Screen Management
function showLoginScreen() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('main-screen').classList.add('hidden');
}

function showMainScreen() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('main-screen').classList.remove('hidden');

  // Route to the correct page based on URL
  routeToCurrentPage();
}

// URL-based Routing
function getPageFromPath(pathname) {
  const path = pathname || window.location.pathname;

  // Map URL paths to page IDs
  const routes = {
    '/': 'dashboard',
    '/dashboard': 'dashboard',
    '/schedules': 'schedules',
    '/settings': 'settings',
    '/settings/general': 'settings-general',
    '/settings/bluesky': 'settings-bluesky',
    '/settings/youtube': 'settings-youtube',
    '/settings/reddit': 'settings-reddit',
    '/settings/discord': 'settings-discord',
    '/feed-preview': 'feed-preview',
    '/logs': 'logs',
  };

  return routes[path] || 'dashboard';
}

function routeToCurrentPage() {
  const pageName = getPageFromPath();
  showPage(pageName, false); // Don't push state, we're already at this URL
}

function navigateTo(path) {
  history.pushState({}, '', path);
  const pageName = getPageFromPath(path);
  showPage(pageName, false);
}

function showPage(pageName, pushState = true) {
  // Hide all pages
  document.querySelectorAll('.page').forEach(page => {
    page.classList.add('hidden');
  });

  // Show the requested page
  const pageEl = document.getElementById(`page-${pageName}`);
  if (pageEl) {
    pageEl.classList.remove('hidden');
  }

  // Update active nav link
  document.querySelectorAll('nav a[data-page]').forEach(link => {
    link.classList.remove('active');
  });
  const activeLink = document.querySelector(`nav a[data-page="${pageName}"]`);
  if (activeLink) {
    activeLink.classList.add('active');
  }

  // Load page-specific data
  loadPageData(pageName);
}

async function loadPageData(pageName) {
  switch (pageName) {
    case 'dashboard':
      await loadDashboard();
      break;
    case 'schedules':
      await loadSchedules();
      break;
    case 'settings-general':
      await loadGeneralSettings();
      break;
    case 'settings-bluesky':
      await loadBlueskySettings();
      break;
    case 'settings-youtube':
      await loadYouTubeSettings();
      break;
    case 'settings-reddit':
      await loadRedditSettings();
      break;
    case 'settings-discord':
      await loadDiscordSettings();
      break;
    case 'feed-preview':
      await loadFeedPreview();
      break;
    case 'logs':
      await loadLogs();
      break;
  }
}

// Authentication
async function checkAuth() {
  if (!sessionId) {
    showLoginScreen();
    return;
  }

  try {
    const { authenticated } = await api('/api/auth/status');
    if (authenticated) {
      showMainScreen();
    } else {
      showLoginScreen();
    }
  } catch {
    showLoginScreen();
  }
}

async function login(password) {
  const data = await api('/api/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });

  sessionId = data.sessionId;
  localStorage.setItem('sessionId', sessionId);
  showMainScreen();
}

async function logout() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    // Ignore errors
  }

  sessionId = null;
  localStorage.removeItem('sessionId');
  showLoginScreen();
}

// Dashboard
async function loadDashboard() {
  try {
    const [stats, pollStatus, config] = await Promise.all([
      api('/api/stats'),
      api('/api/poll/status'),
      api('/api/config')
    ]);

    // Update feed token and URL display
    feedToken = config.feed_token || '';
    updateFeedUrl();

    document.getElementById('stat-total').textContent = stats.totalItems;
    document.getElementById('stat-reddit').textContent = stats.sourceCounts.reddit || 0;
    document.getElementById('stat-bluesky').textContent = stats.sourceCounts.bluesky || 0;
    document.getElementById('stat-youtube').textContent = stats.sourceCounts.youtube || 0;
    document.getElementById('stat-discord').textContent = stats.sourceCounts.discord || 0;

    // Update poll status for each source
    for (const source of ['reddit', 'bluesky', 'youtube', 'discord']) {
      const statusEl = document.getElementById(`status-${source}`);
      const status = pollStatus[source];
      if (statusEl && status) {
        updatePollStatusDisplay(source, status);
      }
    }

    const list = document.getElementById('recent-items-list');
    list.innerHTML = '';

    for (const item of stats.recentItems) {
      const li = document.createElement('li');
      li.className = 'recent-item';
      li.dataset.digestId = item.id;
      li.innerHTML = `
        <div class="recent-item-header" onclick="toggleRecentItem(this)">
          <span class="source-badge ${item.source}">${item.source}</span>
          <span class="item-title">${escapeHtml(item.title)}</span>
          <span class="item-meta">${item.post_count} items</span>
          <span class="expand-arrow">▶</span>
        </div>
        <div class="recent-item-content">
          <div class="recent-item-meta">
            <span>${new Date(item.published_at).toLocaleString()}</span>
          </div>
          <div class="recent-item-body"><em>Loading...</em></div>
        </div>
      `;
      list.appendChild(li);
    }
  } catch (err) {
    console.error('Failed to load dashboard:', err);
  }
}

function updatePollStatusDisplay(source, status) {
  const statusEl = document.getElementById(`status-${source}`);
  const btn = document.querySelector(`.poll-btn[data-source="${source}"]`);

  if (!statusEl) return;

  if (status.isPolling) {
    statusEl.textContent = 'Polling...';
    statusEl.className = 'poll-status polling';
    if (btn) {
      btn.classList.add('loading');
      btn.disabled = true;
    }
  } else if (status.lastError) {
    statusEl.textContent = `Error: ${status.lastError}`;
    statusEl.className = 'poll-status error';
    if (btn) {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  } else if (status.lastPoll) {
    const time = new Date(status.lastPoll).toLocaleTimeString();
    statusEl.textContent = `Last poll: ${time}`;
    statusEl.className = 'poll-status success';
    if (btn) {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  } else {
    statusEl.textContent = 'Not polled yet';
    statusEl.className = 'poll-status';
    if (btn) {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }
}

async function triggerPoll(source) {
  const btn = source ? document.querySelector(`.poll-btn[data-source="${source}"]`) : document.getElementById('refresh-all-btn');
  const statusEl = source ? document.getElementById(`status-${source}`) : null;

  try {
    if (btn) {
      btn.classList.add('loading');
      btn.disabled = true;
      btn.textContent = 'Polling';
    }
    if (statusEl) {
      statusEl.textContent = 'Polling...';
      statusEl.className = 'poll-status polling';
    }

    const body = source ? { source } : {};
    await api('/api/poll', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    await loadDashboard();

    if (statusEl) {
      const time = new Date().toLocaleTimeString();
      statusEl.textContent = `Completed at ${time}`;
      statusEl.className = 'poll-status success';
    }
  } catch (err) {
    console.error('Failed to trigger poll:', err);
    if (statusEl) {
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.className = 'poll-status error';
    } else {
      alert('Failed to trigger poll: ' + err.message);
    }
  } finally {
    if (btn) {
      btn.classList.remove('loading');
      btn.disabled = false;
      btn.textContent = 'Refresh';
    }
  }
}

// Clear data
async function clearSourceData(source) {
  if (!confirm(`Are you sure you want to clear all ${source} data?`)) {
    return;
  }

  const btn = document.querySelector(`.clear-btn[data-source="${source}"]`);
  if (btn) {
    btn.textContent = 'Clearing...';
    btn.disabled = true;
  }

  try {
    const result = await api(`/api/data/${source}`, { method: 'DELETE' });
    alert(`Cleared ${result.postsDeleted} saved posts and ${result.digestsDeleted} digests for ${source}.`);
    await loadDashboard();
  } catch (err) {
    alert('Failed to clear data: ' + err.message);
  } finally {
    if (btn) {
      btn.textContent = 'Clear';
      btn.disabled = false;
    }
  }
}

async function clearAllData() {
  if (!confirm('Are you sure you want to clear ALL data?')) {
    return;
  }

  const btn = document.getElementById('clear-all-btn');
  if (btn) {
    btn.textContent = 'Clearing...';
    btn.disabled = true;
  }

  try {
    const result = await api('/api/data', { method: 'DELETE' });
    alert(`Cleared ${result.postsDeleted} saved posts and ${result.digestsDeleted} digests.`);
    await loadDashboard();
  } catch (err) {
    alert('Failed to clear data: ' + err.message);
  } finally {
    if (btn) {
      btn.textContent = 'Clear All Data';
      btn.disabled = false;
    }
  }
}

// Settings - Individual page loaders
async function loadGeneralSettings() {
  try {
    const config = await api('/api/config');
    feedToken = config.feed_token || '';

    document.getElementById('feed_title').value = config.feed_title || '';
    document.getElementById('feed_ttl_days').value = config.feed_ttl_days || 14;
    document.getElementById('feed_token').value = config.feed_token || '';
    document.getElementById('ui_password').value = config.ui_password || '';
  } catch (err) {
    console.error('Failed to load general settings:', err);
  }
}

async function loadBlueskySettings() {
  try {
    const config = await api('/api/config');

    document.getElementById('bluesky_enabled').checked = config.bluesky_enabled || false;
    document.getElementById('bluesky_handle').value = config.bluesky_handle || '';
    document.getElementById('bluesky_app_password').value = config.bluesky_app_password || '';
    document.getElementById('bluesky_top_n').value = config.bluesky_top_n || 20;
  } catch (err) {
    console.error('Failed to load Bluesky settings:', err);
  }
}

async function loadYouTubeSettings() {
  try {
    const config = await api('/api/config');

    document.getElementById('youtube_enabled').checked = config.youtube_enabled || false;
    document.getElementById('youtube_cookies').value = config.youtube_cookies || '';
  } catch (err) {
    console.error('Failed to load YouTube settings:', err);
  }
}

async function loadRedditSettings() {
  try {
    const config = await api('/api/config');

    document.getElementById('reddit_enabled').checked = config.reddit_enabled || false;
    document.getElementById('reddit_cookies').value = config.reddit_cookies || '';
    document.getElementById('reddit_top_n').value = config.reddit_top_n || 30;
    document.getElementById('reddit_include_comments').checked = config.reddit_include_comments !== false;
    document.getElementById('reddit_comment_depth').value = config.reddit_comment_depth || 3;
  } catch (err) {
    console.error('Failed to load Reddit settings:', err);
  }
}

async function loadDiscordSettings() {
  try {
    const config = await api('/api/config');

    document.getElementById('discord_enabled').checked = config.discord_enabled || false;
    document.getElementById('discord_token').value = config.discord_token || '';
    document.getElementById('discord_top_n').value = config.discord_top_n || 20;
    document.getElementById('discord_channels').value = config.discord_channels || '[]';
    renderSelectedChannels();
  } catch (err) {
    console.error('Failed to load Discord settings:', err);
  }
}

// Save settings for each section
async function saveGeneralSettings(form) {
  const messageEl = document.getElementById('general-message');
  messageEl.textContent = 'Saving...';
  messageEl.className = 'section-message';

  try {
    const data = {
      feed_title: form.feed_title.value,
      feed_ttl_days: parseInt(form.feed_ttl_days.value, 10),
      ui_password: form.ui_password.value,
    };

    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify(data),
    });

    messageEl.textContent = 'Saved!';
    messageEl.className = 'section-message success';
    setTimeout(() => { messageEl.textContent = ''; }, 3000);
  } catch (err) {
    messageEl.textContent = 'Error: ' + err.message;
    messageEl.className = 'section-message error';
  }
}

async function saveBlueskySettings(form) {
  const messageEl = document.getElementById('bluesky-message');
  messageEl.textContent = 'Saving...';
  messageEl.className = 'section-message';

  try {
    const data = {
      bluesky_enabled: form.bluesky_enabled.checked,
      bluesky_handle: form.bluesky_handle.value,
      bluesky_app_password: form.bluesky_app_password.value,
      bluesky_top_n: parseInt(form.bluesky_top_n.value, 10),
    };

    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify(data),
    });

    messageEl.textContent = 'Saved!';
    messageEl.className = 'section-message success';
    setTimeout(() => { messageEl.textContent = ''; }, 3000);
  } catch (err) {
    messageEl.textContent = 'Error: ' + err.message;
    messageEl.className = 'section-message error';
  }
}

async function saveYouTubeSettings(form) {
  const messageEl = document.getElementById('youtube-message');
  messageEl.textContent = 'Saving...';
  messageEl.className = 'section-message';

  try {
    const data = {
      youtube_enabled: form.youtube_enabled.checked,
      youtube_cookies: form.youtube_cookies.value || '',
    };

    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify(data),
    });

    messageEl.textContent = 'Saved!';
    messageEl.className = 'section-message success';
    setTimeout(() => { messageEl.textContent = ''; }, 3000);
  } catch (err) {
    messageEl.textContent = 'Error: ' + err.message;
    messageEl.className = 'section-message error';
  }
}

async function saveRedditSettings(form) {
  const messageEl = document.getElementById('reddit-message');
  messageEl.textContent = 'Saving...';
  messageEl.className = 'section-message';

  try {
    const data = {
      reddit_enabled: form.reddit_enabled.checked,
      reddit_cookies: form.reddit_cookies.value || '',
      reddit_top_n: parseInt(form.reddit_top_n.value, 10),
      reddit_include_comments: form.reddit_include_comments.checked,
      reddit_comment_depth: parseInt(form.reddit_comment_depth.value, 10),
    };

    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify(data),
    });

    messageEl.textContent = 'Saved!';
    messageEl.className = 'section-message success';
    setTimeout(() => { messageEl.textContent = ''; }, 3000);
  } catch (err) {
    messageEl.textContent = 'Error: ' + err.message;
    messageEl.className = 'section-message error';
  }
}

async function saveDiscordSettings(form) {
  const messageEl = document.getElementById('discord-message');
  messageEl.textContent = 'Saving...';
  messageEl.className = 'section-message';

  try {
    const data = {
      discord_enabled: form.discord_enabled.checked,
      discord_token: form.discord_token.value || '',
      discord_top_n: parseInt(form.discord_top_n.value, 10),
      discord_channels: form.discord_channels.value || '[]',
    };

    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify(data),
    });

    messageEl.textContent = 'Saved!';
    messageEl.className = 'section-message success';
    setTimeout(() => { messageEl.textContent = ''; }, 3000);
  } catch (err) {
    messageEl.textContent = 'Error: ' + err.message;
    messageEl.className = 'section-message error';
  }
}

// Test source fetch
async function testSource(source) {
  const messageEl = document.getElementById(`${source}-message`);
  if (messageEl) {
    messageEl.textContent = 'Fetching...';
    messageEl.className = 'section-message';
  }

  try {
    const result = await api(`/api/test/${source}`, { method: 'POST' });

    if (messageEl) {
      messageEl.textContent = '';
    }

    showTestResults(source, result);
  } catch (err) {
    if (messageEl) {
      messageEl.textContent = 'Error: ' + err.message;
      messageEl.className = 'section-message error';
    }
  }
}

function showTestResults(source, result) {
  const modal = document.getElementById('test-results-modal');
  const title = document.getElementById('test-results-title');
  const content = document.getElementById('test-results-content');

  title.textContent = `${source.charAt(0).toUpperCase() + source.slice(1)} Test Results (${result.count} items)`;

  if (result.posts.length === 0) {
    content.innerHTML = '<p class="empty-state">No items found. Check your configuration and credentials.</p>';
  } else {
    let html = '<div class="test-results-list">';
    for (const post of result.posts) {
      html += `
        <div class="test-result-item">
          <div class="test-result-title">
            <a href="${escapeHtml(post.url)}" target="_blank">${escapeHtml(post.title)}</a>
          </div>
          <div class="test-result-meta">
            ${post.author ? `By ${escapeHtml(post.author)} • ` : ''}
            ${new Date(post.publishedAt).toLocaleString()}
          </div>
          ${post.contentPreview ? `<div class="test-result-preview">${escapeHtml(post.contentPreview)}</div>` : ''}
        </div>
      `;
    }
    html += '</div>';
    content.innerHTML = html;
  }

  modal.classList.remove('hidden');
}

function closeTestResults() {
  document.getElementById('test-results-modal').classList.add('hidden');
}

// Feed Preview - with lazy loading
async function loadFeedPreview() {
  const list = document.getElementById('feed-list');
  list.innerHTML = '<p class="loading">Loading...</p>';

  try {
    const params = new URLSearchParams({
      page: currentPage,
      limit: 20,
    });

    if (currentSource) {
      params.set('source', currentSource);
    }

    // First load just metadata (no content)
    const data = await api(`/api/feed-items?${params}`);

    list.innerHTML = '';

    for (const item of data.items) {
      const div = document.createElement('div');
      div.className = 'feed-item';
      div.dataset.digestId = item.id;
      div.innerHTML = `
        <div class="feed-item-header" onclick="toggleFeedItem(this)">
          <span class="source-badge ${item.source}">${item.source}</span>
          <span class="feed-item-title">${escapeHtml(item.title)}</span>
          <span class="expand-arrow">▶</span>
        </div>
        <div class="feed-item-details hidden">
          <div class="feed-item-meta">
            ${new Date(item.published_at).toLocaleString()}
          </div>
          <div class="feed-item-content">
            <em>Loading content...</em>
          </div>
        </div>
      `;
      list.appendChild(div);
    }

    // Update pagination
    const totalPages = Math.ceil(data.total / data.limit);
    document.getElementById('page-info').textContent = `Page ${currentPage} of ${totalPages || 1}`;
    document.getElementById('prev-page').disabled = currentPage <= 1;
    document.getElementById('next-page').disabled = currentPage >= totalPages;
  } catch (err) {
    console.error('Failed to load feed preview:', err);
    list.innerHTML = `<p class="error">Failed to load: ${escapeHtml(err.message)}</p>`;
  }
}

async function toggleFeedItem(header) {
  const item = header.closest('.feed-item');
  const details = item.querySelector('.feed-item-details');
  const isExpanding = details.classList.contains('hidden');

  details.classList.toggle('hidden');
  item.classList.toggle('expanded');

  // Lazy load content when expanding
  if (isExpanding && !item.dataset.loaded) {
    const digestId = item.dataset.digestId;
    const contentEl = item.querySelector('.feed-item-content');

    try {
      const data = await api(`/api/digest/${digestId}`);
      let content = data.content || '<em>No content</em>';

      // Apply simple mode if enabled
      if (previewSimpleMode) {
        content = simplifyHtml(content);
      }

      contentEl.innerHTML = content;
      item.dataset.loaded = 'true';
    } catch (err) {
      contentEl.innerHTML = `<em>Failed to load: ${escapeHtml(err.message)}</em>`;
    }
  }
}

// Simple HTML transformation (client-side version)
function simplifyHtml(html) {
  return html
    // Add separator before each post div (they have border and padding styles)
    .replace(/<div style="border:[^"]*padding:[^"]*>/gi, '<hr class="post-separator"><div>')
    // Convert YouTube iframes to links
    .replace(/<iframe[^>]*src="https:\/\/www\.youtube\.com\/embed\/([^"]+)"[^>]*>[\s\S]*?<\/iframe>/gi,
      '<p><a href="https://www.youtube.com/watch?v=$1">▶ Watch on YouTube</a></p>')
    // Convert video tags to links
    .replace(/<video[^>]*>[\s\S]*?<source[^>]*src="([^"]+)"[^>]*>[\s\S]*?<\/video>/gi,
      '<p><a href="$1">▶ View Video</a></p>')
    // Remove inline styles
    .replace(/\s*style="[^"]*"/gi, '')
    // Remove class attributes (but keep our separator class)
    .replace(/\s*class="(?!post-separator)[^"]*"/gi, '')
    // Simplify divs to paragraphs
    .replace(/<div[^>]*>/gi, '<p>')
    .replace(/<\/div>/gi, '</p>')
    // Remove empty paragraphs
    .replace(/<p>\s*<\/p>/gi, '')
    // Remove leading separator (first post doesn't need one)
    .replace(/^(\s*<[^>]*>\s*)*<hr class="post-separator">/i, '');
}

async function toggleRecentItem(header) {
  const item = header.closest('.recent-item');
  const isExpanding = !item.classList.contains('expanded');
  item.classList.toggle('expanded');

  if (isExpanding && !item.dataset.loaded) {
    const digestId = item.dataset.digestId;
    const bodyEl = item.querySelector('.recent-item-body');

    try {
      const data = await api(`/api/digest/${digestId}`);
      bodyEl.innerHTML = data.content || '<em>No content</em>';
      item.dataset.loaded = 'true';
    } catch (err) {
      bodyEl.innerHTML = `<em>Failed to load: ${escapeHtml(err.message)}</em>`;
    }
  }
}

// Utilities
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function buildFeedUrl() {
  const format = document.getElementById('feed-format-select')?.value || 'feed.xml';
  const simple = document.getElementById('feed-simple-mode')?.checked || false;

  let url = window.location.origin + '/' + format;
  const params = new URLSearchParams();

  if (feedToken) {
    params.set('token', feedToken);
  }
  if (simple) {
    params.set('simple', 'true');
  }

  const queryString = params.toString();
  if (queryString) {
    url += '?' + queryString;
  }

  return url;
}

function updateFeedUrl() {
  const urlInput = document.getElementById('feed-url-display');
  if (urlInput) {
    urlInput.value = buildFeedUrl();
  }
}

function copyFeedUrl() {
  const url = buildFeedUrl();
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.querySelector('.copy-btn');
    const originalText = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.textContent = originalText;
    }, 2000);
  }).catch(err => {
    alert('Failed to copy: ' + err.message);
  });
}

// Discord Functions
let discordGuilds = [];

function getSelectedChannels() {
  try {
    return JSON.parse(document.getElementById('discord_channels').value || '[]');
  } catch {
    return [];
  }
}

function setSelectedChannels(channels) {
  document.getElementById('discord_channels').value = JSON.stringify(channels);
}

function renderSelectedChannels() {
  const container = document.getElementById('discord-servers-container');
  if (!container) return;

  const selectedChannels = getSelectedChannels();

  if (selectedChannels.length === 0 && discordGuilds.length === 0) {
    container.innerHTML = '<p class="help-text">Click "Fetch Servers" to load your Discord servers</p>';
    return;
  }

  if (discordGuilds.length === 0 && selectedChannels.length > 0) {
    const grouped = {};
    for (const ch of selectedChannels) {
      if (!grouped[ch.guildId]) {
        grouped[ch.guildId] = { name: ch.guildName, channels: [] };
      }
      grouped[ch.guildId].channels.push(ch);
    }

    let html = '<div class="selected-channels-summary">';
    html += '<p><strong>Selected channels:</strong></p><ul>';
    for (const guildId of Object.keys(grouped)) {
      const guild = grouped[guildId];
      for (const ch of guild.channels) {
        html += `<li>${escapeHtml(guild.name)} / #${escapeHtml(ch.channelName)}</li>`;
      }
    }
    html += '</ul></div>';
    container.innerHTML = html;
    return;
  }

  renderServers();
}

function renderServers() {
  const container = document.getElementById('discord-servers-container');
  if (!container) return;

  const selectedChannels = getSelectedChannels();
  const selectedIds = new Set(selectedChannels.map(ch => ch.channelId));

  let html = '';
  for (const guild of discordGuilds) {
    const channelCount = guild.channels ? guild.channels.filter(ch => selectedIds.has(ch.id)).length : 0;
    const expanded = guild.expanded ? 'expanded' : '';
    const badge = channelCount > 0 ? `<span class="channel-count">(${channelCount} selected)</span>` : '';

    html += `<div class="discord-server ${expanded}" data-guild-id="${guild.id}">`;
    html += `<div class="server-header" onclick="toggleServer('${guild.id}')">`;
    html += `<span class="server-name">${escapeHtml(guild.name)}</span> ${badge}`;
    html += `<span class="expand-icon">${guild.expanded ? '▼' : '▶'}</span>`;
    html += '</div>';

    if (guild.expanded && guild.channels) {
      html += '<div class="server-channels">';
      for (const channel of guild.channels) {
        const checked = selectedIds.has(channel.id) ? 'checked' : '';
        html += `<label class="channel-item">`;
        html += `<input type="checkbox" ${checked} onchange="toggleChannel('${guild.id}', '${guild.name}', '${channel.id}', '${channel.name}', this.checked)">`;
        html += `#${escapeHtml(channel.name)}`;
        html += '</label>';
      }
      html += '</div>';
    } else if (guild.expanded && !guild.channels) {
      html += '<div class="server-channels"><p>Loading channels...</p></div>';
    }

    html += '</div>';
  }

  container.innerHTML = html || '<p class="help-text">No servers found</p>';
}

async function fetchDiscordServers() {
  const container = document.getElementById('discord-servers-container');
  container.innerHTML = '<p>Loading servers...</p>';

  try {
    const guilds = await api('/api/discord/guilds');
    discordGuilds = guilds.map(g => ({ ...g, expanded: false, channels: null }));
    renderServers();
  } catch (err) {
    container.innerHTML = `<p class="error">Failed to fetch servers: ${escapeHtml(err.message)}</p>`;
  }
}

async function toggleServer(guildId) {
  const guild = discordGuilds.find(g => g.id === guildId);
  if (!guild) return;

  guild.expanded = !guild.expanded;

  if (guild.expanded && !guild.channels) {
    renderServers();
    try {
      const channels = await api(`/api/discord/channels/${guildId}`);
      guild.channels = channels;
    } catch (err) {
      guild.channels = [];
      console.error('Failed to fetch channels:', err);
    }
  }

  renderServers();
}

function toggleChannel(guildId, guildName, channelId, channelName, checked) {
  const selectedChannels = getSelectedChannels();

  if (checked) {
    if (!selectedChannels.find(ch => ch.channelId === channelId)) {
      selectedChannels.push({ guildId, guildName, channelId, channelName });
    }
  } else {
    const index = selectedChannels.findIndex(ch => ch.channelId === channelId);
    if (index !== -1) {
      selectedChannels.splice(index, 1);
    }
  }

  setSelectedChannels(selectedChannels);
  renderServers();
}

// Logs Functions
let logsAutoRefreshInterval = null;
let currentLogLevelFilter = '';
let currentLogSourceFilter = '';

async function loadLogs() {
  const container = document.getElementById('logs-container');

  try {
    const logs = await api('/api/logs');
    renderLogs(logs);
  } catch (err) {
    container.innerHTML = `<div class="logs-placeholder">Failed to load logs: ${escapeHtml(err.message)}</div>`;
  }
}

function getLogSource(message) {
  const msg = message.toLowerCase();
  if (msg.includes('reddit')) return 'reddit';
  if (msg.includes('bluesky')) return 'bluesky';
  if (msg.includes('youtube')) return 'youtube';
  if (msg.includes('discord')) return 'discord';
  return 'system';
}

function renderLogs(logs) {
  const container = document.getElementById('logs-container');
  const levelFilter = currentLogLevelFilter;
  const sourceFilter = currentLogSourceFilter;

  let filteredLogs = logs;

  if (levelFilter) {
    filteredLogs = filteredLogs.filter(log => log.level.toLowerCase() === levelFilter);
  }

  if (sourceFilter) {
    filteredLogs = filteredLogs.filter(log => getLogSource(log.message) === sourceFilter);
  }

  if (filteredLogs.length === 0) {
    container.innerHTML = '<div class="logs-placeholder">No logs to display</div>';
    return;
  }

  const html = filteredLogs.map(log => {
    const time = new Date(log.timestamp).toLocaleTimeString();
    const level = log.level.toLowerCase();
    const source = getLogSource(log.message);
    return `
      <div class="log-entry" data-source="${source}">
        <span class="log-time">${time}</span>
        <span class="log-level ${level}">${level}</span>
        <span class="log-source ${source}">${source}</span>
        <span class="log-message">${escapeHtml(log.message)}</span>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

async function clearLogs() {
  try {
    await api('/api/logs/clear', { method: 'POST' });
    loadLogs();
  } catch (err) {
    console.error('Failed to clear logs:', err);
  }
}

function toggleLogsAutoRefresh(enabled) {
  if (enabled) {
    logsAutoRefreshInterval = setInterval(loadLogs, 2000);
  } else {
    if (logsAutoRefreshInterval) {
      clearInterval(logsAutoRefreshInterval);
      logsAutoRefreshInterval = null;
    }
  }
}

// Schedule Management
let schedules = [];

async function loadSchedules() {
  const container = document.getElementById('schedules-list');

  try {
    schedules = await api('/api/schedules');
    renderSchedules();
  } catch (err) {
    container.innerHTML = `<p class="error">Failed to load schedules: ${escapeHtml(err.message)}</p>`;
  }
}

function renderSchedules() {
  const container = document.getElementById('schedules-list');

  if (schedules.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No schedules configured yet.</p>
        <p>Click "Add Schedule" to create your first polling schedule.</p>
      </div>
    `;
    return;
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let html = '';
  for (const schedule of schedules) {
    const daysText = schedule.days_of_week.map(d => dayNames[d]).join(', ');
    const sourcesText = schedule.sources.join(', ');
    const time = schedule.time_of_day.substring(0, 5);
    const nextRun = schedule.nextRun ? new Date(schedule.nextRun).toLocaleString() : 'Not scheduled';
    const lastRun = schedule.lastRun ? new Date(schedule.lastRun).toLocaleString() : 'Never';
    const statusClass = schedule.enabled ? 'enabled' : 'disabled';
    const runningClass = schedule.isRunning ? 'running' : '';

    html += `
      <div class="schedule-card ${statusClass} ${runningClass}" data-schedule-id="${schedule.id}">
        <div class="schedule-header">
          <h3>${escapeHtml(schedule.name)}</h3>
          <div class="schedule-toggle">
            <label class="toggle">
              <input type="checkbox" ${schedule.enabled ? 'checked' : ''} onchange="toggleScheduleEnabled(${schedule.id}, this.checked)">
              <span class="slider"></span>
            </label>
          </div>
        </div>
        <div class="schedule-details">
          <p><strong>Time:</strong> ${time} (${schedule.timezone})</p>
          <p><strong>Days:</strong> ${daysText}</p>
          <p><strong>Sources:</strong> ${sourcesText}</p>
          <p><strong>Next run:</strong> ${nextRun}</p>
          <p><strong>Last run:</strong> ${lastRun}</p>
        </div>
        <div class="schedule-actions">
          <button class="secondary-btn" onclick="runScheduleNow(${schedule.id})" ${schedule.isRunning ? 'disabled' : ''}>
            ${schedule.isRunning ? 'Running...' : 'Run Now'}
          </button>
          <button class="secondary-btn" onclick="editSchedule(${schedule.id})">Edit</button>
          <button class="danger-btn" onclick="deleteSchedule(${schedule.id})">Delete</button>
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
}

function openScheduleModal(schedule = null) {
  const modal = document.getElementById('schedule-modal');
  const title = document.getElementById('schedule-modal-title');
  const form = document.getElementById('schedule-form');

  form.reset();

  if (schedule) {
    title.textContent = 'Edit Schedule';
    document.getElementById('schedule-id').value = schedule.id;
    document.getElementById('schedule-name').value = schedule.name;
    document.getElementById('schedule-time').value = schedule.time_of_day.substring(0, 5);
    document.getElementById('schedule-timezone').value = schedule.timezone;
    document.getElementById('schedule-enabled').checked = schedule.enabled;

    document.querySelectorAll('#schedule-form input[name="days"]').forEach(cb => {
      cb.checked = schedule.days_of_week.includes(parseInt(cb.value, 10));
    });

    document.querySelectorAll('#schedule-form input[name="sources"]').forEach(cb => {
      cb.checked = schedule.sources.includes(cb.value);
    });
  } else {
    title.textContent = 'Add Schedule';
    document.getElementById('schedule-id').value = '';
    selectDays([1, 2, 3, 4, 5]);
  }

  modal.classList.remove('hidden');
}

function closeScheduleModal() {
  document.getElementById('schedule-modal').classList.add('hidden');
}

function selectDays(days) {
  document.querySelectorAll('#schedule-form input[name="days"]').forEach(cb => {
    cb.checked = days.includes(parseInt(cb.value, 10));
  });
}

async function saveSchedule(formData) {
  const id = formData.get('id');
  const days = [];
  formData.getAll('days').forEach(d => days.push(parseInt(d, 10)));
  const sources = formData.getAll('sources');

  const data = {
    name: formData.get('name'),
    time_of_day: formData.get('time') + ':00',
    timezone: formData.get('timezone'),
    days_of_week: days,
    sources: sources,
    enabled: formData.get('enabled') === 'on',
  };

  try {
    if (id) {
      await api(`/api/schedules/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    } else {
      await api('/api/schedules', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    }

    closeScheduleModal();
    loadSchedules();
  } catch (err) {
    alert('Failed to save schedule: ' + err.message);
  }
}

function editSchedule(id) {
  const schedule = schedules.find(s => s.id === id);
  if (schedule) {
    openScheduleModal(schedule);
  }
}

async function deleteSchedule(id) {
  if (!confirm('Are you sure you want to delete this schedule?')) {
    return;
  }

  try {
    await api(`/api/schedules/${id}`, { method: 'DELETE' });
    loadSchedules();
  } catch (err) {
    alert('Failed to delete schedule: ' + err.message);
  }
}

async function toggleScheduleEnabled(id, enabled) {
  try {
    await api(`/api/schedules/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    loadSchedules();
  } catch (err) {
    alert('Failed to update schedule: ' + err.message);
    loadSchedules();
  }
}

async function runScheduleNow(id) {
  const btn = document.querySelector(`.schedule-card[data-schedule-id="${id}"] button:first-of-type`);
  if (btn) {
    btn.textContent = 'Running...';
    btn.disabled = true;
  }

  try {
    await api(`/api/schedules/${id}/run`, { method: 'POST' });
    loadSchedules();
    loadDashboard();
  } catch (err) {
    alert('Failed to run schedule: ' + err.message);
    loadSchedules();
  }
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
  // Login form
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('password-input').value;
    const errorEl = document.getElementById('login-error');

    try {
      await login(password);
      errorEl.textContent = '';
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  // Logout button
  document.getElementById('logout-btn').addEventListener('click', logout);

  // Mobile nav toggle
  const navToggle = document.getElementById('nav-toggle');
  const nav = document.querySelector('nav');
  if (navToggle && nav) {
    navToggle.addEventListener('click', () => {
      nav.classList.toggle('nav-open');
      navToggle.textContent = nav.classList.contains('nav-open') ? '✕' : '☰';
    });

    // Close nav when a link is clicked on mobile
    nav.querySelectorAll('a[href]').forEach(link => {
      link.addEventListener('click', () => {
        nav.classList.remove('nav-open');
        navToggle.textContent = '☰';
      });
    });
  }

  // Navigation - intercept link clicks for client-side routing
  document.querySelectorAll('nav a[href]').forEach(link => {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href');
      if (href && href.startsWith('/')) {
        e.preventDefault();
        navigateTo(href);
      }
    });
  });

  // Also handle settings nav card clicks
  document.querySelectorAll('.settings-nav-card').forEach(card => {
    card.addEventListener('click', (e) => {
      const href = card.getAttribute('href');
      if (href && href.startsWith('/')) {
        e.preventDefault();
        navigateTo(href);
      }
    });
  });

  // Handle browser back/forward
  window.addEventListener('popstate', () => {
    routeToCurrentPage();
  });

  // Poll buttons
  document.querySelectorAll('.poll-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      triggerPoll(btn.dataset.source);
    });
  });

  document.getElementById('refresh-all-btn').addEventListener('click', () => {
    triggerPoll();
  });

  // Clear buttons
  document.querySelectorAll('.clear-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      clearSourceData(btn.dataset.source);
    });
  });

  document.getElementById('clear-all-btn').addEventListener('click', () => {
    clearAllData();
  });

  // Settings forms
  const generalForm = document.getElementById('settings-general-form');
  if (generalForm) {
    generalForm.addEventListener('submit', (e) => {
      e.preventDefault();
      saveGeneralSettings(e.target);
    });
  }

  const blueskyForm = document.getElementById('settings-bluesky-form');
  if (blueskyForm) {
    blueskyForm.addEventListener('submit', (e) => {
      e.preventDefault();
      saveBlueskySettings(e.target);
    });
  }

  const youtubeForm = document.getElementById('settings-youtube-form');
  if (youtubeForm) {
    youtubeForm.addEventListener('submit', (e) => {
      e.preventDefault();
      saveYouTubeSettings(e.target);
    });
  }

  const redditForm = document.getElementById('settings-reddit-form');
  if (redditForm) {
    redditForm.addEventListener('submit', (e) => {
      e.preventDefault();
      saveRedditSettings(e.target);
    });
  }

  const discordForm = document.getElementById('settings-discord-form');
  if (discordForm) {
    discordForm.addEventListener('submit', (e) => {
      e.preventDefault();
      saveDiscordSettings(e.target);
    });
  }

  // Regenerate feed token
  const regenerateTokenBtn = document.getElementById('regenerate-token-btn');
  if (regenerateTokenBtn) {
    regenerateTokenBtn.addEventListener('click', async () => {
      if (!confirm('Are you sure? This will break existing RSS subscriptions.')) {
        return;
      }

      regenerateTokenBtn.disabled = true;
      regenerateTokenBtn.textContent = 'Regenerating...';

      try {
        const result = await api('/api/feed-token/regenerate', { method: 'POST' });
        feedToken = result.token;
        document.getElementById('feed_token').value = result.token;
        updateFeedUrl();
        alert('Feed token regenerated. Update your RSS reader with the new URL.');
      } catch (err) {
        alert('Failed to regenerate token: ' + err.message);
      } finally {
        regenerateTokenBtn.disabled = false;
        regenerateTokenBtn.textContent = 'Regenerate';
      }
    });
  }

  // Close test results modal
  document.getElementById('test-results-modal').addEventListener('click', (e) => {
    if (e.target.id === 'test-results-modal') {
      closeTestResults();
    }
  });

  // Feed preview controls
  const previewSourceFilter = document.getElementById('preview-source-filter');
  if (previewSourceFilter) {
    previewSourceFilter.addEventListener('change', (e) => {
      currentSource = e.target.value;
      currentPage = 1;
      loadFeedPreview();
    });
  }

  const previewSimpleModeCheckbox = document.getElementById('preview-simple-mode');
  if (previewSimpleModeCheckbox) {
    previewSimpleModeCheckbox.addEventListener('change', async (e) => {
      previewSimpleMode = e.target.checked;
      // Re-render all expanded items with new mode
      const expandedItems = document.querySelectorAll('.feed-item.expanded');
      for (const item of expandedItems) {
        const digestId = item.dataset.digestId;
        const contentEl = item.querySelector('.feed-item-content');
        if (digestId && contentEl) {
          try {
            const data = await api(`/api/digest/${digestId}`);
            let content = data.content || '<em>No content</em>';
            if (previewSimpleMode) {
              content = simplifyHtml(content);
            }
            contentEl.innerHTML = content;
          } catch (err) {
            // Keep existing content on error
          }
        }
      }
      // Also clear loaded state so collapsed items reload correctly when expanded
      document.querySelectorAll('.feed-item:not(.expanded)[data-loaded]').forEach(item => {
        delete item.dataset.loaded;
      });
    });
  }

  // Pagination
  document.getElementById('prev-page').addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      loadFeedPreview();
    }
  });

  document.getElementById('next-page').addEventListener('click', () => {
    currentPage++;
    loadFeedPreview();
  });

  // Discord test connection
  const discordTestBtn = document.getElementById('discord-test-btn');
  if (discordTestBtn) {
    discordTestBtn.addEventListener('click', async () => {
      const resultEl = document.getElementById('discord-test-result');

      discordTestBtn.disabled = true;
      discordTestBtn.textContent = 'Testing...';
      if (resultEl) {
        resultEl.textContent = 'Connecting to Discord...';
        resultEl.className = '';
      }

      try {
        const result = await api('/api/discord/test', { method: 'POST' });
        if (resultEl) {
          if (result.success) {
            resultEl.textContent = `Connected as ${result.username}!`;
            resultEl.className = 'success';
          } else {
            resultEl.textContent = 'Failed: ' + (result.error || 'Unknown error');
            resultEl.className = 'error';
          }
        }
      } catch (err) {
        if (resultEl) {
          resultEl.textContent = 'Error: ' + err.message;
          resultEl.className = 'error';
        }
      } finally {
        discordTestBtn.disabled = false;
        discordTestBtn.textContent = 'Test Connection';
      }
    });
  }

  // Discord fetch servers
  const discordFetchBtn = document.getElementById('discord-fetch-servers-btn');
  if (discordFetchBtn) {
    discordFetchBtn.addEventListener('click', async () => {
      discordFetchBtn.disabled = true;
      discordFetchBtn.textContent = 'Fetching...';

      try {
        await fetchDiscordServers();
      } finally {
        discordFetchBtn.disabled = false;
        discordFetchBtn.textContent = 'Fetch Servers';
      }
    });
  }

  // Logs page
  document.getElementById('refresh-logs-btn').addEventListener('click', loadLogs);
  document.getElementById('clear-logs-btn').addEventListener('click', clearLogs);

  document.getElementById('auto-refresh-logs').addEventListener('change', (e) => {
    toggleLogsAutoRefresh(e.target.checked);
  });

  document.getElementById('log-level-filter').addEventListener('change', (e) => {
    currentLogLevelFilter = e.target.value;
    loadLogs();
  });

  document.getElementById('log-source-filter').addEventListener('change', (e) => {
    currentLogSourceFilter = e.target.value;
    loadLogs();
  });

  // Schedule management
  document.getElementById('add-schedule-btn').addEventListener('click', () => {
    openScheduleModal();
  });

  document.getElementById('cancel-schedule-btn').addEventListener('click', () => {
    closeScheduleModal();
  });

  document.getElementById('schedule-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    saveSchedule(formData);
  });

  document.getElementById('schedule-modal').addEventListener('click', (e) => {
    if (e.target.id === 'schedule-modal') {
      closeScheduleModal();
    }
  });

  // Check authentication on load
  checkAuth();
});
