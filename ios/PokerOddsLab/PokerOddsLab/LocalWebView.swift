import SwiftUI
import UniformTypeIdentifiers
import WebKit

struct LocalWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(LocalAssetSchemeHandler(directoryName: "WebApp"), forURLScheme: "pokerodds")
        configuration.userContentController.addUserScript(WKUserScript(
            source: """
            window.POKER_ODDS_LAB_FORCE_LOCAL = true;
            window.POKER_ODDS_LAB_IOS = true;
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        configuration.userContentController.add(context.coordinator, name: "nativeSim")

        let webView = WKWebView(frame: .zero, configuration: configuration)
        context.coordinator.webView = webView
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.isOpaque = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.alwaysBounceHorizontal = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.load(URLRequest(url: URL(string: "pokerodds://app/index.html")!))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        weak var webView: WKWebView?

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            let scheme = navigationAction.request.url?.scheme?.lowercased()
            if scheme == "pokerodds" || scheme == "about" {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
            }
        }
    }
}

final class LocalAssetSchemeHandler: NSObject, WKURLSchemeHandler {
    private let directoryName: String

    init(directoryName: String) {
        self.directoryName = directoryName
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url else {
            fail(urlSchemeTask)
            return
        }

        let root = Bundle.main.resourceURL?
            .appendingPathComponent(directoryName, isDirectory: true)
            .standardizedFileURL

        guard let root else {
            fail(urlSchemeTask)
            return
        }

        let rawPath = requestURL.path == "/" || requestURL.path.isEmpty ? "/index.html" : requestURL.path
        let relativePath = String(rawPath.drop(while: { $0 == "/" }))
        let fileURL = root.appendingPathComponent(relativePath, isDirectory: false).standardizedFileURL
        let rootPath = root.path.hasSuffix("/") ? root.path : root.path + "/"

        guard fileURL.path.hasPrefix(rootPath), let data = try? Data(contentsOf: fileURL) else {
            fail(urlSchemeTask)
            return
        }

        let response = URLResponse(
            url: requestURL,
            mimeType: mimeType(for: fileURL),
            expectedContentLength: data.count,
            textEncodingName: "utf-8"
        )
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func fail(_ task: WKURLSchemeTask) {
        task.didFailWithError(URLError(.fileDoesNotExist))
    }

    private func mimeType(for url: URL) -> String {
        let ext = url.pathExtension.lowercased()
        if #available(iOS 14.0, *), let mimeType = UTType(filenameExtension: ext)?.preferredMIMEType {
            return mimeType
        }
        switch ext {
        case "html": return "text/html"
        case "css": return "text/css"
        case "js": return "text/javascript"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        default: return "application/octet-stream"
        }
    }
}
