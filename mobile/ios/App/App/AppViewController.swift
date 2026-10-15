import Capacitor

// App-local plugins aren't registered by Capacitor's package discovery.
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(QRScannerPlugin())
        bridge?.registerPluginInstance(PushConfigurationPlugin())
    }
}

@objc(PushConfigurationPlugin)
public class PushConfigurationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PushConfigurationPlugin"
    public let jsName = "PushConfiguration"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getConfiguration", returnType: CAPPluginReturnPromise)
    ]

    @objc func getConfiguration(_ call: CAPPluginCall) {
        do {
            let environment = try PushEnvironment.current()
            call.resolve(["environment": environment, "topic": Bundle.main.bundleIdentifier ?? "dev.sealwire.mobile"])
        } catch {
            call.reject("APNs environment is unavailable; check the Push Notifications entitlement", nil, error)
        }
    }
}
