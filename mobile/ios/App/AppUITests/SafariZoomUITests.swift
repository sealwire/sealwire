import XCTest

// Safari ignores user-scalable=no, so the remote page in a phone browser has to stop the
// pinch itself. Run through scripts/ios-safari-no-pinch-zoom-e2e.mjs, which serves the page.
final class SafariZoomUITests: XCTestCase {
    func testPinchDoesNotZoomTheRemotePageInSafari() throws {
        guard let url = ProcessInfo.processInfo.environment["SEALWIRE_REMOTE_URL"].flatMap(URL.init(string:)) else {
            throw XCTSkip("needs SEALWIRE_REMOTE_URL")
        }
        guard #available(iOS 16.4, *) else { throw XCTSkip("opening a URL in Safari needs iOS 16.4") }
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        safari.open(url)
        let menuButton = safari.webViews.buttons["Open sidebar"]
        XCTAssertTrue(menuButton.waitForExistence(timeout: 30), "Safari should render the remote page")
        sleep(1)

        let before = menuButton.frame
        safari.webViews.firstMatch.pinch(withScale: 3, velocity: 4)
        sleep(1)
        XCTAssertEqual(menuButton.frame.size, before.size, "pinching zoomed the remote page in Safari")
    }
}
