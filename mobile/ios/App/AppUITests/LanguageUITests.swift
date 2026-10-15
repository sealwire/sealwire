import XCTest

// The page takes its language from what the web view reports for the phone, so this is the
// one place that shows whether a Chinese phone actually gets the Chinese page.
final class LanguageUITests: XCTestCase {
    func testSimplifiedChinesePhoneGetsChinese() {
        assertChinesePage(phoneLanguage: "zh-Hans")
    }

    func testTraditionalChinesePhoneGetsChinese() {
        assertChinesePage(phoneLanguage: "zh-Hant")
    }

    private func assertChinesePage(phoneLanguage: String) {
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(\(phoneLanguage))"]
        app.launch()
        let menuButton = app.webViews.buttons["Open sidebar"]
        XCTAssertTrue(menuButton.waitForExistence(timeout: 20), "the remote page should render its header")
        menuButton.tap()
        let settings = app.webViews.buttons["Settings"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 5), "the drawer should have a Settings button")
        settings.tap()
        XCTAssertTrue(app.webViews.buttons["个性化"].waitForExistence(timeout: 5), "a \(phoneLanguage) phone got the English page")
    }
}
