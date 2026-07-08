// Voicevideo.cpp: 定义应用程序的入口点。
//

#include "Voicevideo.h"
#include "largui/ILarWebView.h"
#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <sodium.h>
#include <spdlog/spdlog.h>
#include <spdlog/sinks/basic_file_sink.h>

#include <filesystem>
#include <memory>
#include <string>

#ifdef _WIN32
#include <windows.h>
#include <commdlg.h>
#include <shellapi.h>
#else
#include <mach-o/dyld.h>
#include <climits>
#endif

using namespace std;

namespace {
    std::string getExecutableDirectory()
    {
        std::string path;
#ifdef _WIN32
        char buffer[MAX_PATH];
        if (GetModuleFileNameA(nullptr, buffer, MAX_PATH) > 0) {
            path = buffer;
        }
#else
        char buffer[PATH_MAX];
        uint32_t size = sizeof(buffer);
        if (_NSGetExecutablePath(buffer, &size) == 0) {
            path = buffer;
        }
#endif
        if (!path.empty()) {
            std::filesystem::path p = std::filesystem::path(path).parent_path();
            return p.string();
        }
        return "";
    }

    std::string getPageUrl(const std::string& pageName)
    {
        std::string dir = getExecutableDirectory();
        std::filesystem::path pagePath = std::filesystem::path(dir) / "assets" / pageName;
        return "file://" + pagePath.generic_string();
    }

#ifdef _WIN32
    void* getNativeWindow(largui::ILarWebView* w)
    {
        return w ? w->GetNativeWindow() : nullptr;
    }

    void startWindowDrag(largui::ILarWebView* w)
    {
        HWND hwnd = static_cast<HWND>(getNativeWindow(w));
        if (!hwnd) return;
        ReleaseCapture();
        SendMessage(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0);
    }

    void minimizeWindow(largui::ILarWebView* w)
    {
        HWND hwnd = static_cast<HWND>(getNativeWindow(w));
        if (!hwnd) return;
        ShowWindow(hwnd, SW_MINIMIZE);
    }

    void resizeWindow(largui::ILarWebView* w, int width, int height)
    {
        HWND hwnd = static_cast<HWND>(getNativeWindow(w));
        if (!hwnd) return;

        RECT windowRect{}, clientRect{};
        GetWindowRect(hwnd, &windowRect);
        GetClientRect(hwnd, &clientRect);

        int borderWidth = (windowRect.right - windowRect.left) - clientRect.right;
        int borderHeight = (windowRect.bottom - windowRect.top) - clientRect.bottom;

        int newWindowWidth = width + borderWidth;
        int newWindowHeight = height + borderHeight;

        int screenWidth = GetSystemMetrics(SM_CXSCREEN);
        int screenHeight = GetSystemMetrics(SM_CYSCREEN);
        int x = (screenWidth - newWindowWidth) / 2;
        int y = (screenHeight - newWindowHeight) / 2;

        SetWindowPos(hwnd, nullptr, x, y, newWindowWidth, newWindowHeight,
            SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOOWNERZORDER);
    }

    std::string WideToUtf8(const std::wstring& wide)
    {
        if (wide.empty()) return "";
        int size = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, nullptr, 0, nullptr, nullptr);
        if (size <= 0) return "";
        std::string result(size - 1, '\0');
        WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), -1, result.data(), size, nullptr, nullptr);
        return result;
    }

    void openUrl(const std::string& url)
    {
        if (url.empty()) return;
        ShellExecuteA(nullptr, "open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    }

    std::string pickFile(HWND hwndOwner)
    {
        wchar_t fileName[MAX_PATH] = { 0 };
        OPENFILENAMEW ofn = {};
        ofn.lStructSize = sizeof(ofn);
        ofn.hwndOwner = hwndOwner;
        ofn.lpstrFile = fileName;
        ofn.nMaxFile = MAX_PATH;
        ofn.lpstrFilter = L"Video/Audio Files\0*.mp4;*.mkv;*.avi;*.mov;*.wmv;*.flv;*.webm;*.mp3;*.wav;*.aac;*.flac;*.m4a;*.wma\0All Files\0*.*\0";
        ofn.nFilterIndex = 1;
        ofn.Flags = OFN_PATHMUSTEXIST | OFN_FILEMUSTEXIST;
        if (GetOpenFileNameW(&ofn)) {
            return WideToUtf8(fileName);
        }
        return "";
    }
#else
    void startWindowDrag(largui::ILarWebView* w) {}
    void minimizeWindow(largui::ILarWebView* w) {}
    void resizeWindow(largui::ILarWebView* w, int width, int height) {}
#endif
}

int main()
{
    try {
        auto logger = std::make_shared<spdlog::logger>("Voicevideo",
            std::make_shared<spdlog::sinks::basic_file_sink_mt>("Voicevideo.log", true));
        logger->set_pattern("[%Y-%m-%d %H:%M:%S.%e] [%l] %v");
        logger->flush_on(spdlog::level::info);
        spdlog::set_default_logger(logger);
    }
    catch (const std::exception& e) {
        // ignore file logger init failure
    }

    spdlog::info("Voicevideo started");

    curl_global_init(CURL_GLOBAL_DEFAULT);
    CURL* curl = curl_easy_init();
    if (curl) {
        spdlog::info("libcurl initialized");
        curl_easy_cleanup(curl);
    }
    else {
        spdlog::warn("libcurl init failed");
    }
    curl_global_cleanup();

    nlohmann::json j;
    j["project"] = "Voicevideo";
    j["status"] = "vcpkg ready";
    spdlog::info("JSON status: {}", j.dump(2));

    spdlog::info("spdlog working");

    if (sodium_init() >= 0) {
        spdlog::info("libsodium initialized");
    }
    else {
        spdlog::warn("libsodium init failed");
    }

    std::string startUrl = getPageUrl("LinkVideoExtract.html");
    spdlog::info("Loading UI: {}", startUrl);

    std::unique_ptr<largui::ILarWebView> w = largui::CreateWebView();
    if (!w) {
        spdlog::error("WebView backend creation failed");
        return 1;
    }

    int screenWidth = GetSystemMetrics(SM_CXSCREEN);
    int screenHeight = GetSystemMetrics(SM_CYSCREEN);
    int winW = 1400;
    int winH = 972;
    int x = (screenWidth - winW) / 2;
    int y = (screenHeight - winH) / 2;

    if (!w->Create("Voicevideo", x, y, winW, winH, true)) {
        spdlog::error("WebView window creation failed");
        return 1;
    }

    w->SetTitle("Voicevideo");

    w->BindNativeCall("startDrag", [&w](const std::string&) {
        startWindowDrag(w.get());
        return std::string(R"({"ok":true})");
    });

    w->BindNativeCall("minimize", [&w](const std::string&) {
        minimizeWindow(w.get());
        return std::string(R"({"ok":true})");
    });

    w->BindNativeCall("close", [&w](const std::string&) {
        w->Terminate();
        return std::string(R"({"ok":true})");
    });

    w->BindNativeCall("resizeWindow", [&w](const std::string& req) {
        try {
            nlohmann::json args = nlohmann::json::parse(req);
            int width = args.value("width", 0);
            int height = args.value("height", 0);
            if (width > 0 && height > 0) {
                resizeWindow(w.get(), width, height);
                spdlog::info("Window resized to {}x{}", width, height);
            }
        }
        catch (const std::exception& e) {
            spdlog::error("resizeWindow parse failed: {}", e.what());
        }
        return std::string(R"({"ok":true})");
    });

    w->BindNativeCall("getPlatform", [](const std::string&) {
#ifdef _WIN32
        return std::string(R"({"platform":"windows"})");
#else
        return std::string(R"({"platform":"macos"})");
#endif
    });

    w->BindNativeCall("openUrl", [](const std::string& req) {
        try {
            nlohmann::json args = nlohmann::json::parse(req);
            std::string url = args.value("url", "");
            if (!url.empty()) {
                openUrl(url);
            }
        }
        catch (const std::exception& e) {
            spdlog::error("openUrl parse failed: {}", e.what());
        }
        return std::string(R"({"ok":true})");
    });

    w->BindNativeCall("pickFile", [&w](const std::string&) {
        nlohmann::json result;
#ifdef _WIN32
        result["path"] = pickFile(static_cast<HWND>(getNativeWindow(w.get())));
#else
        result["path"] = "";
#endif
        return result.dump();
    });

    spdlog::info("JS Bridge registered");

    w->Navigate(startUrl);
    spdlog::info("Navigation started");

    w->Run();

    spdlog::info("Voicevideo exited");
    return 0;
}
