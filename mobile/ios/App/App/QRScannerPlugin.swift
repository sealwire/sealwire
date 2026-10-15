import AVFoundation
import Capacitor
import UIKit

@objc(QRScannerPlugin)
public class QRScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "QRScannerPlugin"
    public let jsName = "QRScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise)
    ]

    private static let cameraOff = "Camera access is off for Sealwire. Turn it on in Settings › Sealwire › Camera."

    @objc func scan(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard AVCaptureDevice.default(for: .video) != nil else {
                call.reject("This device has no camera.", "no-camera")
                return
            }
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized:
                self.openScanner(call)
            case .notDetermined:
                AVCaptureDevice.requestAccess(for: .video) { granted in
                    DispatchQueue.main.async {
                        granted ? self.openScanner(call) : call.reject(Self.cameraOff, "camera-denied")
                    }
                }
            default:
                call.reject(Self.cameraOff, "camera-denied")
            }
        }
    }

    private func openScanner(_ call: CAPPluginCall) {
        guard let host = bridge?.viewController else {
            call.reject("The scanner could not open.", "unavailable")
            return
        }
        // The page sends its own wording, so the scanner matches the language the page shows.
        let labels = QRScannerViewController.Labels(
            cancel: call.getString("cancelLabel") ?? "Cancel",
            hint: call.getString("hint") ?? "Point at the pairing QR code in your relay's Settings › Devices."
        )
        let scanner = QRScannerViewController(labels: labels) { value in
            host.dismiss(animated: true)
            if let value {
                call.resolve(["value": value])
            } else {
                call.resolve(["cancelled": true])
            }
        }
        scanner.modalPresentationStyle = .fullScreen
        host.present(scanner, animated: true)
    }
}

final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    struct Labels {
        let cancel: String
        let hint: String
    }

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "dev.sealwire.qr-scanner")
    private let labels: Labels
    private let onFinish: (String?) -> Void
    private var finished = false

    init(labels: Labels, onFinish: @escaping (String?) -> Void) {
        self.labels = labels
        self.onFinish = onFinish
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureSession()

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)

        let frame = UIView()
        frame.translatesAutoresizingMaskIntoConstraints = false
        frame.layer.borderColor = UIColor.white.cgColor
        frame.layer.borderWidth = 3
        frame.layer.cornerRadius = 16
        view.addSubview(frame)

        let hint = UILabel()
        hint.translatesAutoresizingMaskIntoConstraints = false
        hint.text = labels.hint
        hint.textColor = .white
        hint.font = .preferredFont(forTextStyle: .callout)
        hint.numberOfLines = 0
        hint.textAlignment = .center
        view.addSubview(hint)

        let cancel = UIButton(type: .system)
        cancel.translatesAutoresizingMaskIntoConstraints = false
        cancel.setTitle(labels.cancel, for: .normal)
        cancel.setTitleColor(.white, for: .normal)
        cancel.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        view.addSubview(cancel)

        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            frame.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            frame.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            frame.widthAnchor.constraint(equalTo: view.widthAnchor, multiplier: 0.7),
            frame.heightAnchor.constraint(equalTo: frame.widthAnchor),
            hint.topAnchor.constraint(equalTo: frame.bottomAnchor, constant: 24),
            hint.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 32),
            hint.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -32),
            cancel.topAnchor.constraint(equalTo: guide.topAnchor, constant: 8),
            cancel.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
        ])
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        view.layer.sublayers?.compactMap { $0 as? AVCaptureVideoPreviewLayer }.forEach { $0.frame = view.bounds }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // startRunning blocks until the camera is up, which would freeze the slide-in.
        sessionQueue.async { [session] in session.startRunning() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        sessionQueue.async { [session] in session.stopRunning() }
    }

    private func configureSession() {
        guard let camera = AVCaptureDevice.default(for: .video) else { return }
        do {
            let input = try AVCaptureDeviceInput(device: camera)
            let output = AVCaptureMetadataOutput()
            guard session.canAddInput(input), session.canAddOutput(output) else {
                NSLog("QR scanner: the capture session refused the camera")
                return
            }
            session.addInput(input)
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
        } catch {
            NSLog("QR scanner: could not open the camera: \(error)")
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let code = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = code.stringValue else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        finish(value)
    }

    @objc private func cancelTapped() {
        finish(nil)
    }

    // The camera keeps reporting the same code until the session stops, so only the
    // first report may answer the call.
    private func finish(_ value: String?) {
        guard !finished else { return }
        finished = true
        onFinish(value)
    }
}
