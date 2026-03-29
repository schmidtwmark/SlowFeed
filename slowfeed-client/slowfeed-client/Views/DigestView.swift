import SwiftUI
import WebKit

struct DigestView: View {
    let digest: Digest

    @Environment(AppState.self) private var appState
    @State private var selectedPostIndex: Int = 0
    @FocusState private var isFocused: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // Header
                    DigestHeader(digest: digest)
                        .id("header")

                    Divider()

                    // Content
                    HTMLContentView(html: digest.content, source: digest.source)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding()
            }
            .focusable()
            .focused($isFocused)
            #if os(macOS)
            .onKeyPress { keyPress in
                handleKeyPress(keyPress, proxy: proxy)
            }
            #endif
        }
        .onAppear {
            isFocused = true
        }
    }

    #if os(macOS)
    private func handleKeyPress(_ keyPress: KeyPress, proxy: ScrollViewProxy) -> KeyPress.Result {
        switch keyPress.key {
        case .leftArrow, "h":
            // Previous digest (older)
            if appState.canNavigatePrevious {
                Task {
                    await appState.navigateToPreviousDigest()
                }
                return .handled
            }
        case .rightArrow, "l":
            // Next digest (newer)
            if appState.canNavigateNext {
                Task {
                    await appState.navigateToNextDigest()
                }
                return .handled
            }
        case "j":
            // Scroll down
            return .ignored // Let default scrolling handle it
        case "k":
            // Scroll up
            return .ignored // Let default scrolling handle it
        case "g":
            // Go to top
            proxy.scrollTo("header", anchor: .top)
            return .handled
        default:
            break
        }
        return .ignored
    }
    #endif
}

struct DigestHeader: View {
    let digest: Digest

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                SourceBadge(source: digest.source)

                Spacer()

                if digest.isRead {
                    Label("Read", systemImage: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Text(digest.title)
                .font(.title2)
                .fontWeight(.semibold)

            HStack(spacing: 16) {
                Label("\(digest.postCount) posts", systemImage: "doc.text")

                Label(digest.publishedAt.formatted(date: .abbreviated, time: .shortened), systemImage: "clock")
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
    }
}

struct SourceBadge: View {
    let source: SourceType

    var body: some View {
        Label(source.displayName, systemImage: source.iconName)
            .font(.caption)
            .fontWeight(.medium)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(sourceColor.opacity(0.2))
            .foregroundStyle(sourceColor)
            .clipShape(Capsule())
    }

    private var sourceColor: Color {
        switch source {
        case .reddit: return .orange
        case .bluesky: return .blue
        case .youtube: return .red
        case .discord: return .purple
        }
    }
}

// MARK: - HTML Content View

struct HTMLContentView: View {
    let html: String
    let source: SourceType

    var body: some View {
        #if os(macOS)
        WebViewRepresentable(html: styledHTML)
            .frame(minHeight: 400)
        #else
        WebViewRepresentable(html: styledHTML)
            .frame(minHeight: 400)
        #endif
    }

    private var styledHTML: String {
        """
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                :root {
                    color-scheme: light dark;
                }
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
                    font-size: 15px;
                    line-height: 1.6;
                    padding: 0;
                    margin: 0;
                    background: transparent;
                }
                @media (prefers-color-scheme: dark) {
                    body { color: #e5e5e5; }
                    a { color: #58a6ff; }
                    .post { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.1); }
                }
                @media (prefers-color-scheme: light) {
                    body { color: #1a1a1a; }
                    a { color: #0066cc; }
                    .post { background: rgba(0,0,0,0.02); border-color: rgba(0,0,0,0.1); }
                }
                h2, h3 { margin-top: 24px; margin-bottom: 12px; }
                h2 { font-size: 20px; }
                h3 { font-size: 17px; }
                p { margin: 8px 0; }
                a { text-decoration: none; }
                a:hover { text-decoration: underline; }
                img { max-width: 100%; height: auto; border-radius: 8px; margin: 8px 0; }
                .post {
                    padding: 16px;
                    margin: 16px 0;
                    border-radius: 12px;
                    border: 1px solid;
                }
                .post-author {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 8px;
                }
                .avatar {
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                }
                .thread-post {
                    padding: 12px 0;
                    border-bottom: 1px solid rgba(128,128,128,0.2);
                }
                .thread-post:last-child {
                    border-bottom: none;
                }
                .youtube-embed img {
                    border-radius: 8px;
                    cursor: pointer;
                }
                small { color: #888; }
                blockquote {
                    margin: 8px 0;
                    padding-left: 12px;
                    border-left: 3px solid rgba(128,128,128,0.4);
                    color: #888;
                }
            </style>
        </head>
        <body>
            \(html)
        </body>
        </html>
        """
    }
}

// MARK: - WebView

#if os(macOS)
struct WebViewRepresentable: NSViewRepresentable {
    let html: String

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.isElementFullscreenEnabled = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        webView.loadHTMLString(html, baseURL: nil)
    }
}
#else
struct WebViewRepresentable: UIViewRepresentable {
    let html: String

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        webView.loadHTMLString(html, baseURL: nil)
    }
}
#endif

#Preview {
    DigestView(digest: Digest(
        id: "test",
        source: .reddit,
        title: "Reddit Digest: 5 posts",
        content: "<p>Test content</p>",
        postCount: 5,
        postIds: [],
        publishedAt: Date(),
        createdAt: Date(),
        readAt: nil,
        posts: nil
    ))
    .environment(AppState())
}
