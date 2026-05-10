import SwiftUI
import WebKit

/// Full-article reader for an RSS post. Renders the publisher's HTML
/// (`metadata.contentHTML`) inside a `WKWebView` wrapped in a paginated
/// shell with title / source / author / date at the top.
///
/// Falls back to the plain-text `content` field when no HTML is available
/// (some feeds only ship `<description>` summaries).
struct RSSReaderView: View {
    let post: DigestPost

    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss

    private var html: String? {
        let s = post.metadata?.contentHTML?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (s?.isEmpty == false) ? s : nil
    }

    private var fallbackText: String {
        post.content?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                // Header — title / feed / author / date / open-original.
                VStack(alignment: .leading, spacing: 6) {
                    Text(post.title)
                        .font(.title2)
                        .fontWeight(.bold)

                    HStack(spacing: 8) {
                        if let feed = post.metadata?.feedTitle, !feed.isEmpty {
                            Text(feed)
                                .font(.caption)
                                .foregroundStyle(.orange)
                                .fontWeight(.semibold)
                        }
                        if let author = post.author, !author.isEmpty,
                           author != post.metadata?.feedTitle {
                            Text("·")
                                .foregroundStyle(.tertiary)
                            Text(author)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer()
                        if let date = post.publishedAt {
                            Text(date.formatted(date: .abbreviated, time: .shortened))
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }

                    if let urlString = post.url, let url = URL(string: urlString) {
                        Button {
                            openURL(url)
                        } label: {
                            Label("Open Original", systemImage: "safari")
                                .font(.caption)
                        }
                    }
                }
                .padding(.horizontal)
                .padding(.top)

                Divider()

                // Body — HTML in a web view, or plain text if no HTML.
                if let html {
                    HTMLWebView(html: wrappedHTML(html))
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 600)
                } else {
                    Text(fallbackText)
                        .font(.body)
                        .padding(.horizontal)
                }
            }
            .padding(.bottom, 24)
        }
        #if !os(macOS)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
        #else
        .overlay(alignment: .topTrailing) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title2)
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .padding(12)
            .keyboardShortcut(.escape, modifiers: [])
        }
        #endif
    }

    /// Wrap the publisher's body in a minimal stylesheet so it adopts the
    /// system font and color scheme. Without this every feed renders in
    /// Times New Roman with bright-blue links on a white background.
    private func wrappedHTML(_ body: String) -> String {
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
        <body>\(body)</body>
        </html>
        """
    }
}

// MARK: - HTML web view

#if os(macOS)
import AppKit

/// `NSViewRepresentable` wrapping `WKWebView` for macOS. Loads the HTML
/// string directly (no network round trip) and disables JavaScript so a
/// hostile feed can't run code.
struct HTMLWebView: NSViewRepresentable {
    let html: String

    func makeNSView(context: Context) -> WKWebView {
        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = false
        let cfg = WKWebViewConfiguration()
        cfg.defaultWebpagePreferences = prefs
        let view = WKWebView(frame: .zero, configuration: cfg)
        view.setValue(false, forKey: "drawsBackground")
        view.loadHTMLString(html, baseURL: nil)
        return view
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        nsView.loadHTMLString(html, baseURL: nil)
    }
}
#else
/// `UIViewRepresentable` wrapping `WKWebView` for iOS. JavaScript disabled.
struct HTMLWebView: UIViewRepresentable {
    let html: String

    func makeUIView(context: Context) -> WKWebView {
        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = false
        let cfg = WKWebViewConfiguration()
        cfg.defaultWebpagePreferences = prefs
        let view = WKWebView(frame: .zero, configuration: cfg)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false // outer ScrollView paginates
        view.loadHTMLString(html, baseURL: nil)
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        uiView.loadHTMLString(html, baseURL: nil)
    }
}
#endif
