#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(MineradioPlugin, "Mineradio",
           CAP_PLUGIN_METHOD(echo, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(neteaseRequest, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(httpRequest, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(setCookies, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(clearCookies, CAPPluginReturnPromise);
)
