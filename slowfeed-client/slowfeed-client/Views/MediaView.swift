import SwiftUI
import AVKit
import UniformTypeIdentifiers
import Photos
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// MARK: - Media Operations (Copy / Share)

/// Cross-platform copy / share / save for any `PostMedia`. Lives at module
/// scope so both the inline `MediaView` thumbnails and the
/// `ImageViewerOverlay` fullscreen gallery can present the same
/// long-press / right-click context menu.
///
/// Images are always re-encoded to JPEG (or PNG when they have
/// transparency) before copy/save. Source images are often HEIC / WebP,
/// and the system pasteboard otherwise writes a TIFF representation —
/// both behave badly when sent to Android / other platforms. Re-encoding
/// to a single, universally-supported type fixes that.
enum MediaOperations {

    // MARK: Copy

    static func copy(_ media: PostMedia) async {
        guard let data = await download(media) else { return }

        if media.type == "image", let norm = normalizedImage(from: data) {
            await MainActor.run {
                #if os(macOS)
                let pb = NSPasteboard.general
                pb.clearContents()
                pb.setData(norm.data, forType: NSPasteboard.PasteboardType(norm.utType.identifier))
                #else
                // Write a single, explicitly-typed representation (jpeg/png)
                // rather than UIPasteboard.image, which adds a TIFF rep.
                UIPasteboard.general.setData(norm.data, forPasteboardType: norm.utType.identifier)
                #endif
            }
            return
        }

        // Non-image (video / file): copy the file URL.
        let tempFileURL = writeTempFile(data: data, ext: fileExtension(for: media))
        await MainActor.run {
            #if os(macOS)
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.writeObjects([tempFileURL as NSURL])
            #else
            UIPasteboard.general.url = tempFileURL
            #endif
        }
    }

    // MARK: Share

    static func share(_ media: PostMedia) async {
        guard let data = await download(media) else { return }
        let shareURL = writeShareableFile(media: media, data: data)

        await MainActor.run {
            #if os(macOS)
            let picker = NSSharingServicePicker(items: [shareURL])
            if let window = NSApp.keyWindow, let contentView = window.contentView {
                picker.show(relativeTo: contentView.bounds, of: contentView, preferredEdge: .minY)
            }
            #else
            let activityVC = UIActivityViewController(activityItems: [shareURL], applicationActivities: nil)
            let top = topViewController()
            activityVC.popoverPresentationController?.sourceView = top?.view
            top?.present(activityVC, animated: true)
            #endif
        }
    }

    // MARK: Save to Files

    static func saveToFiles(_ media: PostMedia) async {
        guard let data = await download(media) else { return }
        let fileURL = writeShareableFile(media: media, data: data)

        await MainActor.run {
            #if os(macOS)
            let panel = NSSavePanel()
            panel.nameFieldStringValue = fileURL.lastPathComponent
            if panel.runModal() == .OK, let dest = panel.url {
                try? FileManager.default.removeItem(at: dest)
                try? FileManager.default.copyItem(at: fileURL, to: dest)
            }
            #else
            let picker = UIDocumentPickerViewController(forExporting: [fileURL], asCopy: true)
            topViewController()?.present(picker, animated: true)
            #endif
        }
    }

    // MARK: Save to Photos

    static func saveToPhotos(_ media: PostMedia) async {
        guard let data = await download(media) else { return }

        let granted = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                cont.resume(returning: status == .authorized || status == .limited)
            }
        }
        guard granted else { return }

        do {
            if media.type == "video" {
                let url = writeTempFile(data: data, ext: fileExtension(for: media))
                try await PHPhotoLibrary.shared().performChanges {
                    PHAssetCreationRequest.creationRequestForAssetFromVideo(atFileURL: url)
                }
            } else {
                // Save normalized JPEG/PNG bytes so the camera roll asset
                // isn't a stray HEIC/WebP/TIFF.
                let bytes = normalizedImage(from: data)?.data ?? data
                try await PHPhotoLibrary.shared().performChanges {
                    PHAssetCreationRequest.forAsset().addResource(with: .photo, data: bytes, options: nil)
                }
            }
        } catch {
            // Best-effort; matches the silent behavior of copy/share.
        }
    }

    // MARK: - Helpers

    private static func download(_ media: PostMedia) async -> Data? {
        guard let url = URL(string: media.url) else { return nil }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            return data
        } catch {
            return nil
        }
    }

    /// Re-encode image bytes to a portable type: PNG when the image has
    /// an alpha channel (to preserve transparency), JPEG otherwise.
    /// Returns nil if the data isn't a decodable image.
    static func normalizedImage(from data: Data) -> (data: Data, utType: UTType, ext: String)? {
        #if os(macOS)
        guard let nsImage = NSImage(data: data),
              let tiff = nsImage.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff) else { return nil }
        if rep.hasAlpha, let png = rep.representation(using: .png, properties: [:]) {
            return (png, .png, "png")
        }
        if let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.95]) {
            return (jpeg, .jpeg, "jpg")
        }
        return nil
        #else
        guard let image = UIImage(data: data) else { return nil }
        if imageHasAlpha(image), let png = image.pngData() {
            return (png, .png, "png")
        }
        if let jpeg = image.jpegData(compressionQuality: 0.95) {
            return (jpeg, .jpeg, "jpg")
        }
        return nil
        #endif
    }

    #if !os(macOS)
    private static func imageHasAlpha(_ image: UIImage) -> Bool {
        guard let alpha = image.cgImage?.alphaInfo else { return false }
        switch alpha {
        case .first, .last, .premultipliedFirst, .premultipliedLast:
            return true
        default:
            return false
        }
    }
    #endif

    private static func fileExtension(for media: PostMedia) -> String {
        let urlExt = URL(string: media.url)?.pathExtension ?? ""
        if !urlExt.isEmpty { return urlExt }
        switch media.type {
        case "video": return "mp4"
        case "image": return "jpg"
        default: return "bin"
        }
    }

    /// Write a temp file suitable for sharing / saving: normalized
    /// JPEG/PNG for images, the raw bytes for video / other.
    private static func writeShareableFile(media: PostMedia, data: Data) -> URL {
        if media.type == "image", let norm = normalizedImage(from: data) {
            return writeTempFile(data: norm.data, ext: norm.ext)
        }
        return writeTempFile(data: data, ext: fileExtension(for: media))
    }

    private static func writeTempFile(data: Data, ext: String) -> URL {
        let filename = "slowfeed_media_\(UUID().uuidString.prefix(8)).\(ext)"
        let tempURL = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        try? data.write(to: tempURL)
        return tempURL
    }

    #if !os(macOS)
    /// Topmost presented view controller, so we present over the gallery
    /// overlay / any open sheet rather than the bare root.
    @MainActor
    static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .first { $0.activationState == .foregroundActive } as? UIWindowScene
            ?? UIApplication.shared.connectedScenes.first as? UIWindowScene
        var top = scene?.keyWindow?.rootViewController
            ?? scene?.windows.first?.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }
    #endif
}

/// Reusable copy / save / share menu items for a single `PostMedia`.
/// Used by both the inline thumbnails and the fullscreen gallery viewer.
@ViewBuilder
func MediaContextMenuItems(_ media: PostMedia) -> some View {
    Button {
        Task { await MediaOperations.copy(media) }
    } label: {
        Label("Copy", systemImage: "doc.on.doc")
    }
    Button {
        Task { await MediaOperations.saveToPhotos(media) }
    } label: {
        Label("Save to Photos", systemImage: "photo.badge.arrow.down")
    }
    Button {
        Task { await MediaOperations.saveToFiles(media) }
    } label: {
        Label("Save to Files", systemImage: "folder.badge.plus")
    }
    Button {
        Task { await MediaOperations.share(media) }
    } label: {
        Label("Share", systemImage: "square.and.arrow.up")
    }
}

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
    /// True when the parent post is flagged NSFW. Combined with
    /// `appState.blurNSFW` this drives the per-post blur. Defaults to
    /// `false` so non-NSFW posts (and callers that don't care) never blur.
    var isNSFW: Bool = false

    @Environment(\.openURL) private var openURL
    @Environment(AppState.self) private var appState
    /// Per-MediaView (i.e. per-post) reveal flag. Tap-to-reveal lasts only as
    /// long as this view stays in memory; revisiting the post re-blurs.
    @State private var nsfwRevealed: Bool = false

    /// True iff blur should currently be applied. Encapsulates the AppState
    /// preference + the per-post reveal toggle so callsites stay terse.
    private var shouldBlurNSFW: Bool {
        isNSFW && appState.blurNSFW && !nsfwRevealed
    }

    private var images: [PostMedia] { media.filter { $0.type == "image" } }
    private var videos: [PostMedia] { media.filter { $0.type == "video" } }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if images.count == 1, let img = images.first, let url = URL(string: img.url) {
                imageThumb(url: url, media: img, index: 0)
                    // maxHeight too: without it a very tall image (or a
                    // degenerate intrinsic size from a failed load) can
                    // inflate the row into a screen-sized blank block.
                    // The image keeps its aspect ratio (.fit inside
                    // imageThumb) — tall images just render smaller; the
                    // gallery viewer still shows them full size.
                    .frame(maxWidth: 600, maxHeight: 700, alignment: .topLeading)
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
                // Pin width to the parent so the GeometryReader doesn't try
                // to take its parent's intrinsic content width on iPhone.
                .frame(maxWidth: .infinity)
                .frame(height: min(400, 300))
            }

            ForEach(videos, id: \.url) { vid in
                InlineVideoPlayer(media: vid)
                    // 600pt cap on both axes: landscape videos fill the width,
                    // vertical (9:16) videos cap at 600 tall instead of bloating
                    // up to 1000+pt.
                    .frame(maxWidth: 600, maxHeight: 600)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .blur(radius: shouldBlurNSFW ? 32 : 0)
                    .overlay {
                        if shouldBlurNSFW {
                            NSFWRevealOverlay { nsfwRevealed = true }
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }
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
        // Load the smaller thumbnail for the inline card, not the
        // full-resolution image. A long Bluesky thread renders many
        // images at once; decoding ~25 feed_fullsize bitmaps (2000px+,
        // ~12MB each decoded) at once blows the memory budget. The
        // fullsize URL is still what the gallery viewer loads (via
        // onSelectImage → `images`).
        let displayURL = media.thumbnailUrl.flatMap(URL.init(string:)) ?? url
        CachedImage(url: displayURL) {
            RoundedRectangle(cornerRadius: 8)
                .fill(.quaternary)
                .aspectRatio(4/3, contentMode: .fit)
        }
        .aspectRatio(contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        // NOTE: deliberately NO matchedGeometryEffect here. A thread
        // renders many image thumbnails into one shared namespace, and
        // the same fullsize URL recurs as a matched-geometry *source*
        // across re-renders → SwiftUI logs "Multiple inserted views ...
        // have isSource: true, results are undefined" and gives those
        // views zero/garbage geometry, so every image past the first
        // collapsed and appeared not to load. The open-into-gallery
        // hero animation isn't worth that; the viewer just cross-fades.
        .blur(radius: shouldBlurNSFW ? 32 : 0)
        // Pin a click region the size of the image so the reveal overlay
        // and the open-fullscreen tap don't both fire.
        .overlay {
            if shouldBlurNSFW {
                NSFWRevealOverlay { nsfwRevealed = true }
            }
        }
        .overlay(alignment: .bottomLeading) {
            if altText != nil, !shouldBlurNSFW {
                AltBadge()
                    .padding(8)
            }
        }
        .overlay(alignment: .topTrailing) {
            if let pos = galleryPosition, !shouldBlurNSFW {
                GalleryIndexBadge(current: pos.current, total: pos.total)
                    .padding(8)
            }
        }
        .accessibilityLabel(altText ?? "Image")
        .onTapGesture {
            // When blurred, the overlay handles taps. Otherwise open viewer.
            guard !shouldBlurNSFW else { return }
            onSelectImage?(images, index)
        }
    }

    @ViewBuilder
    private func mediaContextMenu(for media: PostMedia) -> some View {
        MediaContextMenuItems(media)
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

// MARK: - NSFW Reveal Overlay

/// Center-stamped "Show NSFW Content" affordance shown over a blurred image
/// or video thumbnail. Tapping anywhere on the overlay reveals the media for
/// the rest of this view's lifetime (no persisted reveal — privacy default).
struct NSFWRevealOverlay: View {
    var onReveal: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.15)
            VStack(spacing: 8) {
                Image(systemName: "eye.slash.fill")
                    .font(.title)
                Text("Sensitive Content")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                Text("Tap to show")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.85))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 14))
        }
        .contentShape(Rectangle())
        .onTapGesture { onReveal() }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Sensitive content. Tap to reveal.")
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
/// In-feed video preview. Renders a tappable thumbnail (poster image
/// with a play overlay) and opens the video in a fullscreen player on
/// tap — videos no longer play inline (MAR-70). The thumbnail's aspect
/// ratio is loaded from the asset itself so vertical videos preview
/// correctly even before the player opens.
struct InlineVideoPlayer: View {
    let media: PostMedia

    /// Falls back to 16:9 until the asset's natural size loads.
    @State private var aspectRatio: CGFloat = 16.0 / 9.0
    @State private var showFullscreen = false

    var body: some View {
        thumbnailPlaceholder
            .contentShape(Rectangle())
            .onTapGesture { showFullscreen = true }
            .task {
                guard let url = URL(string: media.url),
                      let ratio = await Self.loadAspectRatio(for: url),
                      ratio > 0 else { return }
                aspectRatio = ratio
            }
            #if os(iOS)
            .fullScreenCover(isPresented: $showFullscreen) {
                FullscreenVideoView(media: media, onDismiss: { showFullscreen = false })
            }
            #else
            .sheet(isPresented: $showFullscreen) {
                FullscreenVideoView(media: media, onDismiss: { showFullscreen = false })
                    .frame(minWidth: 600, minHeight: 400)
            }
            #endif
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

    /// Load the asset's natural aspect ratio, honoring `preferredTransform` so
    /// portrait videos recorded sideways still present as portrait.
    static func loadAspectRatio(for url: URL) async -> CGFloat? {
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
}

/// Fullscreen video player presented when the user taps an in-feed video
/// thumbnail. Loops, fills the screen, dismisses via the close button or
/// the player's own controls.
struct FullscreenVideoView: View {
    let media: PostMedia
    let onDismiss: () -> Void

    @State private var player: AVPlayer?
    @State private var loopObserver: NSObjectProtocol?
    #if !os(macOS)
    @State private var dismissDrag: CGSize = .zero
    @State private var backgroundOpacity: Double = 1.0
    #endif

    var body: some View {
        ZStack {
            Color.black
                #if !os(macOS)
                .opacity(backgroundOpacity)
                #endif
                .ignoresSafeArea()

            if let player {
                #if os(macOS)
                NativePlayerView(player: player)
                    .ignoresSafeArea()
                #else
                VideoPlayer(player: player)
                    .ignoresSafeArea()
                    .offset(y: dismissDrag.height)
                    .scaleEffect(dismissScale)
                #endif
            } else {
                ProgressView().tint(.white)
            }

            VStack {
                HStack {
                    Spacer()
                    Button(action: onDismiss) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title)
                            .foregroundStyle(.white.opacity(0.85))
                            .padding()
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
            #if !os(macOS)
            .opacity(backgroundOpacity)
            #endif
        }
        #if !os(macOS)
        // Swipe down (or up) anywhere on the video to dismiss, with
        // visual feedback as the user drags. Photos-app-style. (MAR-75)
        .simultaneousGesture(dismissDragGesture())
        #endif
        .onAppear { setupPlayer() }
        .onDisappear { teardownPlayer() }
    }

    #if !os(macOS)
    private var dismissScale: CGFloat {
        guard dismissDrag != .zero else { return 1.0 }
        return max(0.7, 1.0 - abs(dismissDrag.height) / 1000)
    }

    private func dismissDragGesture() -> some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                // Vertical-dominant drags only; horizontal pan should
                // pass through to the player's scrubber if it ever gets
                // recognized.
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

    private func setupPlayer() {
        guard let url = URL(string: media.url) else { return }
        let p = AVPlayer(url: url)
        loopObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: p.currentItem,
            queue: .main
        ) { _ in
            p.seek(to: .zero)
            p.play()
        }
        p.play()
        player = p
    }

    private func teardownPlayer() {
        player?.pause()
        if let observer = loopObserver {
            NotificationCenter.default.removeObserver(observer)
            loopObserver = nil
        }
        player = nil
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

/// One page inside the iOS image-viewer TabView: loads its own UIImage
/// (sharing the app's NSCache) and owns its own zoom state, so each image
/// in the gallery can be pinched independently and swiping resets to 1×
/// on each page.
///
/// `namespace` is retained for call-site compatibility but no longer
/// drives a matchedGeometryEffect — see the note in `imageThumb`. The
/// viewer cross-fades in instead of a hero zoom.
struct PagedZoomableImage: View {
    let url: URL
    var namespace: Namespace.ID?
    var onSingleTap: () -> Void

    @State private var image: UIImage?
    @State private var zoomScale: CGFloat = 1

    var body: some View {
        ZStack {
            Color.black
            if let image {
                ZoomableImage(image: image, zoomScale: $zoomScale, onSingleTap: onSingleTap)
            } else {
                ProgressView().tint(.white)
            }
        }
        .task(id: url) {
            if let cached = LoadedUIImage.cachedImage(for: url) {
                image = cached
                return
            }
            image = await LoadedUIImage.fetch(url: url)
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

    @FocusState private var isFocused: Bool
    @State private var showAltText: Bool = false

    // macOS-specific zoom + swipe-to-dismiss state. iOS uses
    // TabView(.page) + per-page ZoomableImage and tracks its own
    // dismiss drag below.
    #if os(macOS)
    @State private var scale: CGFloat = 1.0
    @State private var lastScale: CGFloat = 1.0
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero
    @State private var dismissDrag: CGSize = .zero
    @State private var backgroundOpacity: Double = 1.0
    #else
    /// iOS swipe-down-to-dismiss state. The TabView only handles
    /// horizontal pan, so a `.simultaneousGesture` here can capture
    /// vertical pan without fighting the page swipe.
    @State private var dismissDrag: CGSize = .zero
    @State private var backgroundOpacity: Double = 1.0
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
    private var currentMedia: PostMedia? {
        guard !images.isEmpty, safeIndex < images.count else { return nil }
        return images[safeIndex]
    }

    #if os(macOS)
    /// True when the user is dragging-to-dismiss at minimum zoom.
    private var isDraggingToDismiss: Bool {
        scale <= 1.0 && dismissDrag != .zero
    }
    #endif

    var body: some View {
        #if os(macOS)
        macOSBody
        #else
        iOSBody
        #endif
    }

    #if os(macOS)
    private var macOSBody: some View {
        GeometryReader { geo in
            ZStack {
                Color.black
                    .opacity(backgroundOpacity)
                    .ignoresSafeArea()
                    .onTapGesture { onDismiss() }

                imageLayer(containerSize: geo.size)
                    .contextMenu {
                        if let media = currentMedia {
                            MediaContextMenuItems(media)
                        }
                    }

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
        .onKeyPress(.escape) { onDismiss(); return .handled }
        .onKeyPress(.leftArrow) {
            if currentIndex > 0 { resetZoom(); withAnimation { currentIndex -= 1 } }
            return .handled
        }
        .onKeyPress(.rightArrow) {
            if currentIndex < imageURLs.count - 1 { resetZoom(); withAnimation { currentIndex += 1 } }
            return .handled
        }
    }
    #endif

    #if !os(macOS)
    /// iOS uses a paging TabView so swipes feel like the Photos app:
    /// finger-following with rubber-band and snap-to-page on release.
    /// Each page owns its own zoom state so you can pinch one image,
    /// swipe past it, and the next image starts at 1× — matching
    /// Photos. (MAR-67)
    ///
    /// Vertical drag dismisses the viewer (Photos-style) — the TabView
    /// only consumes horizontal pan, and each page's UIScrollView only
    /// pans vertically when zoomed in, so a top-level
    /// `simultaneousGesture` capturing vertical drags doesn't fight
    /// either of them.
    private var iOSBody: some View {
        ZStack {
            Color.black
                .opacity(backgroundOpacity)
                .ignoresSafeArea()

            TabView(selection: $currentIndex) {
                ForEach(Array(imageURLs.enumerated()), id: \.offset) { idx, url in
                    PagedZoomableImage(
                        url: url,
                        namespace: idx == safeIndex ? namespace : nil,
                        onSingleTap: onDismiss
                    )
                    .tag(idx)
                    .ignoresSafeArea()
                    .contextMenu {
                        if idx < images.count {
                            MediaContextMenuItems(images[idx])
                        }
                    }
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea()
            .offset(y: dismissDrag.height)
            .scaleEffect(dismissScale)
            .simultaneousGesture(dismissDragGesture())

            chrome
                .opacity(backgroundOpacity)
        }
        .focusable()
        .focused($isFocused)
        .onAppear { isFocused = true }
        .onChange(of: currentIndex) { _, _ in showAltText = false }
    }

    private var dismissScale: CGFloat {
        guard dismissDrag != .zero else { return 1.0 }
        return max(0.7, 1.0 - abs(dismissDrag.height) / 1000)
    }

    private func dismissDragGesture() -> some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                // Only respond to vertical-dominant pans so we don't
                // hijack the TabView's horizontal page swipe.
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

    /// Platform-split image layer: UIScrollView-backed on iOS for Photos-app
    /// fidelity (proper pinch anchoring, pan bounds, double-tap-at-location,
    /// bounce at limits) and the existing SwiftUI gesture approach on macOS
    /// (mouse input → the custom gesture code plays nicely enough there).
    #if os(macOS)
    /// macOS image layer: SwiftUI-based zoom/pan. The image is sized
    /// explicitly to the GeometryReader bounds and then aspect-fit
    /// inside — without the explicit frame, Image.resizable() +
    /// aspect-fit collapses around the image's intrinsic size.
    /// matchedGeometryEffect was previously here for the open-from-
    /// thumbnail animation but it locked the destination geometry to
    /// the (small) source thumbnail when the source had scrolled out
    /// of view, producing the "weird height" symptom — dropped on
    /// macOS until we have a more robust way to anchor it.
    @ViewBuilder
    private func imageLayer(containerSize: CGSize) -> some View {
        CachedImage(url: currentURL) {
            ProgressView().tint(.white)
        }
        .aspectRatio(contentMode: .fit)
        // Fill the GeometryReader's bounds so aspect-fit has a meaningful
        // proposal. Without an outer frame Image.resizable() + aspect-fit
        // collapses around the image's intrinsic size and the photo
        // renders much smaller than the available area.
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        #if os(macOS)
        .opacity(backgroundOpacity)
        #endif
    }

    #if os(macOS)
    private func navButton(systemName: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.largeTitle)
                .foregroundStyle(.white.opacity(0.85))
                // Explicit hit target — without this the click-through area
                // is just the thin SF Symbol glyph, which competes with the
                // imageLayer's MagnifyGesture/DragGesture and often loses.
                .frame(width: 48, height: 48)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

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
