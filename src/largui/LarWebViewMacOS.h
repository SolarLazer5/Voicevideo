#pragma once

#include "ILarWebView.h"

namespace largui {

// macOS WebView 后端预留桩（当前未实现 WKWebView）
class LarWebViewMacOS : public ILarWebView
{
public:
    LarWebViewMacOS() = default;
    ~LarWebViewMacOS() override = default;

    bool Create(const std::string& title, int x, int y,
                int width, int height, bool frameless) override;
    void Destroy() override {}
    void Run() override {}
    void Terminate() override {}

    void Show(bool visible) override {}
    void SetSize(int width, int height) override {}
    void SetTitle(const std::string& title) override {}
    void* GetNativeWindow() override { return nullptr; }

    void Navigate(const std::string& url) override {}
    void LoadHtml(const std::string& html, const std::string& baseUri = {}) override {}
    void Reload() override {}

    void ExecuteScript(const std::string& script, ScriptCallback cb = nullptr) override;
    void PostWebMessage(const std::string& message) override {}

    void SetMessageHandler(MessageHandler handler) override {}
    void BindNativeCall(const std::string& name, NativeCallHandler handler) override {}
};

} // namespace largui
