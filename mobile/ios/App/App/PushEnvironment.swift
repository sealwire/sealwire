import Foundation

enum PushEnvironment {
    enum ConfigurationError: Error {
        case invalidProfile
        case missingEntitlement
    }

    static func current() throws -> String {
        #if targetEnvironment(simulator)
        return "development"
        #else
        let profile = try Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision")
            .map { try Data(contentsOf: $0) }
        return try fromProvisioningProfile(profile)
        #endif
    }

    static func fromProvisioningProfile(_ profile: Data?) throws -> String {
        // App Store installations have no embedded profile and use production APNs.
        guard let profile else { return "production" }
        guard let start = profile.range(of: Data("<?xml".utf8)),
              let end = profile.range(of: Data("</plist>".utf8), in: start.lowerBound..<profile.endIndex) else {
            throw ConfigurationError.invalidProfile
        }
        let plist = try PropertyListSerialization.propertyList(
            from: profile.subdata(in: start.lowerBound..<end.upperBound), options: [], format: nil
        ) as? [String: Any]
        guard let entitlements = plist?["Entitlements"] as? [String: Any],
              let environment = entitlements["aps-environment"] as? String,
              ["development", "production"].contains(environment) else {
            throw ConfigurationError.missingEntitlement
        }
        return environment
    }
}
