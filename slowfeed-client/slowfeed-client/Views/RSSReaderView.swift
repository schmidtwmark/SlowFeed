import SwiftUI
import WebKit

/// Full-article reader for an RSS post. The article body (with title /
/// feed / author / date injected as a header) is rendered inside a
/// `WKWebView` that owns its own scrolling. We avoid wrapping the web
/// view in a SwiftUI `ScrollView` because the web view's content can
/// be arbitrarily tall (long articles) and pinning it to a fixed
/// SwiftUI frame squashes everything past the first screen.
///
/// Falls back to the plain-text `content` field when no HTML is
/// available (some feeds only ship `<description>` summaries).
struct RSSReaderView: View {
    let post: DigestPost

    @Environment(\.openURL) private var openURL

    private var html: String? {
        let s = post.metadata?.contentHTML?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (s?.isEmpty == false) ? s : nil
    }

    private var fallbackText: String {
        post.content?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    var body: some View {
        Group {
            if let html {
                HTMLWebView(html: wrappedHTML(html), onOpenLink: openExternally)
            } else {
                ScrollView {
                    Text(fallbackText)
                        .font(.body)
                        .padding()
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .navigationTitle(post.metadata?.feedTitle ?? "Article")
        #if !os(macOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            if let urlString = post.url, let url = URL(string: urlString) {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        openURL(url)
                    } label: {
                        Label("Open Original", systemImage: "safari")
                    }
                }
            }
        }
    }

    private func openExternally(_ url: URL) {
        openURL(url)
    }

    /// Wrap the publisher's body in a minimal stylesheet (so it adopts
    /// the system font + color scheme instead of Times New Roman with
    /// bright-blue links on a white background) and inject the article
    /// header (title, feed, author, date) so it scrolls with the
    /// content as part of the same WKWebView document.
    private func wrappedHTML(_ body: String) -> String {
        let title = htmlEscape(post.title)
        let feedHTML: String = {
            guard let feed = post.metadata?.feedTitle, !feed.isEmpty else { return "" }
            return "<span class=\"feed\">\(htmlEscape(feed))</span>"
        }()
        let authorHTML: String = {
            guard let author = post.author, !author.isEmpty,
                  author != post.metadata?.feedTitle else { return "" }
            return "<span class=\"author\">\(htmlEscape(author))</span>"
        }()
        let dateHTML: String = {
            guard let date = post.publishedAt else { return "" }
            let formatted = date.formatted(date: .abbreviated, time: .shortened)
            return "<span class=\"date\">\(htmlEscape(formatted))</span>"
        }()

        return """
        <!DOCTYPE html>
        <html>
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
        <style>
          :root { color-scheme: light dark; }
          html, body {
            margin: 0;
            padding: 16px;
            font: -apple-system-body;
            font-family: -apple-system, system-ui, sans-serif;
            line-height: 1.55;
          }
          header.article-header { margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid rgba(127,127,127,0.3); }
          header.article-header h1 { font-size: 1.6em; margin: 0 0 8px 0; line-height: 1.25; }
          header.article-header .meta { font-size: 0.85em; display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
          header.article-header .meta .feed { color: #ff9500; font-weight: 600; }
          header.article-header .meta .author { opacity: 0.7; }
          header.article-header .meta .date { opacity: 0.55; margin-left: auto; }
          img, video, iframe { max-width: 100%; height: auto; border-radius: 6px; }
          pre, code { background: rgba(127,127,127,0.15); border-radius: 4px; padding: 2px 4px; font-family: ui-monospace, Menlo, monospace; }
          pre { padding: 12px; overflow-x: auto; }
          blockquote { border-left: 3px solid rgba(127,127,127,0.4); margin: 12px 0; padding: 4px 12px; color: rgba(127,127,127,1.0); }
          a { color: #0a84ff; }
          h1, h2, h3, h4 { line-height: 1.3; }
          figure { margin: 12px 0; }
          figcaption { font-size: 0.85em; opacity: 0.7; }
          hr { border: 0; border-top: 1px solid rgba(127,127,127,0.3); margin: 16px 0; }
        </style>
        </head>
        <body>
        <header class="article-header">
          <h1>\(title)</h1>
          <div class="meta">\(feedHTML)\(authorHTML)\(dateHTML)</div>
        </header>
        \(body)
        </body>
        </html>
        """
    }

    private func htmlEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }
}

// MARK: - HTML web view

/// Coordinator: holds the last-loaded HTML so updateUIView/NSView only
/// reloads when the content actually changes (otherwise every SwiftUI
/// re-render would scroll-jump back to the top), and intercepts link
/// taps so they open in the system browser instead of navigating
/// inside the in-app reader.
final class HTMLWebViewCoordinator: NSObject, WKNavigationDelegate {
    var loadedHTML: String?
    let onOpenLink: ((URL) -> Void)?

    init(onOpenLink: ((URL) -> Void)?) {
        self.onOpenLink = onOpenLink
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // The initial loadHTMLString is .other; allow it through. Anything
        // user-initiated (link clicks) becomes .linkActivated — those go to
        // the system browser via the openURL environment.
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url {
            onOpenLink?(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}

#if os(macOS)
import AppKit

/// `NSViewRepresentable` wrapping `WKWebView` for macOS. The web view
/// scrolls natively. JavaScript is disabled so a hostile feed can't
/// execute code.
struct HTMLWebView: NSViewRepresentable {
    let html: String
    let onOpenLink: ((URL) -> Void)?

    func makeCoordinator() -> HTMLWebViewCoordinator {
        HTMLWebViewCoordinator(onOpenLink: onOpenLink)
    }

    func makeNSView(context: Context) -> WKWebView {
        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = false
        let cfg = WKWebViewConfiguration()
        cfg.defaultWebpagePreferences = prefs
        let view = WKWebView(frame: .zero, configuration: cfg)
        view.setValue(false, forKey: "drawsBackground")
        view.navigationDelegate = context.coordinator
        view.loadHTMLString(html, baseURL: nil)
        context.coordinator.loadedHTML = html
        return view
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        guard context.coordinator.loadedHTML != html else { return }
        context.coordinator.loadedHTML = html
        nsView.loadHTMLString(html, baseURL: nil)
    }
}
#else
/// `UIViewRepresentable` wrapping `WKWebView` for iOS. The web view
/// scrolls natively (its `scrollView` handles the article body —
/// don't wrap this in a SwiftUI `ScrollView` or you'll squash long
/// articles to whatever frame height SwiftUI hands the web view).
/// JavaScript is disabled.
struct HTMLWebView: UIViewRepresentable {
    let html: String
    let onOpenLink: ((URL) -> Void)?

    func makeCoordinator() -> HTMLWebViewCoordinator {
        HTMLWebViewCoordinator(onOpenLink: onOpenLink)
    }

    func makeUIView(context: Context) -> WKWebView {
        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = false
        let cfg = WKWebViewConfiguration()
        cfg.defaultWebpagePreferences = prefs
        let view = WKWebView(frame: .zero, configuration: cfg)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.navigationDelegate = context.coordinator
        view.loadHTMLString(html, baseURL: nil)
        context.coordinator.loadedHTML = html
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        guard context.coordinator.loadedHTML != html else { return }
        context.coordinator.loadedHTML = html
        uiView.loadHTMLString(html, baseURL: nil)
    }
}
#endif
