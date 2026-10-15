import XCTest

final class NativeFeelUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        XCTAssertTrue(menuButton.waitForExistence(timeout: 20), "the remote page should render its header")
    }

    private var webView: XCUIElement { app.webViews.firstMatch }
    private var menuButton: XCUIElement { app.webViews.buttons["Open sidebar"] }

    // No double-tap test: WebKit never double-tap-zooms a width=device-width page, so
    // one passes even with zooming switched on and proves nothing.
    func testPinchDoesNotZoomThePage() {
        let before = menuButton.frame
        webView.pinch(withScale: 3, velocity: 4)
        sleep(1)
        XCTAssertEqual(menuButton.frame.size, before.size, "pinching zoomed the page")
    }

    func testLongPressOnChromeShowsNoTextMenu() {
        // Opens the drawer for its captions: plain interface text in every state, where
        // the header title is sometimes a button that a long press simply clicks.
        menuButton.tap()
        let caption = app.webViews.staticTexts.containing(NSPredicate(format: "label MATCHES %@", "^[0-9]+ relays?$")).firstMatch
        XCTAssertTrue(caption.waitForExistence(timeout: 5), "the drawer should list relays")
        caption.press(forDuration: 1.2)
        sleep(1)
        let editMenu = app.menuItems.matching(NSPredicate(format: "label IN %@", ["Copy", "Look Up", "Translate", "Select All"]))
        XCTAssertEqual(editMenu.count, 0, "long-pressing interface text opened the copy menu")
    }

    // The simulator has no camera, so the native scanner's refusal is what proves the
    // button reached it rather than doing nothing.
    func testScanButtonReachesTheNativeScanner() throws {
        try XCTSkipIf(app.webViews.textViews.firstMatch.isEnabled, "a session is open, so neither the pairing screen nor the relay list shows")
        let scan = app.webViews.buttons["Scan QR code"]
        XCTAssertTrue(scan.waitForExistence(timeout: 5), "the pairing screen should offer a scan in the app")
        scan.tap()
        XCTAssertTrue(
            app.webViews.staticTexts["This device has no camera."].waitForExistence(timeout: 5),
            "tapping Scan QR code never reached the native scanner"
        )
    }

    private var statusBarBottom: CGFloat {
        XCUIApplication(bundleIdentifier: "com.apple.springboard").statusBars.firstMatch.frame.maxY
    }

    func testHeaderClearsTheStatusBar() {
        XCTAssertGreaterThan(statusBarBottom, 0)
        XCTAssertGreaterThanOrEqual(
            menuButton.frame.minY,
            statusBarBottom,
            "the header's buttons sit under the clock and battery"
        )
    }

    func testKeyboardDocksTheComposerAndKeepsTheHeader() throws {
        let composer = app.webViews.textViews.firstMatch
        try XCTSkipUnless(composer.isEnabled, "needs a paired relay with a session open")
        composer.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        sleep(1)

        XCTAssertFalse(app.toolbars["Toolbar"].exists, "the web form bar (previous / next / done) sits on the keyboard")
        XCTAssertGreaterThanOrEqual(menuButton.frame.minY, statusBarBottom, "the keyboard pushed the header off screen")
        let send = app.webViews.buttons["Send"]
        XCTAssertLessThanOrEqual(send.frame.maxY, keyboard.frame.minY, "the keyboard covers the composer")
        // The keyboard element's frame leaves out its suggestion row, so measure against
        // the web view, which the keyboard shrinks to end exactly at its visible top.
        XCTAssertLessThan(webView.frame.maxY - send.frame.maxY, 40, "the composer floats above the keyboard instead of resting on it")
    }

    func testClosedDrawerCastsNoShadowOnThePage() throws {
        sleep(1)
        let image = try XCTUnwrap(app.screenshot().image.cgImage)
        let y = image.height / 2
        let edge = try XCTUnwrap(rgb(image, x: 1, y: y))
        let page = try XCTUnwrap(rgb(image, x: 30, y: y))
        let difference = zip(edge, page).map { abs(Int($0) - Int($1)) }.max() ?? 0
        XCTAssertLessThanOrEqual(difference, 2, "the left edge is darker than the page: \(edge) vs \(page)")
    }

    func testIPhoneStaysUpright() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPad follows the device")
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        sleep(2)
        let window = app.windows.firstMatch.frame
        XCTAssertGreaterThan(window.height, window.width, "the app turned sideways")
    }

    private func rgb(_ image: CGImage, x: Int, y: Int) -> [UInt8]? {
        var pixel = [UInt8](repeating: 0, count: 4)
        guard let context = CGContext(
            data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.draw(image, in: CGRect(x: -x, y: y - image.height + 1, width: image.width, height: image.height))
        return Array(pixel[0..<3])
    }
}
