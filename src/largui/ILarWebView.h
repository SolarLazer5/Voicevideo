#pragma once

#include <functional>
#include <memory>
#include <string>

namespace largui {

// LarGui 跨平台 WebView 抽象接口
// Windows 下由 WebView2 实现，macOS/Linux 下由各自平台后端实现。
class ILarWebView
{
public:
    virtual ~ILarWebView() = default;

    // 生命周期
    virtual bool Create(const std::string& title, int x, int y,
                        int width, int height, bool frameless) = 0;
    virtual void Destroy() = 0;
    virtual void Run() = 0;
    virtual void Terminate() = 0;

    // 窗口控制
    virtual void Show(bool visible) = 0;
    virtual void SetSize(int width, int height) = 0;
    virtual void SetTitle(const std::string& title) = 0;
    virtual void* GetNativeWindow() = 0;

    // Web 内容
    virtual void Navigate(const std::string& url) = 0;
    virtual void LoadHtml(const std::string& html, const std::string& baseUri = {}) = 0;
    virtual void Reload() = 0;

    // JS 互操作
    using ScriptCallback = std::function<void(bool ok, const std::string& result)>;
    virtual void ExecuteScript(const std::string& script, ScriptCallback cb = nullptr) = 0;
    virtual void PostWebMessage(const std::string& message) = 0;

    // 消息回调（JS -> Native）
    using MessageHandler = std::function<void(const std::string& message)>;
    virtual void SetMessageHandler(MessageHandler handler) = 0;

    // 原生功能绑定
    using NativeCallHandler = std::function<std::string(const std::string& req)>;
    virtual void BindNativeCall(const std::string& name, NativeCallHandler handler) = 0;
};

// 工厂函数：创建当前平台对应的 WebView 后端
std::unique_ptr<ILarWebView> CreateWebView();

} // namespace largui
