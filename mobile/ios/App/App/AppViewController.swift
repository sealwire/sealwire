import Capacitor

// The scanner lives in the app rather than an npm package, so nothing registers it for us.
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(QRScannerPlugin())
    }
}
