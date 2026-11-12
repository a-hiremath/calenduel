// Calenduel iPad: a menu-bar helper that reads a USB-connected iPad's screen the
// same way QuickTime's "New Movie Recording → iPad" does, and hands the latest
// frame to the Calenduel page over http://127.0.0.1. No QuickTime window and no
// screen-share picker: the page fetches frames while a session is running.
//
// Privacy: it listens on the loopback interface only, answers only the Origins
// below, captures only while a page is actually asking for frames, and keeps
// nothing on disk. The menu-bar icon turns red while it is capturing.
//
// Build and install: ./build.sh --install (see README.md).
import AppKit
import AVFoundation
import CoreImage
import CoreMediaIO
import Network
import ServiceManagement

let PORT: UInt16 = 47615
#if DEV // ./build.sh --dev: also answer the local vite dev server
let ALLOWED_ORIGINS: Set<String> = [
  "https://calenduel.com", "https://www.calenduel.com",
  "http://localhost:5173", "http://127.0.0.1:5173",
]
#else
let ALLOWED_ORIGINS: Set<String> = ["https://calenduel.com", "https://www.calenduel.com"]
#endif
let MAX_SIDE: CGFloat = 1600 // long side of served frames; the timelapse pane is smaller
let MAX_FPS = 4.0 // frames encoded per second at most; the page polls ~2/s
let IDLE_STOP = 10.0 // seconds without a frame request before capture stops
let SITE = URL(string: "https://calenduel.com/?ipadHelper=1")!

// MARK: - Capture

final class IPadCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  struct Frame { let jpeg: Data; let width: Int; let height: Int; let at: Date }

  // Guards latest, lastRequest and the two published flags.
  private let lock = NSLock()
  private var latest: Frame?
  private var lastRequest = Date.distantPast
  private var isConnected = false
  private var isCapturing = false
  // Touched on `frames` only.
  private var lastEncode: CFAbsoluteTime = 0
  private var held: CVPixelBuffer?
  private var flushQueued = false
  private let ci = CIContext()
  private let frames = DispatchQueue(label: "calenduel.ipad.frames")
  private let control = DispatchQueue(label: "calenduel.ipad.control")

  // Touched on `control` only.
  private var device: AVCaptureDevice?
  private var session: AVCaptureSession?

  var onChange: (() -> Void)?

  override init() {
    super.init()
    // iPad screens are hidden from AVFoundation until a process opts in. This is
    // per process, which is why Chrome can't see the iPad on its own.
    var prop = CMIOObjectPropertyAddress(
      mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
      mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
      mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
    var allow: UInt32 = 1
    CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &prop, 0, nil,
                              UInt32(MemoryLayout<UInt32>.size), &allow)
    // The device appears asynchronously, delivered on the main run loop. A
    // blocking wait on the main thread never sees it.
    for name in [AVCaptureDevice.wasConnectedNotification, AVCaptureDevice.wasDisconnectedNotification] {
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
        self?.control.async { self?.refreshDevice() }
      }
    }
    control.async { self.refreshDevice() }
  }

  private func findIPad() -> AVCaptureDevice? {
    let found = AVCaptureDevice.DiscoverySession(
      deviceTypes: [.external], mediaType: .muxed, position: .unspecified).devices
    return found.first { $0.modelID == "iOS Device" && $0.localizedName.lowercased().contains("pad") }
  }

  private func refreshDevice() {
    let now = findIPad()
    if now?.uniqueID == device?.uniqueID { return }
    stopSession()
    device = now
    lock.lock(); isConnected = now != nil; lock.unlock()
    onChange?()
  }

  // Called by the server for every frame request: keep (or start) capturing.
  func want() {
    lock.lock(); lastRequest = Date(); lock.unlock()
    control.async { if self.session == nil, self.device != nil { self.startSession() } }
  }

  // Runs every couple of seconds: stop when no page has asked for a while, and
  // pick up an iPad that was plugged in without a notification.
  func tick() {
    control.async {
      self.lock.lock(); let idle = Date().timeIntervalSince(self.lastRequest); self.lock.unlock()
      if self.session != nil, idle > IDLE_STOP { self.stopSession(); self.onChange?() }
      if self.session == nil { self.refreshDevice() }
    }
  }

  private func startSession() {
    guard let device else { return }
    let s = AVCaptureSession()
    guard let input = try? AVCaptureDeviceInput(device: device), s.canAddInput(input) else { return }
    s.addInput(input)
    let output = AVCaptureVideoDataOutput()
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    output.alwaysDiscardsLateVideoFrames = true
    output.setSampleBufferDelegate(self, queue: frames)
    guard s.canAddOutput(output) else { return }
    s.addOutput(output)
    s.startRunning() // blocks; that is why it runs on `control`
    session = s
    lock.lock(); isCapturing = true; lock.unlock()
    onChange?()
  }

  private func stopSession() {
    guard let s = session else { return }
    s.stopRunning()
    session = nil
    // Let any frame already being encoded finish first, then clear: a frame
    // left over from an earlier session must never be served as current.
    frames.sync { held = nil }
    lock.lock(); latest = nil; isCapturing = false; lock.unlock()
  }

  // At most MAX_FPS encodes, but never drop the LAST frame of a burst: the iPad
  // sends nothing more once its screen settles (after a page turn, or when it
  // locks), so a dropped final frame would leave a stale picture being served.
  func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer,
                     from connection: AVCaptureConnection) {
    guard let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
    held = pixels
    let wait = lastEncode + 1 / MAX_FPS - CFAbsoluteTimeGetCurrent()
    if wait <= 0 { encodeHeld(); return }
    if !flushQueued {
      flushQueued = true
      frames.asyncAfter(deadline: .now() + wait) { [weak self] in
        self?.flushQueued = false
        self?.encodeHeld()
      }
    }
  }

  private func encodeHeld() {
    guard let pixels = held else { return }
    held = nil
    lastEncode = CFAbsoluteTimeGetCurrent()
    var image = CIImage(cvPixelBuffer: pixels)
    let scale = min(1, MAX_SIDE / max(image.extent.width, image.extent.height))
    if scale < 1 { image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) }
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let jpeg = ci.jpegRepresentation(of: image, colorSpace: space,
            options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.75])
    else { return }
    let frame = Frame(jpeg: jpeg, width: Int(image.extent.width.rounded()),
                      height: Int(image.extent.height.rounded()), at: Date())
    lock.lock(); latest = frame; lock.unlock()
  }

  // The newest frame. The iPad only sends frames when its screen changes, so a
  // still page keeps the last one: that is still what the iPad shows.
  var frame: Frame? { lock.lock(); defer { lock.unlock() }; return latest }
  // Never wait on `control`: starting or stopping capture blocks it for seconds.
  var connected: Bool { lock.lock(); defer { lock.unlock() }; return isConnected }
  var capturing: Bool { lock.lock(); defer { lock.unlock() }; return isCapturing }
}

// MARK: - Loopback HTTP server

final class Server {
  private let capture: IPadCapture
  private var listener: NWListener?
  private let queue = DispatchQueue(label: "calenduel.ipad.server")

  init(capture: IPadCapture) { self.capture = capture }

  func start() throws {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: PORT)!)
    params.allowLocalEndpointReuse = true
    let listener = try NWListener(using: params)
    listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
    listener.stateUpdateHandler = { state in
      if case .failed(let error) = state {
        NSLog("Calenduel iPad: cannot listen on 127.0.0.1:\(PORT): \(error)")
        DispatchQueue.main.async { NSApp.terminate(nil) } // likely already running
      }
    }
    listener.start(queue: queue)
    self.listener = listener
  }

  private func accept(_ conn: NWConnection) {
    conn.start(queue: queue)
    // A client that never finishes its request headers gets dropped.
    queue.asyncAfter(deadline: .now() + 5) { if conn.state != .cancelled { conn.cancel() } }
    read(conn, buffer: Data())
  }

  private func read(_ conn: NWConnection, buffer: Data) {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, done, error in
      guard let self else { return }
      var buffer = buffer
      if let data { buffer.append(data) }
      if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
        self.respond(conn, head: String(decoding: buffer[..<end.lowerBound], as: UTF8.self))
      } else if done || error != nil || buffer.count > 16_384 {
        conn.cancel()
      } else {
        self.read(conn, buffer: buffer)
      }
    }
  }

  private func respond(_ conn: NWConnection, head: String) {
    let lines = head.components(separatedBy: "\r\n")
    let parts = lines.first?.split(separator: " ") ?? []
    let method = parts.count > 0 ? String(parts[0]) : ""
    let path = parts.count > 1 ? String(parts[1].split(separator: "?").first ?? "") : ""
    var origin: String?
    for line in lines.dropFirst() {
      if let colon = line.firstIndex(of: ":"),
         line[..<colon].trimmingCharacters(in: .whitespaces).lowercased() == "origin" {
        origin = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      }
    }
    // Browsers always send Origin on a cross-origin fetch. Anything else (another
    // site, an <img> tag, a request with no Origin) gets nothing.
    guard let origin, ALLOWED_ORIGINS.contains(origin) else {
      return send(conn, status: "403 Forbidden", headers: [:], body: Data())
    }
    var cors = [
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Cache-Control": "no-store",
    ]
    switch (method, path) {
    case ("OPTIONS", _):
      cors["Access-Control-Allow-Methods"] = "GET"
      cors["Access-Control-Allow-Private-Network"] = "true"
      cors["Access-Control-Max-Age"] = "600"
      send(conn, status: "204 No Content", headers: cors, body: Data())
    case ("GET", "/status"):
      let body: [String: Any] = [
        "app": "calenduel-ipad", "version": 1,
        "connected": capture.connected, "capturing": capture.capturing,
      ]
      cors["Content-Type"] = "application/json"
      send(conn, status: "200 OK", headers: cors,
           body: (try? JSONSerialization.data(withJSONObject: body)) ?? Data())
    case ("GET", "/frame"):
      capture.want()
      if let frame = capture.frame {
        cors["Content-Type"] = "image/jpeg"
        send(conn, status: "200 OK", headers: cors, body: frame.jpeg)
      } else {
        // 204: connected but no picture yet (a still iPad sends nothing until
        // its screen changes). 404: no iPad at all.
        send(conn, status: capture.connected ? "204 No Content" : "404 Not Found", headers: cors, body: Data())
      }
    default:
      send(conn, status: "404 Not Found", headers: cors, body: Data())
    }
  }

  private func send(_ conn: NWConnection, status: String, headers: [String: String], body: Data) {
    var head = "HTTP/1.1 \(status)\r\nConnection: close\r\nContent-Length: \(body.count)\r\n"
    for (k, v) in headers { head += "\(k): \(v)\r\n" }
    var out = Data((head + "\r\n").utf8)
    out.append(body)
    conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
  }
}

// MARK: - Menu bar

final class App: NSObject, NSApplicationDelegate {
  let capture = IPadCapture()
  lazy var server = Server(capture: capture)
  var item: NSStatusItem!
  let statusLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  let loginItem = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")

  func applicationDidFinishLaunching(_ note: Notification) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let menu = NSMenu()
    statusLine.isEnabled = false
    menu.addItem(statusLine)
    menu.addItem(.separator())
    menu.addItem(NSMenuItem(title: "Open Calenduel", action: #selector(openSite), keyEquivalent: ""))
    loginItem.target = self
    menu.addItem(loginItem)
    menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    for entry in menu.items where entry.action == #selector(openSite) { entry.target = self }
    item.menu = menu

    capture.onChange = { [weak self] in DispatchQueue.main.async { self?.render() } }
    do { try server.start() } catch { NSLog("Calenduel iPad: \(error)"); NSApp.terminate(nil) }
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      self?.capture.tick()
      self?.render()
    }

    // First launch: start at login, and tell the Calenduel page (in the default
    // browser) that this helper exists, so it starts asking for frames.
    if !UserDefaults.standard.bool(forKey: "launchedBefore") {
      UserDefaults.standard.set(true, forKey: "launchedBefore")
      try? SMAppService.mainApp.register()
      openSite()
    }
    render()
  }

  func render() {
    let connected = capture.connected
    let capturing = capture.capturing
    let image = NSImage(systemSymbolName: "ipad", accessibilityDescription: "Calenduel iPad")
    image?.isTemplate = !capturing
    item.button?.image = image
    item.button?.contentTintColor = capturing ? .systemRed : nil
    item.button?.appearsDisabled = !connected
    statusLine.title = capturing ? "Sending iPad screen to Calenduel"
      : connected ? "iPad connected · waiting for a session"
      : "No iPad · connect it by USB and tap Trust"
    loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
  }

  @objc func openSite() { NSWorkspace.shared.open(SITE) }

  @objc func toggleLogin() {
    if SMAppService.mainApp.status == .enabled { try? SMAppService.mainApp.unregister() }
    else { try? SMAppService.mainApp.register() }
    render()
  }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
