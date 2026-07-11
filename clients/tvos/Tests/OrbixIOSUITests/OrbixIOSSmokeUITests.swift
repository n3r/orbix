import Foundation
import XCTest

final class OrbixIOSSmokeUITests: XCTestCase {
    private var baseURL: String = ""
    private var token: String = ""

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false

        let environment = ProcessInfo.processInfo.environment
        baseURL = environment["ORBIX_UI_TEST_BASE_URL"] ?? ""
        token = environment["ORBIX_UI_TEST_TOKEN"] ?? ""

        if baseURL.isEmpty || token.isEmpty {
            throw XCTSkip("Set ORBIX_UI_TEST_BASE_URL and ORBIX_UI_TEST_TOKEN to run OrbixIOS smoke UI tests.")
        }
    }

    @MainActor
    func testProfileTabCanSwitchProfile() throws {
        let app = launchApp()

        tapTab(.profile, in: app)

        XCTAssertTrue(app.staticTexts["Nikita"].waitForExistence(timeout: 12))
        XCTAssertTrue(app.staticTexts["Standard"].exists)

        let switchButton = app.buttons["switch-profile-button"]
        XCTAssertTrue(switchButton.waitForExistence(timeout: 5))
        switchButton.tap()

        XCTAssertTrue(app.staticTexts["Who's Watching?"].waitForExistence(timeout: 8))

        let profileButton = app.buttons["profile-button-profile-standard"]
        XCTAssertTrue(profileButton.waitForExistence(timeout: 8))
        profileButton.tap()

        XCTAssertTrue(app.scrollViews["rail-continue"].waitForExistence(timeout: 12))
    }

    @MainActor
    func testProfileTabCanChangeServerAfterConfirmation() throws {
        let app = launchApp()

        tapTab(.profile, in: app)

        let changeServerButton = app.buttons["change-server-button"]
        if !changeServerButton.waitForExistence(timeout: 8) {
            app.swipeUp()
        }
        XCTAssertTrue(changeServerButton.waitForExistence(timeout: 5), app.debugDescription)
        changeServerButton.tap()

        let confirmButton = app.buttons["confirm-change-server-button"].firstMatch
        if confirmButton.waitForExistence(timeout: 5) {
            confirmButton.tap()
        } else {
            app.buttons["Change Server"].firstMatch.tap()
        }

        XCTAssertTrue(app.staticTexts["Orbix"].waitForExistence(timeout: 8), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Connect to your home media server"].exists)
    }

    @MainActor
    func testRevokedTokenReturnsToPairing() throws {
        let app = launchApp()
        addTeardownBlock { [weak self] in
            self?.resetSmokeToken()
        }

        XCTAssertTrue(app.scrollViews["rail-continue"].waitForExistence(timeout: 12))
        revokeSmokeToken()

        tapTab(.browse, in: app)

        let pairingScreen = app.descendants(matching: .any)["pairing-screen"].firstMatch
        XCTAssertTrue(pairingScreen.waitForExistence(timeout: 12), app.debugDescription)
    }

    @MainActor
    func testLaunchRestoresStoredServerURLAfterRelaunch() throws {
        var app = launchApp()
        XCTAssertTrue(app.scrollViews["rail-continue"].waitForExistence(timeout: 12))
        app.terminate()

        app = launchApp(includeBaseURL: false)
        XCTAssertTrue(app.scrollViews["rail-continue"].waitForExistence(timeout: 12), app.debugDescription)
    }

    @MainActor
    func testLockedProfilePromptsForPinAndSelectsAfterUnlock() throws {
        let app = launchApp()

        tapTab(.profile, in: app)

        let switchButton = app.buttons["switch-profile-button"]
        XCTAssertTrue(switchButton.waitForExistence(timeout: 5))
        switchButton.tap()

        let lockedProfileButton = app.buttons["profile-button-profile-locked"]
        XCTAssertTrue(lockedProfileButton.waitForExistence(timeout: 8))
        lockedProfileButton.tap()

        XCTAssertTrue(app.staticTexts["profile-pin-title"].waitForExistence(timeout: 8), app.debugDescription)
        let pinField = app.secureTextFields["pin-entry-field"]
        XCTAssertTrue(pinField.waitForExistence(timeout: 5))
        pinField.tap()
        pinField.typeText("2468")

        let unlockButton = app.buttons["pin-unlock-button"]
        XCTAssertTrue(unlockButton.waitForExistence(timeout: 5))
        unlockButton.tap()

        XCTAssertTrue(app.scrollViews["rail-continue"].waitForExistence(timeout: 12))
        tapTab(.profile, in: app)
        XCTAssertTrue(app.staticTexts["Guest"].waitForExistence(timeout: 8))
    }

    @MainActor
    func testTitleCanBeSavedToMyListAndOpenedFromProfile() throws {
        let app = launchApp()
        resetSmokeWishlist()

        let heroInfoButton = app.buttons["hero-info-button"]
        XCTAssertTrue(heroInfoButton.waitForExistence(timeout: 12))
        heroInfoButton.tap()

        let wishlistToggle = app.buttons["wishlist-toggle-button"]
        XCTAssertTrue(wishlistToggle.waitForExistence(timeout: 12))
        wishlistToggle.tap()

        XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "In My List")).element.waitForExistence(timeout: 5))

        tapTab(.profile, in: app)

        let myListButton = app.buttons["my-list-button"]
        XCTAssertTrue(myListButton.waitForExistence(timeout: 8))
        myListButton.tap()

        let savedCard = app.buttons["my-list-card-movie-orbit"]
        XCTAssertTrue(savedCard.waitForExistence(timeout: 12))
        savedCard.tap()

        XCTAssertTrue(app.staticTexts["Orbital"].waitForExistence(timeout: 12))
    }

    @MainActor
    func testBrowseTabShowsLibraryGridAndOpensTitle() throws {
        let app = launchApp()

        tapTab(.browse, in: app)

        let libraryButton = app.buttons["browse-library-library-movies"]
        XCTAssertTrue(libraryButton.waitForExistence(timeout: 12))
        XCTAssertTrue(app.otherElements["browse-grid"].waitForExistence(timeout: 12))

        let card = app.buttons["browse-card-movie-comedy"]
        XCTAssertTrue(card.waitForExistence(timeout: 12))
        card.tap()

        XCTAssertTrue(app.staticTexts["Friday Plans"].waitForExistence(timeout: 12))
    }

    @MainActor
    func testBrowseCanSwitchLibrariesFilterAndOpenTitle() throws {
        let app = launchApp()

        tapTab(.browse, in: app)

        let familyLibrary = app.buttons["browse-library-library-family"]
        XCTAssertTrue(familyLibrary.waitForExistence(timeout: 12))
        familyLibrary.tap()

        let moonCard = app.buttons["browse-card-movie-family"]
        XCTAssertTrue(moonCard.waitForExistence(timeout: 12), app.debugDescription)
        let sharedComedyCard = app.buttons["browse-card-movie-comedy"]
        XCTAssertTrue(sharedComedyCard.waitForExistence(timeout: 8), app.debugDescription)

        let filterField = browseFilterField(in: app)
        XCTAssertTrue(filterField.waitForExistence(timeout: 5), app.debugDescription)
        filterField.tap()
        filterField.typeText("Moon")
        dismissKeyboard(in: app)

        XCTAssertTrue(moonCard.waitForExistence(timeout: 8), app.debugDescription)
        XCTAssertTrue(waitForNonExistence(sharedComedyCard), "Expected the library filter to hide Friday Plans")

        moonCard.tap()
        XCTAssertTrue(app.staticTexts["Moon Garden"].waitForExistence(timeout: 12))
        XCTAssertTrue(app.buttons["wishlist-toggle-button"].exists)
    }

    @MainActor
    func testSearchSuggestionRunsQueryAndOpensTitle() throws {
        let app = launchApp()

        tapTab(.search, in: app)

        let comedySuggestion = app.buttons["search-suggestion-comedy"]
        XCTAssertTrue(comedySuggestion.waitForExistence(timeout: 12), app.debugDescription)
        comedySuggestion.tap()

        let resultCard = app.buttons["search-card-movie-comedy"]
        XCTAssertTrue(resultCard.waitForExistence(timeout: 12), app.debugDescription)
        resultCard.tap()

        XCTAssertTrue(app.buttons["wishlist-toggle-button"].waitForExistence(timeout: 12))
        XCTAssertTrue(app.staticTexts["Friday Plans"].exists)
    }

    @MainActor
    func testHeroPlayOpensMoviePlayer() throws {
        let app = launchApp()
        resetSmokePlaybackStats()

        let heroPlayButton = app.buttons["hero-play-button"]
        XCTAssertTrue(heroPlayButton.waitForExistence(timeout: 12))
        heroPlayButton.tap()

        XCTAssertTrue(playerIsVisible(in: app))
        XCTAssertTrue(waitForSmokePlaybackRequest(fileId: "file-orbit"), "Expected AVPlayer to request the direct stream for file-orbit")

        let trackButton = app.buttons["player-track-button"]
        XCTAssertTrue(trackButton.waitForExistence(timeout: 8), app.debugDescription)
        trackButton.tap()

        XCTAssertTrue(app.staticTexts["track-panel-title"].waitForExistence(timeout: 5), app.debugDescription)
        let firstAudio = app.staticTexts["audio-track-0"]
        XCTAssertTrue(firstAudio.waitForExistence(timeout: 5))
        XCTAssertTrue(firstAudio.label.contains("AAC"), "Unexpected first audio row: \(firstAudio.label)")
        XCTAssertTrue(app.staticTexts["audio-track-1"].exists)
        XCTAssertTrue(app.staticTexts["subtitle-track-0"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["subtitle-track-1"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testContinueWatchingSeriesPrimaryActionOpensPlayer() throws {
        let app = launchApp()

        let continueRail = app.scrollViews["rail-continue"]
        XCTAssertTrue(continueRail.waitForExistence(timeout: 12))

        let seriesCard = app.buttons["rail-continue-card-series-night-signal"]
        if !seriesCard.isHittable {
            continueRail.swipeLeft()
        }
        XCTAssertTrue(seriesCard.waitForExistence(timeout: 5))
        seriesCard.tap()

        let seriesAction = app.buttons["series-primary-action"]
        XCTAssertTrue(seriesAction.waitForExistence(timeout: 12))
        XCTAssertTrue(seriesAction.label.contains("Continue S1E2"), "Unexpected series action label: \(seriesAction.label)")
        seriesAction.tap()

        XCTAssertTrue(playerIsVisible(in: app))
    }

    @MainActor
    func testSeriesSeasonChipOpensEpisodesAndPlayer() throws {
        let app = launchApp()

        let continueRail = app.scrollViews["rail-continue"]
        XCTAssertTrue(continueRail.waitForExistence(timeout: 12))

        let seriesCard = app.buttons["rail-continue-card-series-night-signal"]
        if !seriesCard.isHittable {
            continueRail.swipeLeft()
        }
        XCTAssertTrue(seriesCard.waitForExistence(timeout: 5))
        seriesCard.tap()

        let browseEpisodesButton = app.buttons["browse-episodes-button"]
        XCTAssertTrue(browseEpisodesButton.waitForExistence(timeout: 12))
        browseEpisodesButton.tap()

        let resumedEpisode = app.buttons["episode-card-episode-night-signal-2"]
        XCTAssertTrue(resumedEpisode.waitForExistence(timeout: 12))
        XCTAssertTrue(app.staticTexts["2. Cold Open"].exists)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Resume at 8m")).element.exists)

        resumedEpisode.tap()
        XCTAssertTrue(playerIsVisible(in: app))
    }

    @MainActor
    func testSeriesEpisodeAutoplaysNextEpisode() throws {
        let app = launchApp()

        let continueRail = app.scrollViews["rail-continue"]
        XCTAssertTrue(continueRail.waitForExistence(timeout: 12))

        let seriesCard = app.buttons["rail-continue-card-series-night-signal"]
        if !seriesCard.isHittable {
            continueRail.swipeLeft()
        }
        XCTAssertTrue(seriesCard.waitForExistence(timeout: 5))
        seriesCard.tap()

        let browseEpisodesButton = app.buttons["browse-episodes-button"]
        XCTAssertTrue(browseEpisodesButton.waitForExistence(timeout: 12))
        browseEpisodesButton.tap()

        let firstEpisode = app.buttons["episode-card-episode-night-signal-1"]
        XCTAssertTrue(firstEpisode.waitForExistence(timeout: 12))
        firstEpisode.tap()

        XCTAssertTrue(app.staticTexts["player-title"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["player-title"].label.contains("S1E1"))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "identifier == %@ AND label CONTAINS %@", "player-title", "S1E2")).element.waitForExistence(timeout: 18))
    }

    @MainActor
    private func launchApp(includeBaseURL: Bool = true) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = []
        if includeBaseURL {
            app.launchArguments.append(contentsOf: ["-orbixBaseURL", baseURL])
        }
        app.launchArguments.append(contentsOf: ["-orbixToken", token])
        app.launch()
        return app
    }

    @MainActor
    private func playerIsVisible(in app: XCUIApplication) -> Bool {
        let playerScreenVisible = app.otherElements["player-screen"].waitForExistence(timeout: 8)
        let closeButtonVisible = app.buttons["player-close-button"].waitForExistence(timeout: 4)
            || app.buttons["Close Player"].waitForExistence(timeout: 4)
        return playerScreenVisible || closeButtonVisible
    }

    private func revokeSmokeToken() {
        performSmokeControlRequest(path: "api/smoke/revoke-token", authorized: true)
    }

    private func resetSmokeToken() {
        performSmokeControlRequest(path: "api/smoke/reset-token", authorized: false)
    }

    private func resetSmokePlaybackStats() {
        performSmokeControlRequest(path: "api/smoke/reset-playback-stats", authorized: false)
    }

    private func resetSmokeWishlist() {
        performSmokeControlRequest(path: "api/smoke/reset-wishlist", authorized: false)
    }

    private func waitForSmokePlaybackRequest(fileId: String, timeout: TimeInterval = 8) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if smokePlaybackCount(bucket: "directRequestsByFileId", key: fileId) > 0 {
                return true
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return smokePlaybackCount(bucket: "directRequestsByFileId", key: fileId) > 0
    }

    @MainActor
    private func browseFilterField(in app: XCUIApplication) -> XCUIElement {
        let customField = app.textFields["browse-filter-field"]
        if customField.waitForExistence(timeout: 2) {
            return customField
        }

        let promptedTextField = app.textFields["Filter this library"]
        if promptedTextField.waitForExistence(timeout: 2) {
            return promptedTextField
        }

        let promptedField = app.searchFields["Filter this library"]
        if promptedField.waitForExistence(timeout: 2) {
            return promptedField
        }

        app.swipeDown()
        if promptedField.waitForExistence(timeout: 2) {
            return promptedField
        }

        return app.searchFields.firstMatch
    }

    @MainActor
    private func dismissKeyboard(in app: XCUIApplication) {
        let searchButton = app.keyboards.buttons["Search"]
        if searchButton.waitForExistence(timeout: 2) {
            searchButton.tap()
        }
    }

    private func waitForNonExistence(_ element: XCUIElement, timeout: TimeInterval = 8) -> Bool {
        let predicate = NSPredicate(format: "exists == false")
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    @MainActor
    private func tapTab(_ tab: OrbixUITab, in app: XCUIApplication) {
        let button = app.buttons[tab.accessibilityIdentifier]
        XCTAssertTrue(button.waitForExistence(timeout: 8), app.debugDescription)
        button.tap()
    }

    private func smokePlaybackCount(bucket: String, key: String) -> Int {
        guard let url = URL(string: "api/smoke/playback-stats", relativeTo: URL(string: baseURL)),
              let data = try? Data(contentsOf: url),
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let values = payload[bucket] as? [String: Any],
              let count = values[key] as? NSNumber else {
            return 0
        }
        return count.intValue
    }

    private func performSmokeControlRequest(path: String, authorized: Bool) {
        guard let url = URL(string: path, relativeTo: URL(string: baseURL)) else {
            XCTFail("Invalid smoke control URL for path \(path)")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        if authorized {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let expectation = expectation(description: "Smoke control request \(path)")
        URLSession.shared.dataTask(with: request) { _, response, error in
            if let error {
                XCTFail("Smoke control request failed: \(error)")
            } else if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                XCTFail("Smoke control request returned HTTP \(http.statusCode)")
            }
            expectation.fulfill()
        }.resume()
        wait(for: [expectation], timeout: 5)
    }
}

private enum OrbixUITab: String {
    case browse
    case profile
    case search

    var accessibilityIdentifier: String {
        "orbix-tab-\(rawValue)-button"
    }
}
