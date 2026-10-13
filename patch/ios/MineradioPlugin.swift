import Foundation
import Capacitor
import AVFoundation
import MediaPlayer

/**
 * Mineradio Native API Plugin
 * 为 iOS 独立版提供无 CORS 的原生 HTTP 通道（URLSession + 持久 Cookie 会话），
 * 以及 iOS 播放必需的音频会话配置与锁屏/耳机控制。
 * 由 public/js/mr-standalone.js 通过 Capacitor.Plugins.Mineradio 调用。
 */
@objc(MineradioPlugin)
public class MineradioPlugin: CAPPlugin {

    // MARK: - 共享会话（扫码登录要靠连续的 Cookie 会话，不能每次新建）
    // 网易云 /api/login/qrcode/unikey 会 Set-Cookie，后续 /login/qrcode/client/login 必须带上
    // 同一个会话，否则服务端永远认为「未确认」。复用单例 URLSession + 显式把 Cookie 回传 JS。
    private static let sharedSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 25
        config.httpShouldSetCookies = true
        config.httpCookieAcceptPolicy = .always
        config.httpCookieStorage = HTTPCookieStorage.shared
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    private static var audioConfigured = false
    private static var remoteConfigured = false

    // MARK: - 生命周期

    public override func load() {
        configureAudioSession()
        configureRemoteCommands()
    }

    // MARK: - 音频会话（没有它，锁屏/切后台后 WKWebView 的播放会被系统掐断）

    private func configureAudioSession() {
        guard !MineradioPlugin.audioConfigured else { return }
        MineradioPlugin.audioConfigured = true
        DispatchQueue.main.async {
            do {
                let session = AVAudioSession.sharedInstance()
                // .playback：允许后台播放 + 锁屏继续出声
                try session.setCategory(.playback, mode: .default, options: [.allowAirPlay, .allowBluetooth])
                try session.setActive(true)
                NSLog("[Mineradio] AVAudioSession 已配置（后台播放可用）")
            } catch {
                NSLog("[Mineradio] AVAudioSession 配置失败: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - 锁屏 / 耳机 / 控制中心

    /// 把系统控制事件转发给 H5，由页面自己响应（不依赖具体前端实现）
    private func configureRemoteCommands() {
        guard !MineradioPlugin.remoteConfigured else { return }
        MineradioPlugin.remoteConfigured = true
        let cc = MPRemoteCommandCenter.shared()
        let emit: (String, MPRemoteCommand) -> Void = { [weak self] name, command in
            command.addTarget { _ in
                self?.notifyListeners("remoteCommand", data: ["command": name])
                return .success
            }
        }
        emit("play", cc.playCommand)
        emit("pause", cc.pauseCommand)
        emit("toggle", cc.togglePlayPauseCommand)
        emit("next", cc.nextTrackCommand)
        emit("previous", cc.previousTrackCommand)
        // 让控制中心始终显示播放控件（即便当前没有正在播放的 item）
        UIApplication.shared.beginReceivingRemoteControlEvents()
    }

    /// 由 H5 调用：更新锁屏上显示的歌曲信息
    @objc func setNowPlaying(_ call: CAPPluginCall) {
        var info: [String: Any] = [:]
        let title = call.getString("title") ?? ""
        let artist = call.getString("artist") ?? ""
        let album = call.getString("album") ?? ""
        let duration = call.getDouble("duration") ?? 0      // 秒
        let position = call.getDouble("position") ?? 0
        if !title.isEmpty { info[MPMediaItemPropertyTitle] = title }
        if !artist.isEmpty { info[MPMediaItemPropertyArtist] = artist }
        if !album.isEmpty { info[MPMediaItemPropertyAlbumTitle] = album }
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
        info[MPNowPlayingInfoPropertyPlaybackRate] = call.getBool("playing") ?? true ? 1.0 : 0.0

        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        // 封面（异步下载）
        if let cover = call.getString("cover"), let url = URL(string: cover), !cover.isEmpty {
            URLSession.shared.dataTask(with: url) { data, _, _ in
                guard let data = data, let image = UIImage(data: data) else { return }
                let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                DispatchQueue.main.async {
                    var merged = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                    merged[MPMediaItemPropertyArtwork] = artwork
                    MPNowPlayingInfoCenter.default().nowPlayingInfo = merged
                }
            }.resume()
        }
        call.resolve(["ok": true])
    }

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

        let session = MineradioPlugin.sharedSession
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
            // 把当前站点已存的 Cookie 回传，JS 侧据此维护自己的 cookie jar，
            // 下次请求显式带上 —— 这样即使系统 cookie storage 同步有延迟也不会丢会话。
            let cookieStr = HTTPCookieStorage.shared.cookies(for: url)?.map { "\($0.name)=\($0.value)" }
                .joined(separator: "; ") ?? ""
            var result: [String: Any] = [
                "status": http?.statusCode ?? 0,
                "body": text,
                "headers": headerMap,
                "cookies": cookieStr
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
