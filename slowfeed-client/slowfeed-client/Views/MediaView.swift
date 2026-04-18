import SwiftUI
import AVKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// MARK: - Media View

/// Renders a post's images and videos. One image → centered thumb; 2+ →
/// horizontal carousel. Tapping any image calls `onSelectImage` with the
/// full `[PostMedia]` array so the caller can open ``ImageViewerOverlay``
/// with alt text preserved.
struct MediaView: View {
    let media: [PostMedia]
    let postTitle: String
    var imageNamespace: Namespace.ID?
    var onSelectImage: (([PostMedia], Int) -> Void)?

    @Environment(\.openURL) private var openURL

    private var images: [PostMedia] { media.filter { $0.type == "image" } }
    private var videos: [PostMedia] { media.filter { $0.type == "video" } }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if images.count == 1, let img = images.first, let url = URL(string: img.url) {
                imageThumb(url: url, media: img, index: 0)
                    .frame(maxWidth: 600)
                    .contextMenu { mediaContextMenu(for: img) }
            } else if images.count > 1 {
                GeometryReader { geo in
                    let itemWidth = min(geo.size.width - 24, 600.0)
                    ScrollView(.horizontal, showsIndicators: false) {
                        LazyHStack(spacing: 12) {
                            ForEach(Array(images.enumerated()), id: \.offset) { index, img in
                                if let url = URL(string: img.url) {
                                    imageThumb(url: url, media: img, index: index)
                                        .frame(width: itemWidth, height: min(itemWidth * 0.75, 400))
                                        .contextMenu { mediaContextMenu(for: img) }
                                }
                            }
                        }
                        .scrollTargetLayout()
                        .padding(.horizontal, 12)
                    }
                    .scrollTargetBehavior(.viewAligned)
                }
                .frame(height: min(400, 300))

                // Gallery counter
                Text("\(images.count) images")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            ForEach(videos, id: \.url) { vid in
                InlineVideoPlayer(media: vid)
                    .frame(maxWidth: 600)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .contextMenu { mediaContextMenu(for: vid) }
            }
        }
    }

    @ViewBuilder
    private func imageThumb(url: URL, media: PostMedia, index: Int) -> some View {
        let altText = (media.alt?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
        CachedImage(url: url) {
            RoundedRectangle(cornerRadius: 8)
                .fill(.quaternary)
                .aspectRatio(4/3, contentMode: .fit)
        }
        .aspectRatio(contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .if(imageNamespace != nil) { view in
            view.matchedGeometryEffect(id: url.absoluteString, in: imageNamespace!)
        }
        .overlay(alignment: .bottomLeading) {
            if altText != nil {
                AltBadge()
                    .padding(8)
            }
        }
        .accessibilityLabel(altText ?? "Image")
        .onTapGesture { onSelectImage?(images, index) }
    }

    @ViewBuilder
    private func mediaContextMenu(for media: PostMedia) -> some View {
        Button {
            Task { await copyMedia(media) }
        } label: {
            Label("Copy Media", systemImage: "photo.on.rectangle")
        }

        Button {
            Task { await shareMedia(media) }
        } label: {
            Label("Share Media", systemImage: "square.and.arrow.up")
        }
    }

    private func downloadMedia(_ media: PostMedia) async -> Data? {
        guard let url = URL(string: media.url) else { return nil }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            return data
        } catch {
            return nil
        }
    }

    private func fileExtension(for media: PostMedia) -> String {
        let urlExt = URL(string: media.url)?.pathExtension ?? ""
        if !urlExt.isEmpty { return urlExt }
        switch media.type {
        case "video": return "mp4"
        case "image": return "jpg"
        default: return "bin"
        }
    }

    private func writeTempFile(data: Data, media: PostMedia) -> URL {
        let ext = fileExtension(for: media)
        let filename = "slowfeed_media_\(UUID().uuidString.prefix(8)).\(ext)"
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        try? data.write(to: tempURL)
        return tempURL
    }

    private func copyMedia(_ media: PostMedia) async {
        guard let data = await downloadMedia(media) else { return }
        let isImage = media.type == "image"
        let tempFileURL = writeTempFile(data: data, media: media)

        await MainActor.run {
            #if os(macOS)
            let pb = NSPasteboard.general
            pb.clearContents()
            if isImage, let image = NSImage(data: data) {
                pb.writeObjects([image])
            } else {
                pb.writeObjects([tempFileURL as NSURL])
            }
            #else
            if isImage, let image = UIImage(data: data) {
                UIPasteboard.general.image = image
            } else {
                UIPasteboard.general.url = tempFileURL
            }
            #endif
        }
    }

    private func shareMedia(_ media: PostMedia) async {
        guard let data = await downloadMedia(media) else { return }
        let tempFileURL = writeTempFile(data: data, media: media)

        await MainActor.run {
            #if os(macOS)
            let items: [Any]
            if media.type == "image", let image = NSImage(data: data) {
                items = [image]
            } else {
                items = [tempFileURL]
            }
            let picker = NSSharingServicePicker(items: items)
            if let window = NSApp.keyWindow, let contentView = window.contentView {
                picker.show(relativeTo: contentView.bounds, of: contentView, preferredEdge: .minY)
            }
            #else
            let items: [Any]
            if media.type == "image", let image = UIImage(data: data) {
                items = [image]
            } else {
                items = [tempFileURL]
            }
            let activityVC = UIActivityViewController(activityItems: items, applicationActivities: nil)
            if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
               let rootVC = windowScene.windows.first?.rootViewController {
                rootVC.present(activityVC, animated: true)
            }
            #endif
        }
    }
}

// MARK: - Alt Badge

/// The small "ALT" overlay we stamp on image thumbnails when they have alt text.
struct AltBadge: View {
    var body: some View {
        Text("ALT")
            .font(.caption2)
            .fontWeight(.semibold)
            .foregroundStyle(.white)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(.black.opacity(0.65), in: RoundedRectangle(cornerRadius: 4))
            .accessibilityHidden(true)
    }
}

// MARK: - Inline Video Player

#if os(macOS)
struct NativePlayerView: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.player = player
        view.controlsStyle = .inline
        view.showsFullScreenToggleButton = true
        return view
    }

    func updateNSView(_ nsView: AVPlayerView, context: Context) {
        nsView.player = player
    }
}
#endif

/// Inline video player. Reddit DASH/CMAF posts have audio in a separate file;
/// we merge them into one `AVPlayerItem` via ``AVMutableComposition`` so the
/// two tracks stay in sync (a pair of independent `AVPlayer` instances drifts).
struct InlineVideoPlayer: View {
    let media: PostMedia

    @State private var player: AVPlayer?
    @State private var loopObserver: NSObjectProtocol?

    /// Whether the audio URL is actually a separate track (not the same as video).
    private var hasSeparateAudio: Bool {
        guard let audioUrl = media.audioUrl else { return false }
        return audioUrl != media.url
    }

    var body: some View {
        ZStack {
            if let player {
                #if os(macOS)
                NativePlayerView(player: player)
                    .aspectRatio(16/9, contentMode: .fit)
                    .onDisappear { stopPlayback() }
                #else
                VideoPlayer(player: player)
                    .aspectRatio(16/9, contentMode: .fit)
                    .onDisappear { stopPlayback() }
                #endif
            } else {
                thumbnailPlaceholder
                    .onTapGesture { startPlayback() }
            }
        }
    }

    private var thumbnailPlaceholder: some View {
        ZStack {
            if let thumbUrl = media.thumbnailUrl, let url = URL(string: thumbUrl) {
                CachedImage(url: url) {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(.quaternary)
                        .aspectRatio(16/9, contentMode: .fit)
                }
                .aspectRatio(contentMode: .fit)
            } else {
                RoundedRectangle(cornerRadius: 8)
                    .fill(.quaternary)
                    .aspectRatio(16/9, contentMode: .fit)
            }

            Image(systemName: "play.circle.fill")
                .font(.system(size: 52))
                .foregroundStyle(.white.opacity(0.9))
                .shadow(radius: 4)
        }
    }

    private func startPlayback() {
        guard let videoURL = URL(string: media.url) else { return }

        if hasSeparateAudio, let audioURL = URL(string: media.audioUrl!) {
            // Reddit DASH/CMAF: combine video-only + audio-only tracks into a
            // single AVPlayerItem via AVMutableComposition so they stay in sync.
            // The composition uses async track/duration/transform loaders, so
            // we build it in a Task and fall back to a plain video player if
            // either asset can't be loaded.
            Task { @MainActor in
                let combined = await Self.makeCombinedPlayer(videoURL: videoURL, audioURL: audioURL)
                let player = combined ?? AVPlayer(url: videoURL)
                install(player: player)
            }
        } else {
            // Standard video — audio is embedded in the file.
            install(player: AVPlayer(url: videoURL))
        }
    }

    /// Attach `player`, arm the loop observer, and start playback.
    @MainActor
    private func install(player: AVPlayer) {
        if let observer = loopObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        loopObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: player.currentItem,
            queue: .main
        ) { _ in
            player.seek(to: .zero)
            player.play()
        }
        player.play()
        self.player = player
    }

    /// Build an `AVPlayer` from a composition that merges the video track from
    /// `videoURL` with the audio track from `audioURL`. Returns nil if either
    /// asset lacks the expected track. Uses the async `load(...)` APIs so the
    /// blocking `tracks(withMediaType:)` / `duration` / `preferredTransform`
    /// deprecations go away.
    private static func makeCombinedPlayer(videoURL: URL, audioURL: URL) async -> AVPlayer? {
        let videoAsset = AVURLAsset(url: videoURL)
        let audioAsset = AVURLAsset(url: audioURL)

        do {
            guard
                let videoTrack = try await videoAsset.loadTracks(withMediaType: .video).first,
                let audioTrack = try await audioAsset.loadTracks(withMediaType: .audio).first
            else {
                return nil
            }

            async let videoDurationLoad = videoAsset.load(.duration)
            async let audioDurationLoad = audioAsset.load(.duration)
            async let preferredTransformLoad = videoTrack.load(.preferredTransform)
            let videoDuration = try await videoDurationLoad
            let audioDuration = try await audioDurationLoad
            let preferredTransform = try await preferredTransformLoad

            let duration = CMTimeMinimum(videoDuration, audioDuration)
            let range = CMTimeRange(start: .zero, duration: duration)

            let composition = AVMutableComposition()
            if let compVideo = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) {
                try compVideo.insertTimeRange(range, of: videoTrack, at: .zero)
                compVideo.preferredTransform = preferredTransform
            }
            if let compAudio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
                try compAudio.insertTimeRange(range, of: audioTrack, at: .zero)
            }

            let item = AVPlayerItem(asset: composition)
            return AVPlayer(playerItem: item)
        } catch {
            return nil
        }
    }

    private func stopPlayback() {
        player?.pause()
        if let observer = loopObserver {
            NotificationCenter.default.removeObserver(observer)
            loopObserver = nil
        }
    }
}

// MARK: - Fullscreen Image Viewer Overlay

/// Full-screen image viewer with pinch-to-zoom, swipe-to-dismiss, and (when
/// present) an ALT caption that expands on tap.
struct ImageViewerOverlay: View {
    let images: [PostMedia]
    @Binding var currentIndex: Int
    let namespace: Namespace.ID
    let onDismiss: () -> Void

    // Pan & zoom
    @State private var scale: CGFloat = 1.0
    @State private var lastScale: CGFloat = 1.0
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    // Swipe-to-dismiss
    @State private var dismissDrag: CGSize = .zero
    @State private var backgroundOpacity: Double = 1.0
    @FocusState private var isFocused: Bool
    @State private var showAltText: Bool = false

    private var imageURLs: [URL] { images.compactMap { URL(string: $0.url) } }
    private var safeIndex: Int {
        guard !imageURLs.isEmpty else { return 0 }
        return min(max(currentIndex, 0), imageURLs.count - 1)
    }
    private var currentURL: URL? {
        guard !imageURLs.isEmpty else { return nil }
        return imageURLs[safeIndex]
    }
    private var currentAlt: String? {
        guard !images.isEmpty, safeIndex < images.count else { return nil }
        let trimmed = images[safeIndex].alt?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty == false) ? trimmed : nil
    }
    private var isDraggingToDismiss: Bool { scale <= 1.0 && dismissDrag != .zero }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Color.black
                    .opacity(backgroundOpacity)
                    .ignoresSafeArea()
                    .onTapGesture { onDismiss() }

                // The image with matched geometry for animation
                CachedImage(url: currentURL) {
                    ProgressView().tint(.white)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .aspectRatio(contentMode: .fit)
                .matchedGeometryEffect(id: currentURL?.absoluteString ?? "", in: namespace)
                .scaleEffect(scale)
                .offset(
                    x: offset.width + (isDraggingToDismiss ? dismissDrag.width * 0.3 : 0),
                    y: offset.height + (isDraggingToDismiss ? dismissDrag.height : 0)
                )
                .scaleEffect(isDraggingToDismiss ? max(0.7, 1.0 - abs(dismissDrag.height) / 1000) : 1.0)
                .gesture(combinedGesture(containerSize: geo.size))
                .onTapGesture(count: 2) { location in
                    withAnimation(.spring(duration: 0.3)) {
                        if scale > 1.5 {
                            resetZoom()
                        } else {
                            let newScale: CGFloat = 3.0
                            let cx = geo.size.width / 2, cy = geo.size.height / 2
                            scale = newScale; lastScale = newScale
                            offset = CGSize(width: (cx - location.x) * (newScale - 1),
                                            height: (cy - location.y) * (newScale - 1))
                            lastOffset = offset
                        }
                    }
                }

                // Gallery arrows
                if imageURLs.count > 1 {
                    HStack {
                        if currentIndex > 0 {
                            navButton(systemName: "chevron.left.circle.fill") {
                                resetZoom()
                                showAltText = false
                                withAnimation(.easeInOut(duration: 0.25)) { currentIndex -= 1 }
                            }
                            .padding(.leading, 16)
                        }
                        Spacer()
                        if currentIndex < imageURLs.count - 1 {
                            navButton(systemName: "chevron.right.circle.fill") {
                                resetZoom()
                                showAltText = false
                                withAnimation(.easeInOut(duration: 0.25)) { currentIndex += 1 }
                            }
                            .padding(.trailing, 16)
                        }
                    }
                }

                chrome
            }
        }
        .focusable()
        .focused($isFocused)
        .onAppear { isFocused = true }
        #if os(macOS)
        .onKeyPress(.escape) { onDismiss(); return .handled }
        .onKeyPress(.leftArrow) {
            if currentIndex > 0 { resetZoom(); withAnimation { currentIndex -= 1 } }
            return .handled
        }
        .onKeyPress(.rightArrow) {
            if currentIndex < imageURLs.count - 1 { resetZoom(); withAnimation { currentIndex += 1 } }
            return .handled
        }
        #endif
    }

    /// Close button + counter + tap-to-expand ALT caption.
    private var chrome: some View {
        VStack {
            HStack {
                Spacer()
                Button(action: onDismiss) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title)
                        .foregroundStyle(.white.opacity(0.8))
                        .padding()
                }
                .buttonStyle(.plain)
            }
            Spacer()
            VStack(spacing: 8) {
                if let alt = currentAlt {
                    if showAltText {
                        Text(alt)
                            .font(.callout)
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.leading)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .frame(maxWidth: 600, alignment: .leading)
                            .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 10))
                            .padding(.horizontal, 12)
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                            .onTapGesture {
                                withAnimation(.easeInOut(duration: 0.2)) { showAltText = false }
                            }
                    } else {
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) { showAltText = true }
                        } label: {
                            Text("ALT")
                                .font(.caption).fontWeight(.semibold)
                                .foregroundStyle(.white)
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .background(.black.opacity(0.55), in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Show image description")
                    }
                }
                if imageURLs.count > 1 {
                    Text("\(currentIndex + 1) / \(imageURLs.count)")
                        .font(.caption).fontWeight(.medium)
                        .foregroundStyle(.white.opacity(0.8))
                        .padding(.horizontal, 12).padding(.vertical, 4)
                        .background(.black.opacity(0.4), in: Capsule())
                }
            }
            .padding(.bottom, 12)
        }
        .opacity(backgroundOpacity)
    }

    private func navButton(systemName: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.largeTitle)
                .foregroundStyle(.white.opacity(0.7))
        }
        .buttonStyle(.plain)
    }

    private func resetZoom() {
        scale = 1.0; lastScale = 1.0
        offset = .zero; lastOffset = .zero
    }

    // MARK: - Simultaneous pinch + pan gesture (Photos-style)

    private func combinedGesture(containerSize: CGSize) -> some Gesture {
        SimultaneousGesture(
            MagnifyGesture(),
            DragGesture()
        )
        .onChanged { value in
            // Pinch
            if let magnification = value.first?.magnification {
                scale = max(0.5, min(lastScale * magnification, 10.0))
            }
            // Drag
            if let translation = value.second?.translation {
                if scale > 1.01 {
                    // Pan within zoomed image
                    offset = CGSize(
                        width: lastOffset.width + translation.width / scale,
                        height: lastOffset.height + translation.height / scale
                    )
                } else if value.first == nil {
                    // Only dragging (no pinch) at 1x → swipe to dismiss
                    dismissDrag = translation
                    let progress = min(abs(translation.height) / 300, 1.0)
                    backgroundOpacity = Double(1.0 - progress * 0.6)
                }
            }
        }
        .onEnded { value in
            // Finalize pinch
            lastScale = scale
            if scale < 1.0 {
                withAnimation(.spring(duration: 0.3)) { resetZoom() }
            }
            // Finalize drag
            if scale > 1.01 {
                lastOffset = offset
            } else if dismissDrag != .zero {
                let vy = value.second?.velocity.height ?? 0
                if abs(dismissDrag.height) > 120 || abs(vy) > 800 {
                    onDismiss()
                } else {
                    withAnimation(.spring(duration: 0.3)) {
                        dismissDrag = .zero
                        backgroundOpacity = 1.0
                    }
                }
            }
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Single image with alt") {
    MediaView(
        media: [PreviewPost.MediaSpec(
            url: "https://picsum.photos/seed/slowfeed1/800/600",
            alt: "Mountain landscape at sunset with alpenglow on the peaks"
        )].map(mediaSpecToPostMedia),
        postTitle: "Scenic shot"
    )
    .padding()
    .frame(width: 500)
}

#Preview("Gallery — 3 images, varied alt") {
    MediaView(
        media: [
            PreviewPost.MediaSpec(url: "https://picsum.photos/seed/slowfeed2/800/600",
                                  alt: "A red fox crossing a snowy field"),
            PreviewPost.MediaSpec(url: "https://picsum.photos/seed/slowfeed3/800/600",
                                  alt: "Bare maple trees silhouetted against a pink dawn sky"),
            PreviewPost.MediaSpec(url: "https://picsum.photos/seed/slowfeed4/800/600",
                                  alt: nil)
        ].map(mediaSpecToPostMedia),
        postTitle: "Gallery preview"
    )
    .padding()
    .frame(width: 500)
}

#Preview("Video thumbnail") {
    MediaView(
        media: [PreviewPost.MediaSpec(
            type: "video",
            url: "https://example.com/fake.mp4",
            thumbnailUrl: "https://picsum.photos/seed/slowfeed5/800/450",
            audioUrl: "https://example.com/fake_audio.mp4"
        )].map(mediaSpecToPostMedia),
        postTitle: "Video"
    )
    .padding()
    .frame(width: 500)
}

#Preview("AltBadge alone") {
    AltBadge()
        .padding()
}

// MARK: - Preview helpers

/// Build a real `PostMedia` from a preview spec by round-tripping through JSON,
/// so we don't need a memberwise init on the production struct.
private func mediaSpecToPostMedia(_ spec: PreviewPost.MediaSpec) -> PostMedia {
    let data = try! JSONSerialization.data(withJSONObject: spec.dictionary())
    return try! JSONDecoder().decode(PostMedia.self, from: data)
}
#endif
