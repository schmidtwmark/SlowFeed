#if DEBUG
import Foundation

/// Factories for mock ``DigestPost`` instances used by SwiftUI previews.
///
/// `DigestPost` is a `Codable`-only class with a long list of optional fields,
/// so we build instances by assembling a dictionary and round-tripping through
/// `JSONDecoder`. This mirrors the shape the server sends, and keeps the
/// production model file free of preview-specific initializers.
enum PreviewPost {
    static func make(
        postId: String = "preview-1",
        title: String = "Sample title",
        content: String? = nil,
        url: String? = "https://example.com/post",
        author: String? = nil,
        displayName: String? = nil,
        avatarUrl: String? = nil,
        subreddit: String? = nil,
        score: Int? = nil,
        numComments: Int? = nil,
        channel: String? = nil,
        channelName: String? = nil,
        repostedBy: String? = nil,
        duration: String? = nil,
        isNotification: Bool = false,
        publishedAt: Date = Date(timeIntervalSince1970: 1_776_339_600), // Apr 16 2026 19:40 UTC
        media: [MediaSpec] = [],
        links: [LinkSpec] = [],
        embeds: [EmbedSpec] = [],
        comments: [CommentSpec] = [],
        quotedPost: DigestPost? = nil
    ) -> DigestPost {
        var dict: [String: Any] = [
            "postId": postId,
            "title": title,
        ]
        if let content { dict["content"] = content }
        if let url { dict["url"] = url }
        if let author { dict["author"] = author }
        dict["publishedAt"] = isoString(publishedAt)
        if isNotification { dict["isNotification"] = true }

        var meta: [String: Any] = [:]
        if let displayName { meta["displayName"] = displayName }
        if let avatarUrl { meta["avatarUrl"] = avatarUrl }
        if let subreddit { meta["subreddit"] = subreddit }
        if let score { meta["score"] = score }
        if let numComments { meta["numComments"] = numComments }
        if let channel { meta["channel"] = channel }
        if let channelName { meta["channelName"] = channelName }
        if let repostedBy { meta["repostedBy"] = repostedBy }
        if let duration { meta["duration"] = duration }
        if !meta.isEmpty { dict["metadata"] = meta }

        if !media.isEmpty { dict["media"] = media.map { $0.dictionary() } }
        if !links.isEmpty { dict["links"] = links.map { $0.dictionary() } }
        if !embeds.isEmpty { dict["embeds"] = embeds.map { $0.dictionary() } }
        if !comments.isEmpty { dict["comments"] = comments.map { $0.dictionary() } }

        let post = decode(dict)
        // `quotedPost` is a nested DigestPost; we set it via reflection-free
        // assignment by re-decoding the parent with the quoted post's JSON embedded.
        if let quotedPost {
            return attachQuotedPost(quotedPost, to: dict)
        }
        return post
    }

    struct MediaSpec {
        var type: String = "image"
        var url: String
        var thumbnailUrl: String? = nil
        var audioUrl: String? = nil
        var alt: String? = nil

        func dictionary() -> [String: Any] {
            var d: [String: Any] = ["type": type, "url": url]
            if let thumbnailUrl { d["thumbnailUrl"] = thumbnailUrl }
            if let audioUrl { d["audioUrl"] = audioUrl }
            if let alt { d["alt"] = alt }
            return d
        }
    }

    struct LinkSpec {
        var url: String
        var title: String? = nil
        var description: String? = nil
        var imageUrl: String? = nil

        func dictionary() -> [String: Any] {
            var d: [String: Any] = ["url": url]
            if let title { d["title"] = title }
            if let description { d["description"] = description }
            if let imageUrl { d["imageUrl"] = imageUrl }
            return d
        }
    }

    struct EmbedSpec {
        var type: String
        var title: String? = nil
        var description: String? = nil
        var url: String? = nil
        var imageUrl: String? = nil
        var author: String? = nil
        var authorAvatarUrl: String? = nil
        var text: String? = nil
        var provider: String? = nil

        func dictionary() -> [String: Any] {
            var d: [String: Any] = ["type": type]
            if let title { d["title"] = title }
            if let description { d["description"] = description }
            if let url { d["url"] = url }
            if let imageUrl { d["imageUrl"] = imageUrl }
            if let author { d["author"] = author }
            if let authorAvatarUrl { d["authorAvatarUrl"] = authorAvatarUrl }
            if let text { d["text"] = text }
            if let provider { d["provider"] = provider }
            return d
        }
    }

    struct CommentSpec {
        var author: String
        var body: String
        var score: Int = 0
        func dictionary() -> [String: Any] {
            ["author": author, "body": body, "score": score]
        }
    }

    // MARK: - Private

    private static func decode(_ dict: [String: Any]) -> DigestPost {
        do {
            let data = try JSONSerialization.data(withJSONObject: dict)
            return try makeDecoder().decode(DigestPost.self, from: data)
        } catch {
            fatalError("PreviewPost.decode failed: \(error)")
        }
    }

    private static func attachQuotedPost(_ quoted: DigestPost, to parent: [String: Any]) -> DigestPost {
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            let quotedData = try encoder.encode(quoted)
            let quotedObj = try JSONSerialization.jsonObject(with: quotedData)
            var parentCopy = parent
            parentCopy["quotedPost"] = quotedObj
            let data = try JSONSerialization.data(withJSONObject: parentCopy)
            return try makeDecoder().decode(DigestPost.self, from: data)
        } catch {
            fatalError("PreviewPost.attachQuotedPost failed: \(error)")
        }
    }

    private static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let s = try container.decode(String.self)
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = f.date(from: s) { return d }
            f.formatOptions = [.withInternetDateTime]
            if let d = f.date(from: s) { return d }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "bad date: \(s)")
        }
        return decoder
    }

    private static func isoString(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.string(from: date)
    }
}

/// Ready-made post fixtures matching the real failure modes we've been
/// iterating on. Add more as needed — previews should cover each visual state
/// you want to keep looking good.
enum PreviewPostSamples {
    /// ~2 hours ago → "Today at <time>" in the footer.
    static var recentToday: Date { Date().addingTimeInterval(-2 * 3600) }
    /// ~28 hours ago → "Yesterday at <time>" in the footer.
    static var yesterday: Date { Date().addingTimeInterval(-28 * 3600) }
    /// Fixed older date → renders as the abbreviated full date.
    static let olderDate = Date(timeIntervalSince1970: 1_776_339_600) // Apr 16 2026 19:40 UTC

    /// Reddit post with a long hyphenated username and a subreddit chip.
    /// Reproduces MAR-17 (author wrapping at hyphen).
    static var redditLongHandle: DigestPost {
        PreviewPost.make(
            postId: "reddit-long",
            title: "Vic Michaelis Cast in New 'Star Wars' Game 'Zero Company'",
            content: "Vic Michaelis Cast in New 'Star Wars' Game 'Zero Company'",
            url: "https://reddit.com/r/dropout/comments/xyz",
            author: "u/MarvelsGrant-Man136",
            subreddit: "dropout",
            score: 1927,
            numComments: 213,
            publishedAt: recentToday
        )
    }

    /// Bluesky repost, quoted article. Reproduces the repost + quote layout.
    static var blueskyRepost: DigestPost {
        PreviewPost.make(
            postId: "bsky-repost",
            title: "@olufemiotaiwo.bsky.social: wouldn't mind several orders of magnitude more of this",
            content: "wouldn't mind several orders of magnitude more of this",
            author: "@olufemiotaiwo.bsky.social",
            displayName: "Olúfẹ́mi O. Táíwò",
            repostedBy: "lauren",
            publishedAt: yesterday,
            embeds: [
                .init(
                    type: "quote",
                    description: "A nationwide warrant has been issued in the first criminal charges against an ICE agent for on-duty actions during the enforcement surge in Minnesota.",
                    url: "https://startribune.com/article",
                    author: "Minnesota Star Tribune @startribune.com",
                    provider: "Bluesky"
                )
            ]
        )
    }

    /// Discord post with channel chip. Reproduces the title-duplication case.
    static var discordMeme: DigestPost {
        PreviewPost.make(
            postId: "discord-meme",
            title: "#funny-internet-videos-and-memes - @Definently Dingo: Bdcuase snickers looks normal, spelt correctly the packaging is wrong",
            content: "Bdcuase snickers looks normal, spelt correctly the packaging is wrong",
            author: "@Definently Dingo",
            channelName: "funny-internet-videos-and-memes",
            publishedAt: recentToday
        )
    }

    /// Bluesky notification — drives the bell-icon chip.
    static var blueskyNotification: DigestPost {
        PreviewPost.make(
            postId: "bsky-notif",
            title: "Reply from alice",
            content: "Thanks for sharing this!",
            author: "@alice.bsky.social",
            displayName: "Alice",
            isNotification: true,
            publishedAt: recentToday
        )
    }

    /// Reddit post with one inline image and a body.
    static var redditImagePost: DigestPost {
        PreviewPost.make(
            postId: "reddit-img",
            title: "Check out this view",
            content: "Caught this yesterday on the trail.",
            author: "u/hiker42",
            subreddit: "EarthPorn",
            score: 5400,
            numComments: 88,
            publishedAt: yesterday,
            media: [
                .init(url: "https://picsum.photos/seed/slowfeed1/800/600",
                      alt: "Mountain landscape at sunset with alpenglow on the peaks")
            ]
        )
    }

    /// Bluesky gallery with alt text on each image.
    static var blueskyGallery: DigestPost {
        PreviewPost.make(
            postId: "bsky-gallery",
            title: "A little series",
            content: "Three photos from my walk today.",
            author: "@photo.bsky.social",
            displayName: "Photo Person",
            publishedAt: olderDate,
            media: [
                .init(url: "https://picsum.photos/seed/slowfeed2/800/600",
                      alt: "A red fox crossing a snowy field"),
                .init(url: "https://picsum.photos/seed/slowfeed3/800/600",
                      alt: "Bare maple trees silhouetted against a pink dawn sky"),
                .init(url: "https://picsum.photos/seed/slowfeed4/800/600",
                      alt: "Close-up of frost crystals on a fallen leaf")
            ]
        )
    }

    /// Reddit text-only self post (no media).
    static var redditTextPost: DigestPost {
        PreviewPost.make(
            postId: "reddit-text",
            title: "I finally fixed my espresso machine",
            content: "After three weekends of tinkering I replaced the pressurestat and now the steam wand works again. Posting so future searchers know the part number was 102344-A.",
            author: "u/coffeefan",
            subreddit: "espresso",
            score: 412,
            numComments: 37,
            publishedAt: olderDate
        )
    }

    /// YouTube post where the author IS the channel name. Exercises the
    /// "don't render the channel chip twice" path in ``PostHeaderView``.
    static var youtubeVideo: DigestPost {
        PreviewPost.make(
            postId: "yt-1",
            title: "How I Built a Self-Hosted Feed Reader in a Week",
            content: "Walkthrough of the architecture, the mistakes, and the parts I'd do differently next time.",
            url: "https://youtube.com/watch?v=preview",
            author: "Marques Brownlee",
            channel: "Marques Brownlee",
            duration: "12:37",
            publishedAt: recentToday
        )
    }
}
#endif
