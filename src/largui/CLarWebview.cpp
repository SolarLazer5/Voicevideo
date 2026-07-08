#include "CLarWebview.h"

#include <WebView2EnvironmentOptions.h>
#include <filesystem>
#include <fstream>
#include <atomic>
#include <spdlog/spdlog.h>

namespace fs = std::filesystem;

namespace largui {

namespace {
    std::wstring LoadUtf8File(const wchar_t* filename)
    {
        std::ifstream file(filename, std::ios::binary);
        if (!file) return L"";

        std::string str((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
        if (str.empty()) return L"";

        if (str.size() >= 3 &&
            static_cast<unsigned char>(str[0]) == 0xEF &&
            static_cast<unsigned char>(str[1]) == 0xBB &&
            static_cast<unsigned char>(str[2]) == 0xBF)
        {
            str = str.substr(3);
        }

        int size = MultiByteToWideChar(CP_UTF8, 0, str.c_str(), -1, nullptr, 0);
        if (size <= 0) return L"";

        std::wstring result(size - 1, L'\0');
        MultiByteToWideChar(CP_UTF8, 0, str.c_str(), -1, result.data(), size);
        return result;
    }

    std::wstring ToAbsolutePath(const std::wstring& path)
    {
        try {
            fs::path p(path);
            if (p.is_absolute())
                return p.lexically_normal().wstring();
            fs::path cur = fs::current_path();
            return (cur / p).lexically_normal().wstring();
        }
        catch (...) {
            return path;
        }
    }

    bool ResolveVirtualHostUrl(const std::wstring& htmlPath, std::wstring& outBaseDir, std::wstring& outUrl)
    {
        try {
            size_t qPos = htmlPath.find(L'?');
            std::wstring pathPart = (qPos == std::wstring::npos) ? htmlPath : htmlPath.substr(0, qPos);
            std::wstring queryPart = (qPos == std::wstring::npos) ? L"" : htmlPath.substr(qPos);

            fs::path absHtml = fs::weakly_canonical(ToAbsolutePath(pathPart));
            if (!fs::is_regular_file(absHtml))
                return false;

            fs::path htmlDir = absHtml.parent_path();
            fs::path baseDir = htmlDir.parent_path();
            if (baseDir.empty() || baseDir == htmlDir)
                return false;

            fs::path rel = fs::relative(absHtml, baseDir);
            std::wstring relUrl = rel.generic_wstring();
            if (relUrl.empty())
                return false;

            outBaseDir = baseDir.wstring();
            outUrl = std::wstring(L"https://openclaw.local/") + relUrl + queryPart;
            return true;
        }
        catch (...) {
            return false;
        }
    }
}

BOOL      CLarWebview::s_bool_isReg = FALSE;
HINSTANCE CLarWebview::s_hInstance = nullptr;

CLarWebview::CLarWebview()
{
}

CLarWebview::~CLarWebview()
{
    Destroy();
}

std::wstring CLarWebview::Utf8ToWide(const std::string& utf8)
{
    if (utf8.empty()) return L"";
    int size = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
    if (size <= 0) return L"";
    std::wstring result(size - 1, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, result.data(), size);
    return result;
}

std::string CLarWebview::WideToUtf8(const std::wstring& wide)
{
    if (wide.empty()) return "";
    int size = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, nullptr, 0, nullptr, nullptr);
    if (size <= 0) return "";
    std::string result(size - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, result.data(), size, nullptr, nullptr);
    return result;
}

BOOL CLarWebview::Reg(HINSTANCE hInstance)
{
    if (s_bool_isReg)
        return TRUE;

    using Fn = BOOL(WINAPI*)(DPI_AWARENESS_CONTEXT);
    if (HMODULE hUser = GetModuleHandleW(L"user32.dll"))
        if (Fn f = (Fn)GetProcAddress(hUser, "SetProcessDpiAwarenessContext"))
            f(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        else
            SetProcessDPIAware();

    WNDCLASS wc = {};
    wc.hInstance = hInstance;
    wc.lpfnWndProc = CLarWebview::CLarWndProc;
    wc.lpszClassName = L"CLarWebview2Class";
    wc.hbrBackground = NULL;
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    wc.style = CS_HREDRAW | CS_VREDRAW;

    if (RegisterClass(&wc) != 0)
    {
        s_hInstance = hInstance;
        s_bool_isReg = TRUE;
    }
    else
    {
        s_bool_isReg = FALSE;
    }
    return s_bool_isReg;
}

bool CLarWebview::Create(const std::string& title, int x, int y,
                         int width, int height, bool frameless)
{
    m_frameless = frameless ? TRUE : FALSE;
    std::wstring wtitle = Utf8ToWide(title);
    return CreateWin32(nullptr, x, y, width, height, SW_SHOW, L"");
}

BOOL CLarWebview::CreateWin32(HWND pParent, int x, int y, int w, int h, UINT showflag, std::wstring htmlPath)
{
    if (!s_bool_isReg)
        return FALSE;

    m_hParent = pParent;

    DWORD dwStyle;
    DWORD dwExStyle;
    if (pParent)
    {
        dwStyle = WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN;
        dwExStyle = 0;
    }
    else
    {
        if (m_frameless)
        {
            dwStyle = WS_POPUP | WS_VISIBLE;
            dwExStyle = WS_EX_NOREDIRECTIONBITMAP;
        }
        else
        {
            dwStyle = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_THICKFRAME;
            dwExStyle = WS_EX_NOREDIRECTIONBITMAP;
        }
    }

    m_hWnd = CreateWindowExW(
        dwExStyle,
        L"CLarWebview2Class",
        L"Lar Webview2 Client",
        dwStyle,
        x, y, w, h,
        pParent, nullptr, s_hInstance, this);

    if (!m_hWnd)
        return FALSE;

    spdlog::info("[CLarWebview] Window created, hwnd={}", reinterpret_cast<uintptr_t>(m_hWnd));

    ShowWindow(m_hWnd, showflag);
    UpdateWindow(m_hWnd);
    BringWindowToTop(m_hWnd);
    SetForegroundWindow(m_hWnd);
    SetActiveWindow(m_hWnd);

    if (!InitializeWebView2(htmlPath))
    {
        DestroyWindow(m_hWnd);
        m_hWnd = nullptr;
        return FALSE;
    }

    if (m_frameless)
    {
        MakeFrameless();
        UpdateWindowRgn();
    }

    return TRUE;
}

void CLarWebview::MakeFrameless()
{
    if (!m_hWnd) return;
    LONG style = GetWindowLong(m_hWnd, GWL_STYLE);
    style &= ~(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU);
    SetWindowLong(m_hWnd, GWL_STYLE, style);

    LONG exStyle = GetWindowLong(m_hWnd, GWL_EXSTYLE);
    exStyle &= ~(WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_DLGMODALFRAME);
    SetWindowLong(m_hWnd, GWL_EXSTYLE, exStyle);

    SetWindowPos(m_hWnd, nullptr, 0, 0, 0, 0,
        SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER);
}

void CLarWebview::UpdateWindowRgn()
{
    if (!m_hWnd || !m_frameless) return;

    RECT rc;
    GetWindowRect(m_hWnd, &rc);
    int w = rc.right - rc.left;
    int h = rc.bottom - rc.top;
    if (w <= 0 || h <= 0) return;

    HRGN rgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, 20, 20);
    if (rgn)
        SetWindowRgn(m_hWnd, rgn, TRUE);
}

void CLarWebview::Destroy()
{
    if (m_controller)
    {
        if (m_webView)
            m_webView->remove_WebMessageReceived(m_msgToken);

        m_controller->Close();
        m_controller = nullptr;
        m_webView = nullptr;
    }

    if (m_hWnd && ::IsWindow(m_hWnd))
    {
        ::DestroyWindow(m_hWnd);
        m_hWnd = nullptr;
    }

    m_bInitialized = FALSE;
}

void CLarWebview::Run()
{
    MSG msg;
    while (GetMessage(&msg, nullptr, 0, 0))
    {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
}

void CLarWebview::Terminate()
{
    if (!m_hParent)
        PostQuitMessage(0);
    Destroy();
}

void CLarWebview::Show(bool visible)
{
    if (m_hWnd && ::IsWindow(m_hWnd))
        ::ShowWindow(m_hWnd, visible ? SW_SHOW : SW_HIDE);

    if (m_controller)
        m_controller->put_IsVisible(visible ? TRUE : FALSE);
}

void CLarWebview::SetSize(int width, int height)
{
    if (!m_hWnd) return;
    RECT rect;
    GetWindowRect(m_hWnd, &rect);
    int x = rect.left;
    int y = rect.top;

    RECT clientRect;
    GetClientRect(m_hWnd, &clientRect);
    int borderW = (rect.right - rect.left) - clientRect.right;
    int borderH = (rect.bottom - rect.top) - clientRect.bottom;

    SetWindowPos(m_hWnd, nullptr, x, y, width + borderW, height + borderH,
        SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
}

void CLarWebview::SetTitle(const std::string& title)
{
    if (m_hWnd)
        SetWindowTextW(m_hWnd, Utf8ToWide(title).c_str());
}

void* CLarWebview::GetNativeWindow()
{
    return m_hWnd;
}

void CLarWebview::Navigate(const std::string& url)
{
    NavigateW(Utf8ToWide(url));
}

void CLarWebview::LoadHtml(const std::string& html, const std::string& baseUri)
{
    NavigateToStringW(Utf8ToWide(html));
}

void CLarWebview::Reload()
{
    if (m_webView) m_webView->Reload();
}

void CLarWebview::ExecuteScript(const std::string& script, ScriptCallback cb)
{
    ExecuteScriptW(Utf8ToWide(script), [cb](HRESULT hr, const std::wstring& result) {
        if (cb) cb(SUCCEEDED(hr), WideToUtf8(result));
    });
}

void CLarWebview::PostWebMessage(const std::string& message)
{
    PostWebMessageW(Utf8ToWide(message));
}

void CLarWebview::SetMessageHandler(MessageHandler handler)
{
    m_webMessageHandler = [handler](const std::wstring& msg) {
        if (handler) handler(WideToUtf8(msg));
    };
}

void CLarWebview::BindNativeCall(const std::string& name, NativeCallHandler handler)
{
    m_nativeCalls[name] = handler;
}

HRESULT CLarWebview::NavigateW(const std::wstring& url)
{
    if (!m_webView)
    {
        m_pendingUrl = url;
        return S_OK;
    }
    return m_webView->Navigate(url.c_str());
}

HRESULT CLarWebview::NavigateToStringW(const std::wstring& html)
{
    if (!m_webView) return E_FAIL;
    return m_webView->NavigateToString(html.c_str());
}

HRESULT CLarWebview::ExecuteScriptW(const std::wstring& script,
    std::function<void(HRESULT, const std::wstring&)> callback)
{
    if (!m_webView) return E_FAIL;

    return m_webView->ExecuteScript(
        script.c_str(),
        Callback<ICoreWebView2ExecuteScriptCompletedHandler>(
            [callback](HRESULT result, LPCWSTR resultObjectAsJson) -> HRESULT
            {
                if (callback)
                {
                    std::wstring json = resultObjectAsJson ? resultObjectAsJson : L"";
                    callback(result, json);
                }
                return S_OK;
            }).Get());
}

HRESULT CLarWebview::PostWebMessageW(const std::wstring& message)
{
    if (!m_webView) return E_FAIL;
    return m_webView->PostWebMessageAsString(message.c_str());
}

void CLarWebview::OnWebMessageReceived(const std::wstring& message)
{
    if (m_webMessageHandler)
        m_webMessageHandler(message);

    // 解析 native_call 消息并分发
    try {
        std::string utf8Msg = WideToUtf8(message);
        if (utf8Msg.empty()) return;

        size_t sep = utf8Msg.find('|');
        std::string name;
        std::string req;
        int id = 0;

        if (sep != std::string::npos) {
            std::string header = utf8Msg.substr(0, sep);
            req = utf8Msg.substr(sep + 1);
            size_t colon = header.find(':');
            if (colon != std::string::npos) {
                id = std::stoi(header.substr(0, colon));
                name = header.substr(colon + 1);
            }
            else {
                name = header;
            }
        }
        else {
            name = utf8Msg;
        }

        auto it = m_nativeCalls.find(name);
        if (it == m_nativeCalls.end()) return;

        std::string result = it->second(req);
        if (id > 0) {
            std::string response = std::to_string(id) + "|" + result;
            PostWebMessageW(Utf8ToWide(response));
        }
    }
    catch (...) {
        spdlog::warn("[CLarWebview] native_call message handling exception");
    }
}

LRESULT CALLBACK CLarWebview::CLarWndProc(HWND hWnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    CLarWebview* pThis = nullptr;
    if (message == WM_NCCREATE)
    {
        LPCREATESTRUCT lpcs = reinterpret_cast<LPCREATESTRUCT>(lParam);
        pThis = static_cast<CLarWebview*>(lpcs->lpCreateParams);
        SetWindowLongPtr(hWnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(pThis));
    }
    else
    {
        pThis = reinterpret_cast<CLarWebview*>(GetWindowLongPtr(hWnd, GWLP_USERDATA));
    }

    if (pThis)
        return pThis->WndProc(hWnd, message, wParam, lParam);
    else
        return DefWindowProc(hWnd, message, wParam, lParam);
}

LRESULT CLarWebview::WndProc(HWND hWnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    switch (message)
    {
    case WM_SIZE:
        return OnSize(wParam, lParam);
    case WM_DESTROY:
        return OnDestroy(wParam, lParam);
    case WM_CLOSE:
        Destroy();
        return 0;
    case WM_NCDESTROY:
        SetWindowLongPtr(hWnd, GWLP_USERDATA, 0);
        m_hWnd = nullptr;
        break;
    case WM_SETFOCUS:
        return OnSetFocus(wParam, lParam);
    case WM_MOUSEACTIVATE:
        return OnMouseActivate(wParam, lParam);
    }
    return DefWindowProcW(hWnd, message, wParam, lParam);
}

LRESULT CLarWebview::OnSize(WPARAM wParam, LPARAM lParam)
{
    if (m_controller && wParam != SIZE_MINIMIZED)
    {
        RECT bounds;
        GetClientRect(m_hWnd, &bounds);
        m_controller->put_Bounds(bounds);
    }
    if (m_frameless && wParam != SIZE_MINIMIZED)
    {
        UpdateWindowRgn();
    }
    return 0;
}

LRESULT CLarWebview::OnDestroy(WPARAM wParam, LPARAM lParam)
{
    Destroy();
    if (!m_hParent)
        PostQuitMessage(0);
    return 0;
}

LRESULT CLarWebview::OnSetFocus(WPARAM wParam, LPARAM lParam)
{
    if (m_controller)
        m_controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    return 0;
}

LRESULT CLarWebview::OnMouseActivate(WPARAM wParam, LPARAM lParam)
{
    if (m_controller)
        m_controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    return MA_ACTIVATE;
}

void CLarWebview::InjectNativeCallBridge()
{
    if (!m_webView) return;
    std::wstring bridgeJs = LR"(
(function(){
  if(window.__largui_bridge_installed)return;
  window.__largui_bridge_installed=true;
  window.__largui_callbacks={};
  window.__largui_call_id=0;
  window.__largui_resolve=function(id,ok,result){
    var cb=window.__largui_callbacks[id];
    if(!cb)return;
    delete window.__largui_callbacks[id];
    if(ok)cb.resolve(result);
    else cb.reject(new Error(result||'native call failed'));
  };
  window.native_call=function(name,arg){
    return new Promise(function(resolve,reject){
      var id=++window.__largui_call_id;
      window.__largui_callbacks[id]={resolve:resolve,reject:reject};
      window.chrome.webview.postMessage(id+':'+name+'|'+JSON.stringify(arg===undefined?null:arg));
    });
  };
})();
)";
    ExecuteScriptW(bridgeJs, nullptr);
}

BOOL CLarWebview::InitializeWebView2(std::wstring htmlPath)
{
    std::wstring userDataFolder;
    {
        wchar_t tempPath[MAX_PATH] = {};
        DWORD tempLen = GetTempPathW(MAX_PATH, tempPath);
        if (tempLen > 0 && tempLen < MAX_PATH)
        {
            static std::atomic<int> s_instanceCounter{ 0 };
            int instanceId = s_instanceCounter.fetch_add(1);
            wchar_t buf[MAX_PATH] = {};
            swprintf_s(buf, L"%sOpenclawLauncher\\WebView2\\Cache_%lu_%d",
                tempPath, GetCurrentProcessId(), instanceId);
            userDataFolder = buf;

            try {
                fs::path ud(userDataFolder);
                if (fs::exists(ud))
                    fs::remove_all(ud);
                fs::create_directories(ud);
            }
            catch (const std::exception& e) {
                spdlog::warn("[CLarWebview] Failed to create WebView2 user data dir: {}, path={}",
                    e.what(), WideToUtf8(userDataFolder));
                userDataFolder.clear();
            }
        }
    }

    ComPtr<ICoreWebView2EnvironmentOptions> envOptions;
    {
        auto envOptionsImpl = Microsoft::WRL::Make<CoreWebView2EnvironmentOptions>();
        HRESULT hrOpt = envOptionsImpl.As(&envOptions);
        if (SUCCEEDED(hrOpt))
        {
            envOptions->put_AdditionalBrowserArguments(
                L"--disable-cache --disable-gpu-shader-disk-cache --disable-application-cache --media-cache-size=1 --force-device-scale-factor=1 --allow-file-access-from-files");
        }
        else
        {
            spdlog::warn("[CLarWebview] Make CoreWebView2EnvironmentOptions failed, hr={:08x}", hrOpt);
            envOptions.Reset();
        }
    }

    CreateCoreWebView2EnvironmentWithOptions(
        nullptr,
        userDataFolder.empty() ? nullptr : userDataFolder.c_str(),
        envOptions.Get(),
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [this, htmlPath](HRESULT result, ICoreWebView2Environment* env) -> HRESULT
            {
                if (FAILED(result) || !env)
                {
                    MessageBoxW(m_hWnd,
                        L"Failed to create WebView2 environment. Please install WebView2 Runtime.",
                        L"Error", MB_OK);
                    OnInitializationCompleted(result);
                    return result;
                }

                env->CreateCoreWebView2Controller(
                    m_hWnd,
                    Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        [this, htmlPath](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT
                        {
                            if (FAILED(result) || !controller)
                            {
                                MessageBoxW(m_hWnd, L"Failed to create WebView2 controller.", L"Error", MB_OK);
                                OnInitializationCompleted(result);
                                return result;
                            }

                            m_controller = controller;
                            m_controller->get_CoreWebView2(&m_webView);

                            std::wstring baseDir;
                            std::wstring navUrl;
                            BOOL useVirtualHost = FALSE;
                            ComPtr<ICoreWebView2_3> webView3;
                            if (SUCCEEDED(m_webView.As(&webView3)))
                            {
                                if (ResolveVirtualHostUrl(htmlPath, baseDir, navUrl))
                                {
                                    HRESULT hrMap = webView3->SetVirtualHostNameToFolderMapping(
                                        L"openclaw.local",
                                        baseDir.c_str(),
                                        COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
                                    useVirtualHost = SUCCEEDED(hrMap);
                                    if (!useVirtualHost)
                                    {
                                        spdlog::warn("[CLarWebview] SetVirtualHostNameToFolderMapping failed, hr={:08x}, fallback to NavigateToString", hrMap);
                                    }
                                }
                            }

                            ComPtr<ICoreWebView2Settings> settings;
                            m_webView->get_Settings(&settings);
                            settings->put_IsScriptEnabled(TRUE);
                            settings->put_AreDefaultScriptDialogsEnabled(TRUE);
                            settings->put_IsWebMessageEnabled(TRUE);
                            settings->put_AreDefaultContextMenusEnabled(FALSE);
                            settings->put_AreDevToolsEnabled(FALSE);

                            RECT bounds;
                            GetClientRect(m_hWnd, &bounds);
                            HRESULT hrBounds = m_controller->put_Bounds(bounds);
                            HRESULT hrVisible = m_controller->put_IsVisible(TRUE);
                            spdlog::info("[CLarWebview] Controller bounds={}x{} put_Bounds hr={:08x} put_IsVisible hr={:08x}",
                                bounds.right - bounds.left, bounds.bottom - bounds.top, hrBounds, hrVisible);

                            ComPtr<ICoreWebView2Controller3> controller3;
                            if (SUCCEEDED(m_controller.As(&controller3)))
                            {
                                controller3->put_RasterizationScale(1.0);
                                controller3->put_ShouldDetectMonitorScaleChanges(FALSE);
                            }

                            ComPtr<ICoreWebView2Controller2> controller2;
                            if (SUCCEEDED(m_controller.As(&controller2)))
                            {
                                COREWEBVIEW2_COLOR bgColor = { 23, 26, 41, 255 };
                                controller2->put_DefaultBackgroundColor(bgColor);
                            }

                            m_controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);

                            // 每次页面导航完成后重新注入 bridge
                            HRESULT hrNav = m_webView->add_NavigationCompleted(
                                Callback<ICoreWebView2NavigationCompletedEventHandler>(
                                    [this](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* args) -> HRESULT
                                    {
                                        BOOL success = FALSE;
                                        if (args) args->get_IsSuccess(&success);
                                        spdlog::info("[CLarWebview] NavigationCompleted success={}", success ? 1 : 0);
                                        InjectNativeCallBridge();
                                        return S_OK;
                                    }).Get(),
                                &m_navToken);
                            spdlog::info("[CLarWebview] add_NavigationCompleted hr={:08x}", hrNav);

                            HRESULT hrMsg = m_webView->add_WebMessageReceived(
                                Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                                    [this](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT
                                    {
                                        PWSTR message = nullptr;
                                        args->TryGetWebMessageAsString(&message);
                                        if (!message) return S_OK;
                                        std::wstring msg = message;
                                        CoTaskMemFree(message);
                                        OnWebMessageReceived(msg);
                                        return S_OK;
                                    }).Get(),
                                        &m_msgToken);
                            spdlog::info("[CLarWebview] add_WebMessageReceived hr={:08x}", hrMsg);

                            // 注入 native_call bridge
                            InjectNativeCallBridge();

                            if (useVirtualHost && !navUrl.empty())
                            {
                                m_webView->Navigate(navUrl.c_str());
                            }
                            else if (!m_pendingUrl.empty())
                            {
                                m_webView->Navigate(m_pendingUrl.c_str());
                                m_pendingUrl.clear();
                            }
                            else if (!htmlPath.empty())
                            {
                                std::wstring html = LoadUtf8File(htmlPath.c_str());
                                if (!html.empty())
                                {
                                    if (!baseDir.empty())
                                    {
                                        std::wstring basePath = baseDir;
                                        std::replace(basePath.begin(), basePath.end(), L'\\', L'/');
                                        if (!basePath.empty() && basePath.back() != L'/')
                                            basePath += L'/';
                                        std::wstring baseHref = L"file:///" + basePath + L"webui/";
                                        std::wstring baseTag = L"<base href=\"" + baseHref + L"\">";
                                        size_t headPos = html.find(L"<head>");
                                        if (headPos != std::wstring::npos)
                                            html.insert(headPos + 6, baseTag);
                                        else
                                            html = baseTag + html;
                                    }
                                    m_webView->NavigateToString(html.c_str());
                                }
                                else
                                {
                                    m_webView->NavigateToString(
                                        L"<html><head><meta charset='utf-8'><style>"
                                        L"body{font-family:sans-serif;background:#12151f;color:#d6dae8;display:flex;"
                                        L"align-items:center;justify-content:center;height:100vh;margin:0;}"
                                        L".box{text-align:center;}h1{margin-bottom:10px;}p{color:#5a6480;}</style></head>"
                                        L"<body><div class='box'><h1>html 未找到</h1>"
                                        L"<p>请将 HTML 代码保存为 html，并放在程序同级目录。</p></div></body></html>");
                                }
                            }

                            m_bInitialized = TRUE;
                            OnInitializationCompleted(S_OK);
                            return S_OK;
                        }).Get());

                return S_OK;
            }).Get());

    return TRUE;
}

} // namespace largui
