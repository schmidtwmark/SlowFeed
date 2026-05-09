import Foundation
import SwiftUI

extension String {
    /// Returns an `AttributedString` with detected URLs marked as links so SwiftUI
    /// renders them tappable. Plain (non-link) runs of text are unchanged.
    func linkified() -> AttributedString {
        var attributed = AttributedString(self)
        guard !isEmpty,
              let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return attributed
        }

        let nsString = self as NSString
        let fullRange = NSRange(location: 0, length: nsString.length)
        let matches = detector.matches(in: self, options: [], range: fullRange)

        for match in matches {
            guard let url = match.url,
                  let range = Range(match.range, in: self),
                  let attrRange = Range(range, in: attributed) else { continue }
            attributed[attrRange].link = url
        }

        return attributed
    }
}
