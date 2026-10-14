#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Folia iOS 独立版 · 自组装脚本（在 CI 或本地运行）

流程：
  1. 下载 Folia 上游源码（codeload）
  2. 修依赖（去掉后端/原生模块）+ npm install
  3. 以相对地址构建 Web 包（vite build，API 指向应用内桥接层）
  4. 注入桥接层（mr-standalone.js + folia-bridge.js + qrcode.js），关闭 Service Worker
  5. 下载 iOS 工程骨架（Capacitor）并打补丁（Info.plist / pbxproj / 原生插件）
  6. 补丁 capacitor.config.json（webDir=dist）

用法:
  python3 apply.py --out . [--skip-build] [--src-folia DIR] [--src-ios DIR]
"""
import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile

FOLIA_ZIP = "https://codeload.github.com/chthollyphile/folia-major/zip/refs/heads/main"
IOS_ZIP = "https://codeload.github.com/xxyyht-design/Mineradio-v2-iOS-Standalone/zip/refs/heads/main"
QRCODE_URL = "https://unpkg.com/qrcode-generator@1.4.4/qrcode.js"

# 后端/原生专用依赖（Web 构建不需要，且其中两个在真机/CI 上装不动）
DROP_DEPS = [
    "kugoumusicapi",          # github 直链，CI 拉取会被墙
    "koffi",                  # 原生 FFI，需要 CMake 重新编译
    "onnxruntime-node",       # 原生推理库（AI 功能用）
    "electron-store",
    "electron-updater",
    "@xhayper/discord-rpc",
]
CAPACITOR_DEPS = {
    "@capacitor/cli": "8.4.2",
    "@capacitor/core": "8.4.2",
    "@capacitor/ios": "8.4.2",
}

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PATCH_DIR = os.path.join(SCRIPT_DIR, "patch")

FAILS = []


def log(msg):
    print("[folia-apply] " + str(msg), flush=True)


def die(msg):
    print("[folia-apply][FATAL] " + str(msg), flush=True)
    sys.exit(1)


def must(cond, msg):
    if not cond:
        FAILS.append(msg)
        log("!! 校验失败: " + msg)


def download(url, dest):
    log("下载 " + url)
    for attempt in range(3):
        try:
            subprocess.run(["curl", "-sL", "--fail", "--retry", "2", "-o", dest, url], check=True)
            if os.path.getsize(dest) > 1000:
                return dest
        except Exception as e:
            log("第 %d 次失败: %s" % (attempt + 1, e))
    die("下载失败: " + url)


def unzip_first_dir(zip_path, out_dir):
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(out_dir)
    entries = [e for e in os.listdir(out_dir) if os.path.isdir(os.path.join(out_dir, e))]
    if not entries:
        die("解压目录为空: " + zip_path)
    return os.path.join(out_dir, sorted(entries)[0])


def read(path):
    with io.open(path, "r", encoding="utf-8") as f:
        return f.read()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def run(cmd, cwd=None, env=None, label=""):
    log("$ " + (label or " ".join(cmd[:3]) + " …"))
    e = dict(os.environ)
    e["ELECTRON_SKIP_BINARY_DOWNLOAD"] = "1"
    if env:
        e.update(env)
    r = subprocess.run(cmd, cwd=cwd, env=e)
    if r.returncode != 0:
        die("命令失败(%d): %s" % (r.returncode, " ".join(cmd[:4])))


def patch_json_deps(pkg_path, drop, add):
    d = json.loads(read(pkg_path))
    removed = []
    for k in drop:
        if k in d.get("dependencies", {}):
            d["dependencies"].pop(k)
            removed.append(k)
    if add:
        d.setdefault("dependencies", {}).update(add)
    d["dependencies"] = dict(sorted(d["dependencies"].items()))
    write(pkg_path, json.dumps(d, ensure_ascii=False, indent=2))
    log("依赖调整: 移除 %s；加入 %s" % (removed, list((add or {}).keys())))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--src-folia", help="本地 Folia 源码目录（不给则下载）")
    ap.add_argument("--src-ios", help="本地 iOS 骨架根目录（不给则下载）")
    ap.add_argument("--qrcode", help="本地 qrcode.js")
    ap.add_argument("--skip-build", action="store_true", help="复用已有 dist（本地调试用）")
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    tmp = os.path.join(out, ".build-src")
    os.makedirs(tmp, exist_ok=True)

    # ---------- 1. Folia 源码（固定落到 <out>/folia-build） ----------
    work_dir = os.path.join(out, "folia-build")
    if args.src_folia:
        folia = os.path.abspath(args.src_folia)
        if not os.path.isfile(os.path.join(folia, "package.json")):
            die("不是 Folia 源码目录: " + folia)
        log("Folia 源码（本地）: " + folia)
    else:
        if os.path.isdir(work_dir):
            log("清理旧的 folia-build")
            shutil.rmtree(work_dir, ignore_errors=True)
        zp = download(FOLIA_ZIP, os.path.join(tmp, "folia.zip"))
        inner = unzip_first_dir(zp, os.path.join(tmp, "folia"))
        os.makedirs(work_dir, exist_ok=True)
        for name in os.listdir(inner):
            shutil.move(os.path.join(inner, name), os.path.join(work_dir, name))
        folia = work_dir
        log("Folia 源码: " + folia)

    # ---------- 2. 依赖 ----------
    patch_json_deps(os.path.join(folia, "package.json"), DROP_DEPS, CAPACITOR_DEPS)
    if not args.skip_build:
        node_modules = os.path.join(folia, "node_modules")
        if os.path.isdir(node_modules):
            shutil.rmtree(node_modules, ignore_errors=True)
        run(["npm", "install", "--no-audit", "--no-fund", "--legacy-peer-deps",
             "--ignore-scripts"], cwd=folia, label="npm install")

    # ---------- 3. 构建 Web 包（API 指向应用内桥接层） ----------
    if not args.skip_build:
        run(["npx", "vite", "build"], cwd=folia, label="vite build", env={
            "VITE_NETEASE_API_BASE": "/neapi",
            "VITE_KUGOU_API_BASE": "/kgapi",
            "VITE_QQ_API_BASE": "/qqapi",
        })
    dist = os.path.join(folia, "dist")
    must(os.path.isdir(dist), "缺少 dist 构建产物")
    must(os.path.isfile(os.path.join(dist, "index.html")), "dist/index.html 不存在")

    # ---------- 4. 注入桥接层 ----------
    bridge_dir = os.path.join(dist, "bridge")
    os.makedirs(bridge_dir, exist_ok=True)
    for name in ("mr-standalone.js", "folia-bridge.js"):
        src = os.path.join(PATCH_DIR, name)
        must(os.path.isfile(src), "补丁缺失: " + name)
        shutil.copy(src, os.path.join(bridge_dir, name))
        log("注入 %s (%.1f KB)" % (name, os.path.getsize(src) / 1024.0))
    qr_dst = os.path.join(bridge_dir, "qrcode.js")
    if args.qrcode and os.path.exists(args.qrcode):
        shutil.copy(args.qrcode, qr_dst)
    else:
        download(QRCODE_URL, qr_dst)
    must(os.path.getsize(qr_dst) > 10000, "qrcode.js 体积异常")

    idx = os.path.join(dist, "index.html")
    html = read(idx)
    if "folia-bridge.js" not in html:
        before = html
        html = re.sub(r'<script id="vite-plugin-pwa:register-sw"[^>]*></script>', '', html)
        must(html != before, "未找到 register-sw 脚本（SW 未关闭）")
        anchor = '<script type="module"'
        must(anchor in html, "index.html 未找到主模块锚点")
        html = html.replace(anchor,
                            '<!-- Folia iOS 独立版桥接层 -->\n'
                            '  <script src="/bridge/qrcode.js"></script>\n'
                            '  <script src="/bridge/mr-standalone.js"></script>\n'
                            '  <script src="/bridge/folia-bridge.js"></script>\n'
                            '  ' + anchor, 1)
        write(idx, html)
        log("index.html 已注入桥接层并关闭 SW")

    # ---------- 5. iOS 工程骨架 ----------
    if args.src_ios:
        ios_src = os.path.join(os.path.abspath(args.src_ios), "ios")
    else:
        zp = download(IOS_ZIP, os.path.join(tmp, "ios.zip"))
        root = unzip_first_dir(zp, os.path.join(tmp, "iosrepo"))
        ios_src = os.path.join(root, "ios")
    if not os.path.isdir(ios_src):
        die("找不到 iOS 骨架: " + ios_src)

    ios_dst = os.path.join(folia, "ios")
    if os.path.isdir(ios_dst):
        shutil.rmtree(ios_dst, ignore_errors=True)
    shutil.copytree(ios_src, ios_dst)
    log("ios/ <- Capacitor 工程骨架")
    log("构建目录: " + folia + "（CI 后续步骤在此执行 cap sync / xcodebuild）")

    app_dir = os.path.join(ios_dst, "App", "App")
    for fn in ("MineradioPlugin.swift", "MineradioPlugin.m"):
        src = os.path.join(PATCH_DIR, "ios", fn)
        must(os.path.isfile(src), "补丁缺失: ios/" + fn)
        shutil.copy(src, os.path.join(app_dir, fn))
    log("原生插件已就位（URLSession 通道 + Cookie）")

    # Info.plist：横屏优先 + 允许 http 资源
    plist = os.path.join(app_dir, "Info.plist")
    t = read(plist)
    old_orient = ("\t<key>UISupportedInterfaceOrientations</key>\n\t<array>\n"
                  "\t\t<string>UIInterfaceOrientationPortrait</string>\n"
                  "\t\t<string>UIInterfaceOrientationLandscapeLeft</string>\n"
                  "\t\t<string>UIInterfaceOrientationLandscapeRight</string>\n\t</array>")
    new_orient = ("\t<key>UISupportedInterfaceOrientations</key>\n\t<array>\n"
                  "\t\t<string>UIInterfaceOrientationLandscapeLeft</string>\n"
                  "\t\t<string>UIInterfaceOrientationLandscapeRight</string>\n"
                  "\t\t<string>UIInterfaceOrientationPortrait</string>\n\t</array>\n"
                  "\t<key>NSAppTransportSecurity</key>\n\t<dict>\n"
                  "\t\t<key>NSAllowsArbitraryLoads</key>\n\t\t<true/>\n"
                  "\t\t<key>NSAllowsArbitraryLoadsInWebContent</key>\n\t\t<true/>\n\t</dict>")
    must(old_orient in t, "Info.plist 未找到方向配置锚点")
    t = t.replace(old_orient, new_orient)
    # App 显示名（脚手架里写死了 Mineradio）
    t = t.replace("<key>CFBundleDisplayName</key>\n        <string>Mineradio</string>",
                  "<key>CFBundleDisplayName</key>\n        <string>Folia</string>")
    if "<string>Folia</string>" not in t:
        # 兼容不同缩进
        t = t.replace("<key>CFBundleDisplayName</key>\n\t<string>Mineradio</string>",
                      "<key>CFBundleDisplayName</key>\n\t<string>Folia</string>")
    must("<string>Folia</string>" in t, "Info.plist 显示名未替换为 Folia")

    # 状态栏：Folia 是深色界面，默认黑色状态栏文字在上面几乎看不见 -> 改成白色。
    # 注意必须插到「最外层」dict 的闭合前（rfind），插到第一个 </dict> 会落到 ATS 子字典里而失效。
    if "UIStatusBarStyle" not in t:
        i = t.rfind("</dict>")
        if i > 0:
            t = t[:i] + (
                "\t<key>UIStatusBarStyle</key>\n\t<string>UIStatusBarStyleLightContent</string>\n"
            ) + t[i:]
    # 骨架里这项是 true，会让上面那行失效，必须改成 false
    t = t.replace(
        "<key>UIViewControllerBasedStatusBarAppearance</key>\n\t<true/>",
        "<key>UIViewControllerBasedStatusBarAppearance</key>\n\t<false/>")
    t = t.replace(
        "<key>UIViewControllerBasedStatusBarAppearance</key>\n        <true/>",
        "<key>UIViewControllerBasedStatusBarAppearance</key>\n        <false/>")
    # 构建号递增：CFBundleVersion 恒为 1 时，部分侧载工具对「同版本覆盖安装」会直接报错
    t = re.sub(r"<key>CFBundleVersion</key>\s*<string>[^<]*</string>",
               "<key>CFBundleVersion</key>\n\t<string>" + time.strftime("%Y%m%d%H") + "</string>", t, count=1)
    write(plist, t)
    log("已打补丁: Info.plist（横屏+竖屏 / ATS / 显示名 Folia / 白色状态栏）")

    # ---------- 5b. App 图标 / 启动图 ----------
    # 优先用仓库内置的确定性图标（本地渲染好的 1024 PNG），不依赖 CI 的 Chrome；
    # Chrome 渲染只作为「内置图标缺失时」的回退。同时重写 Contents.json 为
    # 单尺寸 universal 1024（Xcode 13+ 标准）—— 骨架的清单可能指向别的文件名，
    # 只换图片不换清单的话，实际用的还是骨架默认图标，桌面上就会「没有图标」。
    iconset = os.path.join(app_dir, "Assets.xcassets", "AppIcon.appiconset")
    os.makedirs(iconset, exist_ok=True)
    builtin_icon = os.path.join(PATCH_DIR, "assets", "folia-icon.png")
    icon_png = os.path.join(iconset, "AppIcon-512@2x.png")
    made = None
    if os.path.isfile(builtin_icon) and os.path.getsize(builtin_icon) > 5000:
        made = builtin_icon
        log("使用内置图标 patch/assets/folia-icon.png")
    svg_candidates = [
        os.path.join(folia, "dist", "icon.svg"),
        os.path.join(folia, "public", "icon.svg"),
    ]
    svg = next((p for p in svg_candidates if os.path.isfile(p)), None)
    if not made and svg:
        outdir = os.path.join(tmp, "icon")
        os.makedirs(outdir, exist_ok=True)
        made = os.path.join(outdir, "icon-1024.png")
        # 包一层深色底 + 留白，做成规范 App 图标
        wrapper = os.path.join(outdir, "icon.html")
        write(wrapper, """<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:1024px;height:1024px;background:#0b0d10;overflow:hidden}
.wrap{width:1024px;height:1024px;display:flex;align-items:center;justify-content:center}
img{width:760px;height:760px}
</style></head><body><div class="wrap"><img src="%s"></div></body></html>""" % os.path.basename(svg))
        shutil.copy(svg, os.path.join(outdir, os.path.basename(svg)))
        ok = False
        chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        if os.path.exists(chrome):
            try:
                subprocess.run([chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
                                "--hide-scrollbars", "--window-size=1024,1024",
                                "--screenshot=" + made, "file://" + wrapper],
                               check=True, capture_output=True, timeout=180)
                ok = os.path.isfile(made) and os.path.getsize(made) > 5000
            except Exception as e:
                log("!! Chrome 光栅化失败: %s" % e)
        if not ok:
            try:
                subprocess.run(["qlmanage", "-t", "-s", "1024", "-o", outdir, svg],
                               check=True, capture_output=True, timeout=120)
                alt = os.path.join(outdir, os.path.basename(svg) + ".png")
                if os.path.isfile(alt) and os.path.getsize(alt) > 5000:
                    shutil.move(alt, made)
                    ok = True
            except Exception as e:
                log("!! qlmanage 光栅化失败: %s" % e)
        if ok:
            # 1) 标准单尺寸位图（Contents.json 会指向它，无论骨架里有没有这个文件名都写一份）
            shutil.copy(made, icon_png)
            # 2) 覆盖骨架里可能存在的旧命名，避免残留默认图
            for fn in ("icon-1024.jpg", "icon1024.png", "AppIcon.png"):
                p2 = os.path.join(iconset, fn)
                if os.path.isfile(p2):
                    shutil.copy(made, p2)
            # 3) 重写 Contents.json：单尺寸 universal 1024（Xcode 13+ 标准做法）
            import json as _json
            with open(os.path.join(iconset, "Contents.json"), "w", encoding="utf-8") as f:
                _json.dump({
                    "images": [{"filename": "AppIcon-512@2x.png", "idiom": "universal",
                                "platform": "ios", "size": "1024x1024"}],
                    "info": {"author": "xcode", "version": 1}
                }, f, indent=2)
            # 4) 启动图
            for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
                sp = os.path.join(app_dir, "Assets.xcassets", "Splash.imageset", name)
                if os.path.isfile(sp):
                    shutil.copy(made, sp)
            log("App 图标/启动图已替换为 Folia（%.1f KB）" % (os.path.getsize(made) / 1024.0))
        else:
            must(False, "图标光栅化与内置图标均不可用 —— 这会导致桌面没有图标")
    else:
        log("!! 未找到 Folia 图标 SVG，保留原图标")

    # pbxproj：包名/版本 + 插件入编译
    pbx = os.path.join(ios_dst, "App", "App.xcodeproj", "project.pbxproj")
    t = read(pbx)
    t = t.replace("PRODUCT_BUNDLE_IDENTIFIER = com.mineradio.v2;",
                  "PRODUCT_BUNDLE_IDENTIFIER = com.folia.ios;")
    t = t.replace("MARKETING_VERSION = 1.0;", "MARKETING_VERSION = 0.7.18;")
    swift_bf, objc_bf = "AA00000000000000000000B1", "AA00000000000000000000B2"
    swift_fr, objc_fr = "AA00000000000000000000F1", "AA00000000000000000000F2"
    bf_anchor = ("\t\t504EC3081FED79650016851F /* AppDelegate.swift in Sources */ = "
                 "{isa = PBXBuildFile; fileRef = 504EC3071FED79650016851F /* AppDelegate.swift */; };")
    fr_anchor = ("\t\t504EC3071FED79650016851F /* AppDelegate.swift */ = "
                 "{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AppDelegate.swift; sourceTree = \"<group>\"; };")
    grp_anchor = "\t\t\t\t504EC3071FED79650016851F /* AppDelegate.swift */,"
    src_anchor = "\t\t\t\t504EC3081FED79650016851F /* AppDelegate.swift in Sources */,"
    for a, n in ((bf_anchor, "PBXBuildFile"), (fr_anchor, "PBXFileReference"),
                 (grp_anchor, "group"), (src_anchor, "Sources")):
        must(a in t, "pbxproj 未找到 %s 锚点" % n)
    t = t.replace(bf_anchor, bf_anchor + "\n"
                  "\t\t%s /* MineradioPlugin.swift in Sources */ = {isa = PBXBuildFile; fileRef = %s /* MineradioPlugin.swift */; };\n"
                  "\t\t%s /* MineradioPlugin.m in Sources */ = {isa = PBXBuildFile; fileRef = %s /* MineradioPlugin.m */; };" % (swift_bf, swift_fr, objc_bf, objc_fr))
    t = t.replace(fr_anchor, fr_anchor + "\n"
                  "\t\t%s /* MineradioPlugin.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = MineradioPlugin.swift; sourceTree = \"<group>\"; };\n"
                  "\t\t%s /* MineradioPlugin.m */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.objc; path = MineradioPlugin.m; sourceTree = \"<group>\"; };" % (swift_fr, objc_fr))
    t = t.replace(grp_anchor, grp_anchor + "\n"
                  "\t\t\t\t%s /* MineradioPlugin.swift */,\n"
                  "\t\t\t\t%s /* MineradioPlugin.m */," % (swift_fr, objc_fr))
    t = t.replace(src_anchor, src_anchor + "\n"
                  "\t\t\t\t%s /* MineradioPlugin.swift in Sources */,\n"
                  "\t\t\t\t%s /* MineradioPlugin.m in Sources */," % (swift_bf, objc_bf))
    must("MineradioPlugin.swift in Sources" in t, "pbxproj 插件未入编译清单")
    write(pbx, t)
    log("已打补丁: project.pbxproj（com.folia.ios / 插件入编译）")

    # ---------- 6. Capacitor 配置 ----------
    write(os.path.join(folia, "capacitor.config.json"), json.dumps({
        "appId": "com.folia.ios",
        "appName": "Folia",
        "webDir": "dist",
        "plugins": {
            "CapacitorHttp": {"enabled": True},
            "CapacitorCookies": {"enabled": True}
        },
        "ios": {
            # automatic：让 WKWebView 自动避开刘海/灵动岛与底部 Home 条。
            # 之前设成 never 会让内容伸到安全区底下被挡住（H5 没有任何 safe-area 处理）。
            "contentInset": "automatic",
            "backgroundColor": "#09090b",
            "allowsLinkPreview": False
        },
        "server": {"iosScheme": "capacitor"}
    }, ensure_ascii=False, indent=2))
    log("capacitor.config.json 已写入（webDir=dist）")

    shutil.rmtree(tmp, ignore_errors=True)

    # ---------- 自检 ----------
    checks = [
        (os.path.join(dist, "index.html"), "Web 入口"),
        (os.path.join(bridge_dir, "mr-standalone.js"), "桥接基础设施"),
        (os.path.join(bridge_dir, "folia-bridge.js"), "Folia 路由"),
        (os.path.join(app_dir, "MineradioPlugin.swift"), "原生插件"),
        (os.path.join(ios_dst, "App", "App.xcodeproj", "project.pbxproj"), "Xcode 工程"),
        (os.path.join(ios_dst, "App", "App", "Assets.xcassets", "AppIcon.appiconset", "icon-1024.jpg"), "App 图标"),
        (os.path.join(folia, "capacitor.config.json"), "Capacitor 配置"),
    ]
    for path, name in checks:
        must(os.path.exists(path), "缺失: " + name + " -> " + path)
        log("OK  %s" % name)

    dist_size = sum(os.path.getsize(os.path.join(b, f))
                    for b, _, fs in os.walk(dist) for f in fs)
    log("Web 包体积: %.1f MB" % (dist_size / 1048576.0))

    if FAILS:
        log("==== 有 %d 项校验失败 ====" % len(FAILS))
        for f in FAILS:
            log("  - " + f)
        sys.exit(1)
    log("==== 组装完成 ====")


if __name__ == "__main__":
    main()
