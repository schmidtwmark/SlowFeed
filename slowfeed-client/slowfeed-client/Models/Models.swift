import Foundation

// MARK: - Source Types

enum SourceType: String, Codable, CaseIterable, Identifiable {
    case reddit
    case bluesky
    case youtube
    case discord

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .reddit: return "Reddit"
        case .bluesky: return "Bluesky"
        case .youtube: return "YouTube"
        case .discord: return "Discord"
        }
    }

    var iconName: String {
        switch self {
        case .reddit: return "bubble.left.and.bubble.right"
        case .bluesky: return "cloud"
        case .youtube: return "play.rectangle"
        case .discord: return "message"
        }
    }

    var accentColor: String {
        switch self {
        case .reddit: return "#FF4500"
        case .bluesky: return "#0085FF"
        case .youtube: return "#FF0000"
        case .discord: return "#5865F2"
        }
    }
}

// MARK: - Digest Models

struct DigestSummary: Codable, Identifiable, Equatable {
    let id: String
    let source: SourceType
    let title: String
    let postCount: Int
    let publishedAt: Date
    let readAt: Date?

    var isRead: Bool { readAt != nil }

    enum CodingKeys: String, CodingKey {
        case id, source, title
        case postCount = "postCount"
        case publishedAt = "publishedAt"
        case readAt = "readAt"
    }
}

struct Digest: Codable, Identifiable {
    let id: String
    let source: SourceType
    let title: String
    let content: String  // HTML content
    let postCount: Int
    let postIds: [String]
    let publishedAt: Date
    let createdAt: Date
    let readAt: Date?
    let posts: [DigestPostReference]?

    var isRead: Bool { readAt != nil }

    enum CodingKeys: String, CodingKey {
        case id, source, title, content, posts
        case postCount = "post_count"
        case postIds = "post_ids"
        case publishedAt = "published_at"
        case createdAt = "created_at"
        case readAt = "read_at"
    }
}

struct DigestPostReference: Codable, Identifiable {
    let postId: String
    let source: String
    let title: String?

    var id: String { postId }
}

// MARK: - Source Configuration

struct SourceInfo: Codable, Identifiable {
    let id: String
    let name: String
    let enabled: Bool
}

// MARK: - Configuration

struct AppConfig: Codable {
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

    var feedTitle: String
    var feedTtlDays: Int
    var feedToken: String

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
        case feedTitle = "feed_title"
        case feedTtlDays = "feed_ttl_days"
        case feedToken = "feed_token"
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
