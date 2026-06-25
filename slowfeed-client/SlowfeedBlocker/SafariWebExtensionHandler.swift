import SafariServices

/// Native handler for the Slowfeed Blocker Safari Web Extension. The blocking
/// logic lives entirely in the JS content scripts; this exists only because
/// Safari requires a principal class for the extension. It's a no-op message
/// echo — there's no native ↔ JS messaging in this extension.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["ok": true]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
