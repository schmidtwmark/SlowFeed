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
                                    imageThumb(url: url, media: img, index: index, galleryPosition: (index + 1, images.count))
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
            }

            ForEach(videos, id: \.url) { vid in
                InlineVideoPlayer(media: vid)
                    // 600pt cap on both axes: landscape videos fill the width,
                    // vertical (9:16) videos cap at 600 tall instead of bloating
                    // up to 1000+pt.
                    .frame(maxWidth: 600, maxHeight: 600)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .contextMenu { mediaContextMenu(for: vid) }
            }
        }
    }

    @ViewBuilder
    private func imageThumb(
        url: URL,
        media: PostMedia,
        index: Int,
        galleryPosition: (current: Int, total: Int)? = nil
    ) -> some View {
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
        .overlay(alignment: .topTrailing) {
            if let pos = galleryPosition {
                GalleryIndexBadge(current: pos.current, total: pos.total)
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

// MARK: - Gallery Index Badge

/// "1 / 3"-style pill shown in the top-right corner of each image in an
/// inline gallery. Replaces the old "N images" text below the gallery.
struct GalleryIndexBadge: View {
    let current: Int
    let total: Int

    var body: some View {
        Text("\(current) / \(total)")
            .font(.caption2)
            .fontWeight(.semibold)
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.black.opacity(0.55), in: Capsule())
            .accessibilityLabel("Image \(current) of \(total)")
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

/// Inline video player. Hands the URL straight to `AVPlayer`, which natively
/// plays HLS (`.m3u8`) and progressive MP4 — including Reddit videos via
/// `hls_url`, since AVPlayer handles the muxed video+audio itself.
///
/// The player's frame uses the video's natural aspect ratio loaded from the
/// asset (honoring `preferredTransform`) rather than a hardcoded 16:9, so
/// vertical videos render without letterboxing.
struct InlineVideoPlayer: View {
    let media: PostMedia

    @State private var player: AVPlayer?
    @State private var loopObserver: NSObjectProtocol?
    /// Falls back to 16:9 until the asset's natural size loads.
    @State private var aspectRatio: CGFloat = 16.0 / 9.0

    var body: some View {
        ZStack {
            if let player {
                #if os(macOS)
                NativePlayerView(player: player)
                    .aspectRatio(aspectRatio, contentMode: .fit)
                    .onDisappear { stopPlayback() }
                #else
                VideoPlayer(player: player)
                    .aspectRatio(aspectRatio, contentMode: .fit)
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
                // Thumbnail sizes itself to its own intrinsic ratio, so
                // vertical videos preview correctly without a pre-load.
                CachedImage(url: url) {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(.quaternary)
                        .aspectRatio(aspectRatio, contentMode: .fit)
                }
                .aspectRatio(contentMode: .fit)
            } else {
                RoundedRectangle(cornerRadius: 8)
                    .fill(.quaternary)
                    .aspectRatio(aspectRatio, contentMode: .fit)
            }

            Image(systemName: "play.circle.fill")
                .font(.system(size: 52))
                .foregroundStyle(.white.opacity(0.9))
                .shadow(radius: 4)
        }
    }

    private func startPlayback() {
        guard player == nil, let videoURL = URL(string: media.url) else { return }

        let newPlayer = AVPlayer(url: videoURL)

        // Loop on end.
        if let observer = loopObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        loopObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: newPlayer.currentItem,
            queue: .main
        ) { _ in
            newPlayer.seek(to: .zero)
            newPlayer.play()
        }

        newPlayer.play()
        player = newPlayer

        // Resize to the video's natural aspect ratio in the background.
        Task { @MainActor in
            if let ratio = await Self.loadAspectRatio(for: videoURL), ratio > 0 {
                aspectRatio = ratio
            }
        }
    }

    /// Load the asset's natural aspect ratio, honoring `preferredTransform` so
    /// portrait videos recorded sideways still present as portrait.
    private static func loadAspectRatio(for url: URL) async -> CGFloat? {
        let asset = AVURLAsset(url: url)
        do {
            guard let track = try await asset.loadTracks(withMediaType: .video).first else { return nil }
            async let sizeLoad = track.load(.naturalSize)
            async let transformLoad = track.load(.preferredTransform)
            let size = try await sizeLoad
            let transform = try await transformLoad
            let oriented = size.applying(transform)
            let w = abs(oriented.width), h = abs(oriented.height)
            guard w > 0, h > 0 else { return nil }
            return w / h
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

// MARK: - Zoomable Image (iOS)

#if !os(macOS)
/// Photos-app-style zoomable image backed by UIScrollView. Handles pinch
/// anchoring, pan within bounds with rubber-banding, bounce at zoom limits,
/// and double-tap-to-zoom-at-location natively — none of which are
/// reliable with SwiftUI's gesture primitives alone.
///
/// The parent owns the image view bounds; this representable fills them.
/// A `zoomScale` binding is exposed so the overlay can use it to gate
/// swipe-to-dismiss (only at 1x).
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage?
    @Binding var zoomScale: CGFloat
    var onSingleTap: (() -> Void)? = nil

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.delegate = context.coordinator
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 6
        scroll.showsHorizontalScrollIndicator = false
        scroll.showsVerticalScrollIndicator = false
        scroll.bouncesZoom = true
        scroll.decelerationRate = .fast
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.backgroundColor = .clear

        let imageView = UIImageView(image: image)
        imageView.contentMode = .scaleAspectFit
        imageView.isUserInteractionEnabled = true
        imageView.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(imageView)

        // Pin the image view to both the content and the frame guides so it
        // stays centered and resizes with the scroll view at 1x zoom.
        NSLayoutConstraint.activate([
            imageView.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            imageView.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            imageView.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            imageView.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
            imageView.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
        ])

        context.coordinator.imageView = imageView
        context.coordinator.scrollView = scroll

        let doubleTap = UITapGestureRecognizer(target: context.coordinator,
                                               action: #selector(Coordinator.handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(doubleTap)

        let singleTap = UITapGestureRecognizer(target: context.coordinator,
                                               action: #selector(Coordinator.handleSingleTap(_:)))
        singleTap.numberOfTapsRequired = 1
        singleTap.require(toFail: doubleTap)
        scroll.addGestureRecognizer(singleTap)

        return scroll
    }

    func updateUIView(_ uiView: UIScrollView, context: Context) {
        if context.coordinator.imageView?.image != image {
            context.coordinator.imageView?.image = image
            uiView.setZoomScale(1, animated: false)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        weak var imageView: UIImageView?
        weak var scrollView: UIScrollView?
        var parent: ZoomableImage

        init(parent: ZoomableImage) { self.parent = parent }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            // Push the current zoom back up to SwiftUI so the overlay can
            // disable swipe-to-dismiss while zoomed in.
            let s = scrollView.zoomScale
            if abs(parent.zoomScale - s) > 0.001 {
                DispatchQueue.main.async { self.parent.zoomScale = s }
            }
        }

        @objc func handleDoubleTap(_ gr: UITapGestureRecognizer) {
            guard let scroll = scrollView, let imageView else { return }
            if scroll.zoomScale > scroll.minimumZoomScale + 0.001 {
                scroll.setZoomScale(scroll.minimumZoomScale, animated: true)
            } else {
                // Zoom to the tap location at 3x — matches Photos behavior.
                let targetScale: CGFloat = 3
                let location = gr.location(in: imageView)
                let w = scroll.bounds.width / targetScale
                let h = scroll.bounds.height / targetScale
                let rect = CGRect(x: location.x - w / 2, y: location.y - h / 2, width: w, height: h)
                scroll.zoom(to: rect, animated: true)
            }
        }

        @objc func handleSingleTap(_ gr: UITapGestureRecognizer) {
            parent.onSingleTap?()
        }
    }
}

/// Loads a `UIImage` for a URL (using the same NSCache the rest of the app
/// shares) and calls back once it's available. Sync return for cache hits.
struct LoadedUIImage {
    static func cachedImage(for url: URL) -> UIImage? {
        ImageCache.shared.image(for: url)
    }

    static func fetch(url: URL) async -> UIImage? {
        if let cached = ImageCache.shared.image(for: url) { return cached }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            guard let image = UIImage(data: data) else { return nil }
            ImageCache.shared.store(image, for: url)
            return image
        } catch {
            return nil
        }
    }
}
#endif

// MARK: - Fullscreen Image Viewer Overlay

/// Full-screen image viewer with pinch-to-zoom, swipe-to-dismiss, and (when
/// present) an ALT caption that expands on tap.
struct ImageViewerOverlay: View {
    let images: [PostMedia]
    @Binding var currentIndex: Int
    let namespace: Namespace.ID
    let onDismiss: () -> Void

    // iOS: zoom reported back by `ZoomableImage` (UIScrollView). We use this
    // to gate swipe-to-dismiss — only allow it at minimum zoom.
    @State private var zoomScale: CGFloat = 1

    // iOS: loaded UIImage for the current URL (UIScrollView needs a UIImage).
    #if !os(macOS)
    @State private var loadedImage: UIImage?
    #endif

    // Swipe-to-dismiss state.
    @State private var dismissDrag: CGSize = .zero
    @State private var backgroundOpacity: Double = 1.0
    @FocusState private var isFocused: Bool
    @State private var showAltText: Bool = false

    // macOS only: simple scale/offset bag for the SwiftUI-based zoom.
    #if os(macOS)
    @State private var scale: CGFloat = 1.0
    @State private var lastScale: CGFloat = 1.0
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero
    #endif

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

    /// True when the user is dragging-to-dismiss at minimum zoom.
    private var isDraggingToDismiss: Bool {
        #if os(macOS)
        return scale <= 1.0 && dismissDrag != .zero
        #else
        return abs(zoomScale - 1) < 0.01 && dismissDrag != .zero
        #endif
    }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Color.black
                    .opacity(backgroundOpacity)
                    .ignoresSafeArea()
                    .onTapGesture { onDismiss() }

                imageLayer(containerSize: geo.size)

                // Gallery arrows
                if imageURLs.count > 1 {
                    HStack {
                        if currentIndex > 0 {
                            navButton(systemName: "chevron.left.circle.fill") {
                                showAltText = false
                                withAnimation(.easeInOut(duration: 0.25)) { currentIndex -= 1 }
                            }
                            .padding(.leading, 16)
                        }
                        Spacer()
                        if currentIndex < imageURLs.count - 1 {
                            navButton(systemName: "chevron.right.circle.fill") {
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
        #else
        .task(id: currentURL) {
            // Load the UIImage for the UIScrollView wrapper. Uses the shared
            // NSCache so if the thumbnail grid already fetched this image, we
            // reuse the in-memory copy — no redundant download.
            guard let url = currentURL else { return }
            loadedImage = LoadedUIImage.cachedImage(for: url)
            if loadedImage == nil {
                loadedImage = await LoadedUIImage.fetch(url: url)
            }
        }
        #endif
    }

    /// Platform-split image layer: UIScrollView-backed on iOS for Photos-app
    /// fidelity (proper pinch anchoring, pan bounds, double-tap-at-location,
    /// bounce at limits) and the existing SwiftUI gesture approach on macOS
    /// (mouse input → the custom gesture code plays nicely enough there).
    @ViewBuilder
    private func imageLayer(containerSize: CGSize) -> some View {
        #if os(macOS)
        CachedImage(url: currentURL) {
            ProgressView().tint(.white)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .aspectRatio(contentMode: .fit)
        .matchedGeometryEffect(id: currentURL?.absoluteString ?? "", in: namespace)
        .scaleEffect(scale)
        .offset(x: offset.width, y: offset.height)
        .gesture(macOSZoomGesture(containerSize: containerSize))
        .onTapGesture(count: 2) { location in
            withAnimation(.spring(duration: 0.3)) {
                if scale > 1.5 {
                    resetZoom()
                } else {
                    let newScale: CGFloat = 3.0
                    let cx = containerSize.width / 2, cy = containerSize.height / 2
                    scale = newScale; lastScale = newScale
                    offset = CGSize(width: (cx - location.x) * (newScale - 1),
                                    height: (cy - location.y) * (newScale - 1))
                    lastOffset = offset
                }
            }
        }
        #else
        ZoomableImage(image: loadedImage, zoomScale: $zoomScale, onSingleTap: onDismiss)
            .matchedGeometryEffect(id: currentURL?.absoluteString ?? "", in: namespace)
            .offset(
                x: isDraggingToDismiss ? dismissDrag.width * 0.3 : 0,
                y: isDraggingToDismiss ? dismissDrag.height : 0
            )
            .scaleEffect(isDraggingToDismiss ? max(0.7, 1.0 - abs(dismissDrag.height) / 1000) : 1.0)
            // Swipe-to-dismiss runs on the parent; the scroll view consumes
            // its own pan when zoomed in, so this gesture only fires at 1x.
            .simultaneousGesture(dismissDragGesture())
        #endif
    }

    #if !os(macOS)
    private func dismissDragGesture() -> some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                guard abs(zoomScale - 1) < 0.01 else { return }
                // Only vertical drag dismisses; horizontal is ambiguous with
                // scroll view's own recognizer so we ignore it.
                guard abs(value.translation.height) > abs(value.translation.width) else { return }
                dismissDrag = value.translation
                let progress = min(abs(value.translation.height) / 300, 1.0)
                backgroundOpacity = Double(1.0 - progress * 0.6)
            }
            .onEnded { value in
                guard dismissDrag != .zero else { return }
                let vy = value.velocity.height
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
    #endif

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

    #if os(macOS)
    private func resetZoom() {
        scale = 1.0; lastScale = 1.0
        offset = .zero; lastOffset = .zero
    }

    /// Pinch + pan + swipe-to-dismiss for macOS (trackpad / mouse wheel).
    private func macOSZoomGesture(containerSize: CGSize) -> some Gesture {
        SimultaneousGesture(MagnifyGesture(), DragGesture())
            .onChanged { value in
                if let magnification = value.first?.magnification {
                    scale = max(0.5, min(lastScale * magnification, 10.0))
                }
                if let translation = value.second?.translation {
                    if scale > 1.01 {
                        offset = CGSize(
                            width: lastOffset.width + translation.width / scale,
                            height: lastOffset.height + translation.height / scale
                        )
                    } else if value.first == nil {
                        dismissDrag = translation
                        let progress = min(abs(translation.height) / 300, 1.0)
                        backgroundOpacity = Double(1.0 - progress * 0.6)
                    }
                }
            }
            .onEnded { value in
                lastScale = scale
                if scale < 1.0 {
                    withAnimation(.spring(duration: 0.3)) { resetZoom() }
                }
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
    #endif
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
            url: "https://example.com/fake.m3u8",
            thumbnailUrl: "https://picsum.photos/seed/slowfeed5/800/450"
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
