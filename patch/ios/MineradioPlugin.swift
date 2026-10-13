import Foundation
import Capacitor

/**
 * Mineradio Native API Plugin
 * 为 iOS 独立版提供无 CORS 的原生 HTTP 通道（URLSession + 持久 Cookie 会话）。
 * 由 public/js/mr-standalone.js 通过 Capacitor.Plugins.Mineradio 调用。
 */
@objc(MineradioPlugin)
public class MineradioPlugin: CAPPlugin {

    // MARK: - 基础

    @objc func echo(_ call: CAPPluginCall) {
        let value = call.getString("value") ?? ""
        call.resolve(["value": value])
    }

    @objc func neteaseRequest(_ call: CAPPluginCall) {
        // 预留：原生侧网易云加密请求（当前版本由 JS 桥接层直连公开接口实现）
        let path = call.getString("path") ?? ""
        call.resolve(["code": 200, "message": "unused", "path": path])
    }

    // MARK: - 通用 HTTP 请求（无 CORS，带 Cookie）

    @objc func httpRequest(_ call: CAPPluginCall) {
        guard let urlStr = call.getString("url"), let url = URL(string: urlStr) else {
            call.reject("invalid url")
            return
        }
        let method = (call.getString("method") ?? "GET").uppercased()
        let headers = call.getObject("headers") as? [String: String] ?? [:]
        let body = call.getString("body")
        // binary=true 时用 base64 回传原始字节，避免 UTF-8 解码把图片/加密响应破坏掉
        let wantsBinary = call.getBool("binary") ?? false

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 25
        req.cachePolicy = .reloadIgnoringLocalCacheData
        for (k, v) in headers {
            req.setValue(v, forHTTPHeaderField: k)
        }
        if let body = body, !body.isEmpty, method != "GET", method != "HEAD" {
            req.httpBody = body.data(using: .utf8)
            if req.value(forHTTPHeaderField: "Content-Type") == nil {
                req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            }
        }

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 25
        config.httpShouldSetCookies = true
        config.httpCookieAcceptPolicy = .always
        config.httpCookieStorage = HTTPCookieStorage.shared
        config.requestCachePolicy = .reloadIgnoringLocalCacheData

        let session = URLSession(configuration: config)
        session.dataTask(with: req) { data, response, error in
            if let error = error {
                call.reject("request failed: \(error.localizedDescription)")
                return
            }
            let http = response as? HTTPURLResponse
            var headerMap: [String: String] = [:]
            if let all = http?.allHeaderFields {
                for (k, v) in all {
                    headerMap["\(k)"] = "\(v)"
                }
            }
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            var result: [String: Any] = [
                "status": http?.statusCode ?? 0,
                "body": text,
                "headers": headerMap
            ]
            if wantsBinary, let data = data {
                result["bodyBase64"] = data.base64EncodedString()
            }
            call.resolve(result)
        }.resume()
    }

    // MARK: - Cookie 管理（用于「CK Cookie」登录方式与退出登录）

    @objc func setCookies(_ call: CAPPluginCall) {
        let cookieStr = call.getString("cookie") ?? ""
        let domain = call.getString("domain") ?? ".music.163.com"
        var count = 0
        for pair in cookieStr.split(separator: ";") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            guard kv.count == 2 else { continue }
            let name = kv[0].trimmingCharacters(in: .whitespacesAndNewlines)
            let value = kv[1].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { continue }
            let props: [HTTPCookiePropertyKey: Any] = [
                .name: name,
                .value: value,
                .domain: domain,
                .path: "/",
                .secure: "TRUE",
                .expires: Date(timeIntervalSinceNow: 60 * 60 * 24 * 365)
            ]
            if let cookie = HTTPCookie(properties: props) {
                HTTPCookieStorage.shared.setCookie(cookie)
                count += 1
            }
        }
        call.resolve(["ok": true, "count": count])
    }

    @objc func clearCookies(_ call: CAPPluginCall) {
        let domain = call.getString("domain") ?? "music.163.com"
        let storage = HTTPCookieStorage.shared
        var removed = 0
        storage.cookies?.forEach { cookie in
            if cookie.domain.contains(domain) {
                storage.deleteCookie(cookie)
                removed += 1
            }
        }
        call.resolve(["ok": true, "removed": removed])
    }
}
