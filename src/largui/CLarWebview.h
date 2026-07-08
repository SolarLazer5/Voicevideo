#pragma once

#include "ILarWebView.h"

#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <wrl.h>
#include <WebView2.h>
#include <string>
#include <sstream>
#include <functional>
#include <stdexcept>
#include <map>

using namespace Microsoft::WRL;

namespace largui {

// Windows 平台 WebView2 实现
class CLarWebview : public ILarWebView
{
public:
    CLarWebview();
    ~CLarWebview() override;

    static BOOL Reg(HINSTANCE hInstance);

    // ILarWebView 实现
    bool Create(const std::string& title, int x, int y,
                int width, int height, bool frameless) override;
    void Destroy() override;
    void Run() override;
    void Terminate() override;

    void Show(bool visible) override;
    void SetSize(int width, int height) override;
    void SetTitle(const std::string& title) override;
    void* GetNativeWindow() override;

    void Navigate(const std::string& url) override;
    void LoadHtml(const std::string& html, const std::string& baseUri = {}) override;
    void Reload() override;

    void ExecuteScript(const std::string& script, ScriptCallback cb = nullptr) override;
    void PostWebMessage(const std::string& message) override;

    void SetMessageHandler(MessageHandler handler) override;
    void BindNativeCall(const std::string& name, NativeCallHandler handler) override;

    // 底层 wstring API（供内部或高级使用）
    BOOL CreateWin32(HWND pParent, int x, int y, int w, int h, UINT showflag, std::wstring htmlPath);
    HRESULT NavigateW(const std::wstring& url);
    HRESULT NavigateToStringW(const std::wstring& html);
    HRESULT ExecuteScriptW(const std::wstring& script,
        std::function<void(HRESULT, const std::wstring&)> callback = nullptr);
    HRESULT PostWebMessageW(const std::wstring& message);

    HWND GetHwnd() const { return m_hWnd; }
    BOOL IsInitialized() const { return m_bInitialized; }

protected:
    virtual void OnWebMessageReceived(const std::wstring& message);
    virtual void OnInitializationCompleted(HRESULT result) {}
    virtual LRESULT CALLBACK WndProc(HWND hWnd, UINT message, WPARAM wParam, LPARAM lParam);
    virtual LRESULT OnSize(WPARAM wParam, LPARAM lParam);
    virtual LRESULT OnDestroy(WPARAM wParam, LPARAM lParam);
    virtual LRESULT OnSetFocus(WPARAM wParam, LPARAM lParam);
    virtual LRESULT OnMouseActivate(WPARAM wParam, LPARAM lParam);
    virtual BOOL InitializeWebView2(std::wstring htmlPath);
    void InjectNativeCallBridge();

private:
    std::function<void(const std::wstring&)> m_webMessageHandler;
    std::map<std::string, NativeCallHandler> m_nativeCalls;
    ComPtr<ICoreWebView2> m_webView;
    ComPtr<ICoreWebView2Controller> m_controller;
    HWND   m_hWnd = nullptr;
    HWND   m_hParent = nullptr;
    BOOL   m_bInitialized = FALSE;
    BOOL   m_frameless = FALSE;
    EventRegistrationToken m_msgToken = {};
    EventRegistrationToken m_navToken = {};
    std::wstring m_pendingUrl;
    static BOOL      s_bool_isReg;
    static HINSTANCE s_hInstance;
    static LRESULT CALLBACK CLarWndProc(HWND hWnd, UINT message, WPARAM wParam, LPARAM lParam);

    void MakeFrameless();
    void UpdateWindowRgn();
    static std::wstring Utf8ToWide(const std::string& utf8);
    static std::string WideToUtf8(const std::wstring& wide);
};

} // namespace largui
