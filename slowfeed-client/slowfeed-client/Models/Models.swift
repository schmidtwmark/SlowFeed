import Foundation

// MARK: - Source Types

enum SourceType: String, Codable, CaseIterable, Identifiable {
    case reddit
    case bluesky
    case youtube
    case discord
    case mastodon
    case rss

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .reddit: return "Reddit"
        case .bluesky: return "Bluesky"
        case .youtube: return "YouTube"
        case .discord: return "Discord"
        case .mastodon: return "Mastodon"
        case .rss: return "RSS"
        }
    }

    var iconName: String {
        switch self {
        case .reddit: return "bubble.left.and.bubble.right"
        case .bluesky: return "cloud"
        case .youtube: return "play.rectangle"
        case .discord: return "message"
        case .mastodon: return "at"
        case .rss: return "dot.radiowaves.left.and.right"
        }
    }

    var accentColor: String {
        switch self {
        case .reddit: return "#FF4500"
        case .bluesky: return "#0085FF"
        case .youtube: return "#FF0000"
        case .discord: return "#5865F2"
        case .mastodon: return "#6364FF"
        case .rss: return "#FFA500"
        }
    }
}

// MARK: - Digest Models

struct DigestSummary: Codable, Identifiable, Equatable {
    let id: String
    let source: SourceType
    let title: String
    let postCount: Int
    let pollRunId: Int?
    /// Schedule name captured at poll-run time. Used by the sidebar
    /// `GroupHeaderRow` as the human label for the group ("Morning
    /// Brew" rather than "9:00 AM").
    let pollRunName: String?
    let publishedAt: Date
    let readAt: Date?
    /// Fraction (0–1) of the digest the user has scrolled through.
    /// Drives the partial-gray sidebar indicator. Defaults to 0 when
    /// the server omits it (older payloads).
    var readProgress: Double = 0

    /// Fully read = reached the end (readAt set). Distinct from
    /// "started" (readProgress > 0 but < 1).
    var isRead: Bool { readAt != nil }

    enum CodingKeys: String, CodingKey {
        case id, source, title
        case postCount = "postCount"
        case pollRunId = "pollRunId"
        case pollRunName = "pollRunName"
        case publishedAt = "publishedAt"
        case readAt = "readAt"
        case readProgress = "readProgress"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        source = try c.decode(SourceType.self, forKey: .source)
        title = try c.decode(String.self, forKey: .title)
        postCount = try c.decode(Int.self, forKey: .postCount)
        pollRunId = try c.decodeIfPresent(Int.self, forKey: .pollRunId)
        pollRunName = try c.decodeIfPresent(String.self, forKey: .pollRunName)
        publishedAt = try c.decode(Date.self, forKey: .publishedAt)
        readAt = try c.decodeIfPresent(Date.self, forKey: .readAt)
        readProgress = try c.decodeIfPresent(Double.self, forKey: .readProgress) ?? 0
    }

    init(id: String, source: SourceType, title: String, postCount: Int,
         pollRunId: Int?, pollRunName: String?, publishedAt: Date,
         readAt: Date?, readProgress: Double = 0) {
        self.id = id
        self.source = source
        self.title = title
        self.postCount = postCount
        self.pollRunId = pollRunId
        self.pollRunName = pollRunName
        self.publishedAt = publishedAt
        self.readAt = readAt
        self.readProgress = readProgress
    }

    /// Copy with updated read state.
    func withReadState(progress: Double, readAt: Date?) -> DigestSummary {
        DigestSummary(id: id, source: source, title: title, postCount: postCount,
                      pollRunId: pollRunId, pollRunName: pollRunName,
                      publishedAt: publishedAt, readAt: readAt, readProgress: progress)
    }
}

struct Digest: Codable, Identifiable {
    let id: String
    let source: SourceType
    let title: String
    let postCount: Int
    let postIds: [String]
    let publishedAt: Date
    let createdAt: Date
    let readAt: Date?
    let lastReadPostId: String?
    let posts: [DigestPost]?

    var isRead: Bool { readAt != nil }

    enum CodingKeys: String, CodingKey {
        case id, source, title, posts
        case postCount = "post_count"
        case postIds = "post_ids"
        case publishedAt = "published_at"
        case createdAt = "created_at"
        case readAt = "read_at"
        case lastReadPostId = "last_read_post_id"
    }
}

final class DigestPost: Codable, Identifiable {
    let postId: String
    let title: String
    let content: String?       // Plain text (no HTML)
    let url: String?
    let author: String?
    let publishedAt: Date?
    let isNotification: Bool?
    let metadata: PostMetadata?
    let media: [PostMedia]?
    let links: [PostLink]?
    let comments: [PostComment]?
    let embeds: [PostEmbed]?
    let replies: [DigestPost]?      // Child posts in thread (Bluesky)
    let quotedPost: DigestPost?     // Inline quoted post (Bluesky)

    var id: String { postId }
}

struct PostMedia: Codable {
    let type: String           // "image", "video", "file"
    let url: String
    let thumbnailUrl: String?
    let alt: String?
    let filename: String?
    let mimeType: String?
}

struct PostLink: Codable {
    let url: String
    let title: String?
    let description: String?
    let imageUrl: String?
}

struct PostComment: Codable {
    let author: String
    let body: String
    let score: Int
}

struct PostEmbed: Codable {
    let type: String           // "quote", "link_card"
    let title: String?
    let description: String?
    let url: String?
    let imageUrl: String?
    let author: String?
    let authorAvatarUrl: String?
    let text: String?
    let provider: String?      // "Twitter", "YouTube", "Instagram", "Bluesky"
    let publishedAt: Date?
}

struct PostMetadata: Codable {
    let avatarUrl: String?
    // Reddit
    let score: Int?
    let subreddit: String?
    let numComments: Int?
    /// Post link-flair label (e.g. "Discussion", "OC").
    let flair: String?
    /// Flair background as a CSS hex color ("#ff66ac") when the subreddit
    /// sets one; nil means render a neutral chip.
    let flairBackgroundColor: String?
    /// Reddit's flair text scheme: "light" (light text on dark bg) or
    /// "dark" (dark text on light bg).
    let flairTextColor: String?
    // YouTube
    let videoId: String?
    let channel: String?
    let channelUrl: String?
    let duration: String?
    let viewCount: String?
    let publishedText: String?
    // Discord
    let guildName: String?
    let channelName: String?
    let replyToMessageId: String?
    // Bluesky
    let displayName: String?
    let repostedBy: String?
    let rootUri: String?
    let parentUri: String?
    /// True when the upstream source flagged this post as NSFW / sensitive.
    /// Drives the blur in `MediaView` when the `Blur NSFW media` setting is on.
    let nsfw: Bool?
    // RSS
    /// Title of the source feed (e.g. "Daring Fireball"). Used for the
    /// header chip slot on RSS posts and as a secondary author label.
    let feedTitle: String?
    /// Full HTML body for RSS posts. The inline render uses the plain
    /// `content` field; the reader view renders this when present.
    let contentHTML: String?
    /// First `<img>` URL extracted from the RSS post body. Rendered
    /// above the post body in the digest as a hero preview — sized
    /// thumbnail or full per the user's `rssImageStyle` setting.
    let headerImageURL: String?
    /// Set on synthetic posts created by the server when polling a source
    /// fails. The client renders these with a warning icon + red accent
    /// so the user can see (and react to) failures inside the feed
    /// instead of having to dig through logs.
    let isError: Bool?
}

// MARK: - Test Poll Response

struct TestPollResponse: Codable {
    let source: SourceType
    let postCount: Int
    let posts: [DigestPost]
}

// MARK: - Saved Posts

struct SavedPostGroup: Codable, Identifiable {
    let source: SourceType
    let posts: [DigestPost]

    var id: String { source.rawValue }
}

struct SavedPostIdsResponse: Codable {
    let ids: [String]
}

// MARK: - Source Configuration

struct SourceInfo: Codable, Identifiable {
    let id: String
    let name: String
    let enabled: Bool
}

// MARK: - RSS

struct RSSFeed: Codable, Identifiable, Hashable {
    let id: Int
    let feedUrl: String
    let title: String
    let siteUrl: String?
    let enabled: Bool
    let lastFetchedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, title, enabled
        case feedUrl
        case siteUrl
        case lastFetchedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        enabled = try container.decode(Bool.self, forKey: .enabled)
        feedUrl = (try? container.decode(String.self, forKey: .feedUrl)) ?? ""
        siteUrl = try? container.decode(String?.self, forKey: .siteUrl)
        lastFetchedAt = try? container.decode(Date?.self, forKey: .lastFetchedAt)
    }
}

struct OPMLImportResult: Codable {
    let inserted: Int
    let skipped: Int
    let total: Int
}

/// Single hit from `/api/posts/search`. Carries enough context to
/// render a result row and to navigate to the matching post inside
/// its parent digest.
struct PostSearchResult: Codable, Identifiable {
    let digestId: String
    let source: SourceType
    let publishedAt: Date
    let pollRunId: Int?
    let postId: String
    let title: String
    let snippet: String
    let author: String?
    let url: String?

    /// SwiftUI identity. `postId` is only unique within a single
    /// digest, so the composite digestId+postId disambiguates the
    /// rare case where the same post id appears in multiple digests.
    var id: String { "\(digestId):\(postId)" }
}

struct PostSearchResponse: Codable {
    let results: [PostSearchResult]
}

/// Result of a dry-run feed fetch — used by Add Feed to preview what
/// items a URL will produce before the user commits to subscribing.
struct RSSFeedTestResult: Codable {
    let title: String
    let siteUrl: String?
    let description: String?
    let itemCount: Int
    let items: [RSSFeedTestItem]
}

struct RSSFeedTestItem: Codable, Identifiable {
    let title: String
    let snippet: String
    let url: String?
    let publishedAt: Date?

    var id: String { (url ?? "") + title + (publishedAt?.description ?? "") }
}

// MARK: - Configuration

struct AppConfig: Codable, Equatable {
    var blueskyEnabled: Bool
    var blueskyHandle: String
    var blueskyAppPassword: String
    var blueskyTopN: Int

    var youtubeEnabled: Bool
    var youtubeCookies: String

    var redditEnabled: Bool
    var redditCookies: String
    var redditTopN: Int
    var redditIncludeComments: Bool
    var redditCommentDepth: Int

    var discordEnabled: Bool
    var discordToken: String
    var discordChannels: [String]
    var discordTopN: Int

    var mastodonEnabled: Bool
    var mastodonInstanceURL: String
    var mastodonAccessToken: String
    var mastodonTopN: Int

    var rssEnabled: Bool

    var feedTtlDays: Int

    enum CodingKeys: String, CodingKey {
        case blueskyEnabled = "bluesky_enabled"
        case blueskyHandle = "bluesky_handle"
        case blueskyAppPassword = "bluesky_app_password"
        case blueskyTopN = "bluesky_top_n"
        case youtubeEnabled = "youtube_enabled"
        case youtubeCookies = "youtube_cookies"
        case redditEnabled = "reddit_enabled"
        case redditCookies = "reddit_cookies"
        case redditTopN = "reddit_top_n"
        case redditIncludeComments = "reddit_include_comments"
        case redditCommentDepth = "reddit_comment_depth"
        case discordEnabled = "discord_enabled"
        case discordToken = "discord_token"
        case discordChannels = "discord_channels"
        case discordTopN = "discord_top_n"
        case mastodonEnabled = "mastodon_enabled"
        case mastodonInstanceURL = "mastodon_instance_url"
        case mastodonAccessToken = "mastodon_access_token"
        case mastodonTopN = "mastodon_top_n"
        case rssEnabled = "rss_enabled"
        case feedTtlDays = "feed_ttl_days"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        // Decode with defaults for missing values
        blueskyEnabled = (try? container.decode(Bool.self, forKey: .blueskyEnabled)) ?? false
        blueskyHandle = (try? container.decode(String.self, forKey: .blueskyHandle)) ?? ""
        blueskyAppPassword = (try? container.decode(String.self, forKey: .blueskyAppPassword)) ?? ""
        blueskyTopN = (try? container.decode(Int.self, forKey: .blueskyTopN)) ?? 20

        youtubeEnabled = (try? container.decode(Bool.self, forKey: .youtubeEnabled)) ?? false
        youtubeCookies = (try? container.decode(String.self, forKey: .youtubeCookies)) ?? ""

        redditEnabled = (try? container.decode(Bool.self, forKey: .redditEnabled)) ?? false
        redditCookies = (try? container.decode(String.self, forKey: .redditCookies)) ?? ""
        redditTopN = (try? container.decode(Int.self, forKey: .redditTopN)) ?? 30
        redditIncludeComments = (try? container.decode(Bool.self, forKey: .redditIncludeComments)) ?? true
        redditCommentDepth = (try? container.decode(Int.self, forKey: .redditCommentDepth)) ?? 3

        discordEnabled = (try? container.decode(Bool.self, forKey: .discordEnabled)) ?? false
        discordToken = (try? container.decode(String.self, forKey: .discordToken)) ?? ""
        discordChannels = (try? container.decode([String].self, forKey: .discordChannels)) ?? []
        discordTopN = (try? container.decode(Int.self, forKey: .discordTopN)) ?? 20

        mastodonEnabled = (try? container.decode(Bool.self, forKey: .mastodonEnabled)) ?? false
        mastodonInstanceURL = (try? container.decode(String.self, forKey: .mastodonInstanceURL)) ?? ""
        mastodonAccessToken = (try? container.decode(String.self, forKey: .mastodonAccessToken)) ?? ""
        mastodonTopN = (try? container.decode(Int.self, forKey: .mastodonTopN)) ?? 20

        rssEnabled = (try? container.decode(Bool.self, forKey: .rssEnabled)) ?? false

        feedTtlDays = (try? container.decode(Int.self, forKey: .feedTtlDays)) ?? 14
    }
}

// MARK: - Schedule Models

struct PollSchedule: Codable, Identifiable {
    let id: Int
    let name: String
    let daysOfWeek: [Int]
    let timeOfDay: String
    let timezone: String
    let sources: [SourceType]
    let enabled: Bool
    let createdAt: Date
    let updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id, name, timezone, sources, enabled
        case daysOfWeek = "days_of_week"
        case timeOfDay = "time_of_day"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

// MARK: - Schedule Input

struct ScheduleInput: Codable {
    var name: String
    var days_of_week: [Int]
    var time_of_day: String
    var timezone: String
    var sources: [SourceType]
    var enabled: Bool
}

// MARK: - Log Models

struct LogEntry: Codable, Identifiable {
    let timestamp: String
    let level: String
    let message: String

    var id: String { "\(timestamp)-\(message.prefix(50))" }
}

// MARK: - Auth Models

struct SetupStatus: Codable {
    let setupComplete: Bool
}

struct AuthResponse: Codable {
    let success: Bool
    let sessionId: String?
    let error: String?
}

struct PasskeyCredential: Codable, Identifiable {
    let id: String
    let name: String?
    let deviceType: String
    let backedUp: Bool
    let createdAt: Date
    let lastUsedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, name, deviceType, backedUp
        case createdAt = "createdAt"
        case lastUsedAt = "lastUsedAt"
    }
}

// MARK: - API Response Types

struct SuccessResponse: Codable {
    let success: Bool
}

struct ErrorResponse: Codable {
    let error: String
}
