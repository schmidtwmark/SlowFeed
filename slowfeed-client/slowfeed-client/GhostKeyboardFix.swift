#if os(iOS)
import UIKit

/// Works around an iOS bug where switching apps can leave a stale keyboard
/// inset behind ("ghost keyboard"): the tab bar and content stay hoisted as
/// if a keyboard were on screen, and only killing the app clears it. It's a
/// system-level desync (visible in third-party apps too), typically after
/// backgrounding while another app's keyboard was up.
///
/// The defense: on every return to foreground, if no real first responder
/// exists (so the keyboard state SHOULD be "hidden"), focus and immediately
/// resign an invisible text field. The genuine keyboardWillShow/WillHide
/// round-trip makes UIKit re-evaluate its keyboard tracking and drop the
/// stale inset. Both calls happen in the same runloop turn, so no keyboard
/// is ever visibly presented.
enum GhostKeyboardFix {
    static func run() {
        guard let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene })
                .first(where: { $0.activationState == .foregroundActive }),
              let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first
        else { return }

        // A real first responder (user mid-typing when they left) means the
        // current keyboard state is legitimate — don't steal focus.
        guard window.slowfeedFindFirstResponder() == nil else { return }

        let field = UITextField(frame: .zero)
        field.isHidden = true
        field.autocorrectionType = .no
        window.addSubview(field)
        field.becomeFirstResponder()
        field.resignFirstResponder()
        field.removeFromSuperview()
    }
}

private extension UIView {
    func slowfeedFindFirstResponder() -> UIView? {
        if isFirstResponder { return self }
        for subview in subviews {
            if let responder = subview.slowfeedFindFirstResponder() { return responder }
        }
        return nil
    }
}
#endif
