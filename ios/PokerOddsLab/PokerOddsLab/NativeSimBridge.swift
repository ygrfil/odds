import Foundation
import WebKit

@_silgen_name("odds_native_run_request_json")
private func oddsNativeRunRequestJson(_ ptr: UnsafePointer<UInt8>, _ len: Int) -> UnsafeMutablePointer<CChar>?

@_silgen_name("odds_native_free_string")
private func oddsNativeFreeString(_ ptr: UnsafeMutablePointer<CChar>?)

extension LocalWebView.Coordinator: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "nativeSim" else { return }
        guard let body = message.body as? [String: Any], let id = body["id"] as? String else { return }
        let requestData: Data
        if let requestJson = body["requestJson"] as? String {
            requestData = Data(requestJson.utf8)
        } else if let request = body["request"] {
            do {
                requestData = try JSONSerialization.data(withJSONObject: request, options: [])
            } catch {
                completeNativeRequest(id: id, ok: false, response: nil, error: "Native request payload is not valid JSON.")
                return
            }
        } else {
            completeNativeRequest(id: id, ok: false, response: nil, error: "Native request payload is missing.")
            return
        }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let response = try Self.runNativeSim(requestData: requestData)
                self?.completeNativeRequest(id: id, ok: true, response: response, error: nil)
            } catch {
                self?.completeNativeRequest(id: id, ok: false, response: nil, error: error.localizedDescription)
            }
        }
    }

    private static func runNativeSim(requestData: Data) throws -> [String: Any] {
        let outputPointer = requestData.withUnsafeBytes { rawBuffer -> UnsafeMutablePointer<CChar>? in
            guard let base = rawBuffer.bindMemory(to: UInt8.self).baseAddress else {
                return nil
            }
            return oddsNativeRunRequestJson(base, requestData.count)
        }
        guard let outputPointer else {
            throw NativeBridgeError.emptyNativeResponse
        }
        defer {
            oddsNativeFreeString(outputPointer)
        }

        let output = String(cString: outputPointer)
        guard let outputData = output.data(using: .utf8) else {
            throw NativeBridgeError.invalidNativeResponse
        }
        let value = try JSONSerialization.jsonObject(with: outputData, options: [])
        guard let response = value as? [String: Any] else {
            throw NativeBridgeError.invalidNativeResponse
        }
        return response
    }

    private func completeNativeRequest(id: String, ok: Bool, response: [String: Any]?, error: String?) {
        var payload: [String: Any] = [
            "id": id,
            "ok": ok
        ]
        if let response {
            payload["response"] = response
        }
        if let error {
            payload["error"] = error
        }

        guard
            let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
            let json = String(data: data, encoding: .utf8)
        else { return }

        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("window.__pokerOddsNativeSimComplete(\(json));")
        }
    }
}

private enum NativeBridgeError: LocalizedError {
    case emptyNativeResponse
    case invalidNativeResponse

    var errorDescription: String? {
        switch self {
        case .emptyNativeResponse:
            return "Native engine returned an empty response."
        case .invalidNativeResponse:
            return "Native engine returned invalid JSON."
        }
    }
}
