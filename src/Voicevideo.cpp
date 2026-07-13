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
#include <thread>
#include <atomic>
#include <mutex>
#include <unordered_map>
#include <chrono>
#include <random>
#include <algorithm>
#include <sstream>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <commdlg.h>
#include <shellapi.h>
#include <dwmapi.h>
#include <commctrl.h>
#include <gdiplus.h>
#include <shlobj.h>
#include <objbase.h>
#else
#include <mach-o/dyld.h>
#include <climits>
#endif

#include <fstream>

using namespace std;

static bool g_requestLogout = false;

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

    std::string getProjectRootDirectory()
    {
        namespace fs = std::filesystem;
        fs::path exeDir = getExecutableDirectory();
        if (exeDir.empty()) return "";
        // 发布布局：exe 所在目录就是项目根目录（包含 temp/assets）
        if (fs::exists(exeDir / "temp") || fs::exists(exeDir / "assets"))
            return exeDir.string();
        // 开发布局：exe 在 build/ 下，项目根目录是上一级
        fs::path root = exeDir.parent_path();
        if (!root.empty() && (fs::exists(root / "temp") || fs::exists(root / "assets")))
            return root.string();
        return exeDir.string();
    }

#ifdef _WIN32
    // 系统托盘与窗口图标相关常量与辅助函数
    constexpr UINT WM_TRAYICON = WM_APP + 1;
    constexpr UINT ID_TRAY_EXIT = 1001;

    static HICON g_hAppIcon = nullptr;
    static bool g_hAppIconOwned = false;

    class GdiplusInit {
    public:
        GdiplusInit() {
            Gdiplus::GdiplusStartupInput input;
            input.GdiplusVersion = 1;
            input.DebugEventCallback = nullptr;
            input.SuppressBackgroundThread = FALSE;
            input.SuppressExternalCodecs = FALSE;
            Gdiplus::GdiplusStartup(&token_, &input, nullptr);
        }
        ~GdiplusInit() { Gdiplus::GdiplusShutdown(token_); }
    private:
        ULONG_PTR token_ = 0;
    };

    HICON LoadPngAsIcon(const std::wstring& path)
    {
        Gdiplus::Bitmap bitmap(path.c_str());
        if (bitmap.GetLastStatus() != Gdiplus::Ok) {
            return nullptr;
        }
        HICON hIcon = nullptr;
        if (bitmap.GetHICON(&hIcon) != Gdiplus::Ok) {
            return nullptr;
        }
        return hIcon;
    }

    HICON LoadProductIcon()
    {
        if (g_hAppIcon) return g_hAppIcon;
        namespace fs = std::filesystem;
        fs::path root = getProjectRootDirectory();
        fs::path logoPath = root / "assets" / "logo" / "LAZERAGENT_256.png";
        if (fs::is_regular_file(logoPath)) {
            HICON hIcon = LoadPngAsIcon(logoPath.wstring());
            if (hIcon) {
                g_hAppIconOwned = true;
                g_hAppIcon = hIcon;
                return hIcon;
            }
        }
        g_hAppIconOwned = false;
        g_hAppIcon = LoadIconW(nullptr, reinterpret_cast<LPCWSTR>(IDI_APPLICATION));
        return g_hAppIcon;
    }

    void SetWindowProductIcon(HWND hwnd)
    {
        if (!hwnd) return;
        HICON hIcon = LoadProductIcon();
        if (!hIcon) return;
        SendMessage(hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(hIcon));
        SendMessage(hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(hIcon));
    }

    bool AddTrayIcon(HWND hwnd, HICON hIcon)
    {
        NOTIFYICONDATAW nid = {};
        nid.cbSize = sizeof(nid);
        nid.hWnd = hwnd;
        nid.uID = 1;
        nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
        nid.uCallbackMessage = WM_TRAYICON;
        nid.hIcon = hIcon ? hIcon : LoadIconW(nullptr, reinterpret_cast<LPCWSTR>(IDI_APPLICATION));
        wcscpy_s(nid.szTip, L"菈泽AI口播");
        return Shell_NotifyIconW(NIM_ADD, &nid) == TRUE;
    }

    void RemoveTrayIcon(HWND hwnd)
    {
        NOTIFYICONDATAW nid = {};
        nid.cbSize = sizeof(nid);
        nid.hWnd = hwnd;
        nid.uID = 1;
        Shell_NotifyIconW(NIM_DELETE, &nid);
    }

    LRESULT CALLBACK MainWindowSubclassProc(HWND hWnd, UINT uMsg, WPARAM wParam, LPARAM lParam,
        UINT_PTR uIdSubclass, DWORD_PTR dwRefData)
    {
        switch (uMsg) {
        case WM_TRAYICON:
            if (lParam == WM_RBUTTONUP) {
                HMENU hMenu = CreatePopupMenu();
                if (hMenu) {
                    AppendMenuW(hMenu, MF_STRING, ID_TRAY_EXIT, L"退出");
                    POINT pt;
                    GetCursorPos(&pt);
                    SetForegroundWindow(hWnd);
                    TrackPopupMenu(hMenu, TPM_RIGHTALIGN | TPM_BOTTOMALIGN | TPM_RIGHTBUTTON,
                        pt.x, pt.y, 0, hWnd, nullptr);
                    DestroyMenu(hMenu);
                }
                return 0;
            }
            else if (lParam == WM_LBUTTONDBLCLK) {
                ShowWindow(hWnd, SW_RESTORE);
                SetForegroundWindow(hWnd);
                return 0;
            }
            return 0;
        case WM_COMMAND:
            if (LOWORD(wParam) == ID_TRAY_EXIT) {
                PostMessage(hWnd, WM_CLOSE, 0, 0);
                return 0;
            }
            break;
        case WM_DESTROY:
            if (g_hAppIcon) {
                RemoveTrayIcon(hWnd);
                if (g_hAppIconOwned) {
                    DestroyIcon(g_hAppIcon);
                }
                g_hAppIcon = nullptr;
            }
            break;
        }
        return DefSubclassProc(hWnd, uMsg, wParam, lParam);
    }

    void InitMainWindowTrayIcon(HWND hwnd)
    {
        if (!hwnd) return;
        SetWindowProductIcon(hwnd);
        AddTrayIcon(hwnd, g_hAppIcon);
        SetWindowSubclass(hwnd, MainWindowSubclassProc, 1, 0);
    }

    // 在桌面创建快捷方式（如果不存在），图标使用 exe 内置图标资源
    bool CreateDesktopShortcutIfNeeded()
    {
        namespace fs = std::filesystem;
        fs::path exePath = fs::path(getExecutableDirectory()) / "Voicevideo.exe";
        if (!fs::is_regular_file(exePath)) {
            spdlog::warn("CreateDesktopShortcut: cannot find Voicevideo.exe");
            return false;
        }

        wchar_t desktopPathW[MAX_PATH] = {};
        if (FAILED(SHGetFolderPathW(nullptr, CSIDL_DESKTOP, nullptr, 0, desktopPathW))) {
            spdlog::warn("CreateDesktopShortcut: failed to get desktop path");
            return false;
        }
        fs::path shortcutPath = fs::path(desktopPathW) / L"菈泽AI口播.lnk";
        if (fs::is_regular_file(shortcutPath)) {
            spdlog::info("CreateDesktopShortcut: shortcut already exists");
            return true;
        }

        HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        bool needUninit = SUCCEEDED(hr);
        if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
            spdlog::warn("CreateDesktopShortcut: CoInitializeEx failed, hr={}", hr);
            return false;
        }

        IShellLinkW* psl = nullptr;
        bool ok = false;
        hr = CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER,
                              IID_IShellLinkW, reinterpret_cast<void**>(&psl));
        if (SUCCEEDED(hr) && psl) {
            psl->SetPath(exePath.wstring().c_str());
            psl->SetWorkingDirectory(exePath.parent_path().wstring().c_str());
            psl->SetDescription(L"菈泽AI口播");
            psl->SetIconLocation(exePath.wstring().c_str(), 0);

            IPersistFile* ppf = nullptr;
            hr = psl->QueryInterface(IID_IPersistFile, reinterpret_cast<void**>(&ppf));
            if (SUCCEEDED(hr) && ppf) {
                hr = ppf->Save(shortcutPath.wstring().c_str(), TRUE);
                ok = SUCCEEDED(hr);
                ppf->Release();
            }
            psl->Release();
        }

        if (needUninit) CoUninitialize();

        if (ok) {
            spdlog::info("CreateDesktopShortcut: created {}", shortcutPath.string());
        }
        else {
            spdlog::warn("CreateDesktopShortcut: failed to create shortcut");
        }
        return ok;
    }
#endif // _WIN32

    // 前向声明：这些函数在文件后面定义
    std::string sanitizeUtf8(const std::string& s);
    std::string stripFileUri(std::string path);
    std::filesystem::path findProjectRoot(const std::filesystem::path& startDir);

    std::string findFfprobePath()
    {
        namespace fs = std::filesystem;
        fs::path exeDir = getExecutableDirectory();
        fs::path projectRoot = findProjectRoot(exeDir);
        std::vector<fs::path> candidates;
        if (!projectRoot.empty()) {
            candidates.push_back(projectRoot / "localdep" / "tools" / "ffprobe.exe");
        }
        if (!exeDir.empty()) {
            candidates.push_back(exeDir / "localdep" / "tools" / "ffprobe.exe");
        }
        for (const auto& p : candidates) {
            if (fs::is_regular_file(p)) {
                spdlog::info("[getAudioDuration] ffprobe candidate found: {}", p.string());
                return p.string();
            }
        }
        // 回退到 PATH
        char buffer[MAX_PATH];
        if (GetEnvironmentVariableA("PATH", buffer, MAX_PATH) > 0) {
            std::stringstream ss(buffer);
            std::string dir;
            while (std::getline(ss, dir, ';')) {
                fs::path probe = fs::path(dir) / "ffprobe.exe";
                if (fs::is_regular_file(probe)) {
                    spdlog::info("[getAudioDuration] ffprobe found in PATH: {}", probe.string());
                    return probe.string();
                }
            }
        }
        spdlog::warn("[getAudioDuration] ffprobe not found");
        return "";
    }

    double getAudioDurationSeconds(const std::string& audioPath)
    {
        std::string ffprobe = findFfprobePath();
        if (ffprobe.empty() || audioPath.empty()) {
            spdlog::warn("[getAudioDuration] missing ffprobe or audioPath");
            return 0.0;
        }
        std::string innerCmd = "\"" + ffprobe + "\" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 \"" + audioPath + "\" 2>&1";
        std::string cmd = "\"" + innerCmd + "\"";
        spdlog::info("[getAudioDuration] running: {}", innerCmd);
        FILE* pipe = _popen(cmd.c_str(), "r");
        if (!pipe) {
            spdlog::warn("[getAudioDuration] _popen failed");
            return 0.0;
        }
        char buf[128];
        std::string out;
        while (fgets(buf, sizeof(buf), pipe)) {
            out += buf;
        }
        int exitCode = _pclose(pipe);
        spdlog::info("[getAudioDuration] ffprobe exit={}, raw output: [{}]", exitCode, out);
        try {
            double duration = std::stod(out);
            spdlog::info("[getAudioDuration] parsed duration: {}", duration);
            return duration;
        }
        catch (...) {
            spdlog::warn("[getAudioDuration] failed to parse duration from output");
            return 0.0;
        }
    }

    std::string getAudioDurationJson(const std::string& reqJson)
    {
        nlohmann::json result;
        try {
            spdlog::info("[getAudioDuration] request raw: {}", reqJson);
            std::string reqClean = sanitizeUtf8(reqJson);
            nlohmann::json j = nlohmann::json::parse(reqClean);
            std::string pathStr = stripFileUri(j.value("path", ""));
            spdlog::info("[getAudioDuration] stripped path: {}", pathStr);
            if (pathStr.empty()) {
                spdlog::warn("[getAudioDuration] empty path after stripFileUri");
                result["duration"] = 0.0;
                return result.dump();
            }
            namespace fs = std::filesystem;
            fs::path audioPath = fs::path(pathStr);
            if (!audioPath.is_absolute()) {
                fs::path projectRoot = findProjectRoot(getExecutableDirectory());
                spdlog::info("[getAudioDuration] relative path, project root: {}", projectRoot.string());
                if (!projectRoot.empty()) audioPath = projectRoot / audioPath;
            }
            audioPath = fs::weakly_canonical(audioPath);
            spdlog::info("[getAudioDuration] resolved path: {}", audioPath.string());
            if (!fs::is_regular_file(audioPath)) {
                spdlog::warn("[getAudioDuration] file not found: {}", audioPath.string());
                result["duration"] = 0.0;
                return result.dump();
            }
            double duration = getAudioDurationSeconds(audioPath.string());
            result["duration"] = duration;
            spdlog::info("[getAudioDuration] returning duration: {}", duration);
            return result.dump();
        }
        catch (const std::exception& e) {
            spdlog::warn("[getAudioDuration] exception: {}", e.what());
            result["duration"] = 0.0;
            return result.dump();
        }
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

    void openFileLocation(const std::string& path)
    {
        if (path.empty()) return;
        // 资源管理器只认反斜杠；先把前端传过来的正斜杠统一转换。
        std::string normalized = path;
        std::replace(normalized.begin(), normalized.end(), '/', '\\');
        // explorer /select,"<path>" 会在资源管理器中定位并选中该文件
        std::string param = "/select,\"" + normalized + "\"";
        ShellExecuteA(nullptr, "open", "explorer", param.c_str(), nullptr, SW_SHOWNORMAL);
    }

    bool HasCommandLineFlag(const std::wstring& flag)
    {
        int argc = 0;
        wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
        if (!argv) return false;
        bool found = false;
        for (int i = 0; i < argc; ++i) {
            if (flag == argv[i]) {
                found = true;
                break;
            }
        }
        LocalFree(argv);
        return found;
    }

    bool CopyTextToClipboard(const std::string& text)
    {
        if (text.empty()) return false;
        if (!OpenClipboard(nullptr)) return false;
        EmptyClipboard();
        int wideSize = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, nullptr, 0);
        if (wideSize <= 0) {
            CloseClipboard();
            return false;
        }
        HGLOBAL hMem = GlobalAlloc(GMEM_MOVEABLE, wideSize * sizeof(wchar_t));
        if (!hMem) {
            CloseClipboard();
            return false;
        }
        wchar_t* pMem = static_cast<wchar_t*>(GlobalLock(hMem));
        MultiByteToWideChar(CP_UTF8, 0, text.c_str(), -1, pMem, wideSize);
        GlobalUnlock(hMem);
        SetClipboardData(CF_UNICODETEXT, hMem);
        CloseClipboard();
        return true;
    }

    std::string ShowSaveCsvDialog(const std::string& defaultName)
    {
        wchar_t fileName[MAX_PATH] = { 0 };
        std::wstring defaultW = std::wstring(defaultName.begin(), defaultName.end());
        if (defaultW.size() < MAX_PATH) {
            wcsncpy_s(fileName, MAX_PATH, defaultW.c_str(), _TRUNCATE);
        }
        OPENFILENAMEW ofn = {};
        ofn.lStructSize = sizeof(ofn);
        ofn.lpstrFile = fileName;
        ofn.nMaxFile = MAX_PATH;
        ofn.lpstrFilter = L"CSV Files\0*.csv\0All Files\0*.*\0";
        ofn.nFilterIndex = 1;
        ofn.lpstrDefExt = L"csv";
        ofn.Flags = OFN_OVERWRITEPROMPT;
        if (GetSaveFileNameW(&ofn)) {
            return WideToUtf8(fileName);
        }
        return "";
    }

#ifdef _WIN32
    void EnableWindowShadow(HWND hwnd)
    {
        if (!hwnd) return;
        MARGINS margins = { -1, -1, -1, -1 };
        DwmExtendFrameIntoClientArea(hwnd, &margins);
    }
#endif

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

    // 将非 UTF-8 字节替换为 U+FFFD，确保 nlohmann::json 不会抛异常
    std::string sanitizeUtf8(const std::string& s)
    {
        std::string out;
        out.reserve(s.size());
        const unsigned char* p = reinterpret_cast<const unsigned char*>(s.data());
        size_t i = 0;
        while (i < s.size()) {
            unsigned char c = p[i];
            int len = 0;
            if ((c & 0x80) == 0) len = 1;
            else if ((c & 0xE0) == 0xC0) len = 2;
            else if ((c & 0xF0) == 0xE0) len = 3;
            else if ((c & 0xF8) == 0xF0) len = 4;
            else { out += "\xEF\xBF\xBD"; ++i; continue; }

            bool ok = true;
            if (i + len > s.size()) ok = false;
            for (int j = 1; ok && j < len; ++j) {
                if ((p[i + j] & 0xC0) != 0x80) ok = false;
            }
            if (!ok) { out += "\xEF\xBF\xBD"; ++i; continue; }

            // 检查过长序列、代理对和超过 U+10FFFF
            uint32_t cp = 0;
            if (len == 1) cp = c;
            else if (len == 2) cp = ((c & 0x1F) << 6) | (p[i + 1] & 0x3F);
            else if (len == 3) cp = ((c & 0x0F) << 12) | ((p[i + 1] & 0x3F) << 6) | (p[i + 2] & 0x3F);
            else cp = ((c & 0x07) << 18) | ((p[i + 1] & 0x3F) << 12) | ((p[i + 2] & 0x3F) << 6) | (p[i + 3] & 0x3F);

            if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF) ||
                (len == 2 && cp < 0x80) || (len == 3 && cp < 0x800) || (len == 4 && cp < 0x10000)) {
                out += "\xEF\xBF\xBD"; ++i; continue;
            }

            out.append((const char*)p + i, len);
            i += len;
        }
        return out;
    }

    std::wstring Utf8ToWide(const std::string& utf8)
    {
        if (utf8.empty()) return L"";
        int size = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
        if (size <= 0) return L"";
        std::wstring result(size - 1, L'\0');
        MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, result.data(), size);
        return result;
    }

    std::string getLastErrorMessage()
    {
        DWORD err = GetLastError();
        if (err == 0) return "";
        LPWSTR buf = nullptr;
        FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
            nullptr, err, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT), reinterpret_cast<LPWSTR>(&buf), 0, nullptr);
        if (!buf) return "error code " + std::to_string(err);
        std::wstring wmsg(buf);
        LocalFree(buf);
        // 去掉末尾换行
        while (!wmsg.empty() && (wmsg.back() == L'\n' || wmsg.back() == L'\r'))
            wmsg.pop_back();
        return WideToUtf8(wmsg);
    }

    bool waitForProcess(HANDLE hProcess, DWORD timeoutMs = INFINITE)
    {
        DWORD wait = WaitForSingleObject(hProcess, timeoutMs);
        return wait == WAIT_OBJECT_0;
    }

    std::filesystem::path findProjectRoot(const std::filesystem::path& startDir)
    {
        namespace fs = std::filesystem;
        fs::path dir = startDir;
        for (int i = 0; i < 6 && !dir.empty(); ++i) {
            bool hasTools = fs::is_regular_file(dir / "tools" / "extract_link.py");
            bool hasVenv = fs::is_regular_file(dir / ".venv" / "Scripts" / "python.exe");
            bool hasLocaldepPython = fs::is_regular_file(dir / "localdep" / "python" / "python.exe");
            bool hasSourceMarker = fs::is_regular_file(dir / "CMakeLists.txt");
            if (hasTools && (hasVenv || hasLocaldepPython) && hasSourceMarker) {
                return dir;
            }
            fs::path parent = dir.parent_path();
            if (parent == dir) break;
            dir = parent;
        }
        return startDir;
    }

    struct PythonProcess {
        bool ok = false;
        std::string error;
        PROCESS_INFORMATION pi = {};
        std::filesystem::path outFile;     // Python 脚本写入的结果文件 (output.json)
        std::filesystem::path stdoutFile;  // 重定向后的 stdout 日志
        std::filesystem::path errFile;     // 重定向后的 stderr 日志
    };

    PythonProcess startPythonScript(const std::filesystem::path& script,
        const nlohmann::json& args, const std::string& workSubdir,
        const std::unordered_map<std::string, std::string>& env = {})
    {
        namespace fs = std::filesystem;
        PythonProcess proc;

        fs::path exeDir = getExecutableDirectory();
        if (exeDir.empty()) {
            proc.error = "无法定位程序目录";
            return proc;
        }

        fs::path projectRoot = findProjectRoot(exeDir);

        // 向子进程显式指明 localdep 目录。
        // 开发阶段优先使用源码主目录下的 localdep，避免每次构建都复制一份；
        // 打包发行时若将 localdep 放在 exe 同级目录，则会自动命中。
        fs::path localdepDir = projectRoot / "localdep";
        if (!fs::is_directory(localdepDir)) {
            localdepDir = exeDir / "localdep";
        }
        if (fs::is_directory(localdepDir)) {
            SetEnvironmentVariableW(L"VOICEVIDEO_LOCALDEP", localdepDir.wstring().c_str());
        }

        // 设置调用方传入的环境变量（如 DASHSCOPE_API_KEY），不写入 args.json，避免敏感信息落盘
        std::string extraEnvNames;
        for (const auto& kv : env) {
            SetEnvironmentVariableW(Utf8ToWide(kv.first).c_str(), Utf8ToWide(kv.second).c_str());
            if (!extraEnvNames.empty()) extraEnvNames += ",";
            extraEnvNames += kv.first;
        }

        fs::path venvPython = projectRoot / ".venv" / "Scripts" / "python.exe";
        fs::path localdepPython = projectRoot / "localdep" / "python" / "python.exe";
        fs::path exeDirLocaldepPython = exeDir / "localdep" / "python" / "python.exe";
        fs::path workBase = projectRoot / "temp" / workSubdir;

        if (!fs::is_regular_file(script)) {
            proc.error = "未找到脚本: " + script.generic_string();
            return proc;
        }

        // Python 解释器优先级：项目根 localdep（包含最新安装的依赖）> exe 同级 localdep > venv > PATH
        fs::path pythonExe;
        if (fs::is_regular_file(localdepPython)) {
            pythonExe = localdepPython;
        }
        else if (fs::is_regular_file(exeDirLocaldepPython)) {
            pythonExe = exeDirLocaldepPython;
        }
        else if (fs::is_regular_file(venvPython)) {
            pythonExe = venvPython;
        }
        else {
            pythonExe = L"python.exe";
        }

        spdlog::info("startPythonScript: pythonExe={}", pythonExe.generic_string());
        if (!extraEnvNames.empty()) {
            spdlog::info("startPythonScript: extra env names={}", extraEnvNames);
        }
        if (fs::is_directory(localdepDir)) {
            spdlog::info("startPythonScript: VOICEVIDEO_LOCALDEP={}", localdepDir.generic_string());
        }

        try {
            fs::create_directories(workBase);
        }
        catch (const std::exception& e) {
            proc.error = std::string("创建工作目录失败: ") + e.what();
            return proc;
        }

        // 参数文件
        fs::path argsFile = workBase / "args.json";
        proc.outFile = workBase / "output.json";
        proc.stdoutFile = workBase / "stdout.log";
        proc.errFile = workBase / "stderr.log";

        try {
            nlohmann::json argsWithWorkDir = args;
            argsWithWorkDir["work_dir"] = workBase.string();
            std::ofstream ofs(argsFile, std::ios::binary);
            std::string argsStr = argsWithWorkDir.dump(2);
            ofs.write(argsStr.data(), argsStr.size());
        }
        catch (const std::exception& e) {
            proc.error = std::string("写入参数失败: ") + e.what();
            return proc;
        }

        // 命令行
        std::wstring cmdLine = L"\"" + pythonExe.wstring() + L"\" \"" + script.wstring() + L"\" \"" + argsFile.wstring() + L"\"";

        // 重定向 stdout/stderr 到文件
        SECURITY_ATTRIBUTES sa = {};
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = TRUE;
        sa.lpSecurityDescriptor = nullptr;

        auto createFile = [&](const fs::path& p) -> HANDLE {
            return CreateFileW(p.wstring().c_str(), GENERIC_WRITE, FILE_SHARE_READ, &sa,
                CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        };

        HANDLE hOut = createFile(proc.stdoutFile);
        HANDLE hErr = createFile(proc.errFile);
        if (hOut == INVALID_HANDLE_VALUE || hErr == INVALID_HANDLE_VALUE) {
            if (hOut != INVALID_HANDLE_VALUE) CloseHandle(hOut);
            if (hErr != INVALID_HANDLE_VALUE) CloseHandle(hErr);
            proc.error = "无法创建输出文件: " + getLastErrorMessage();
            return proc;
        }

        STARTUPINFOW si = {};
        si.cb = sizeof(si);
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        si.hStdOutput = hOut;
        si.hStdError = hErr;

        BOOL created = CreateProcessW(nullptr, cmdLine.data(), nullptr, nullptr, TRUE,
            CREATE_NO_WINDOW, nullptr, exeDir.wstring().c_str(), &si, &proc.pi);

        // 子进程已启动，清理本次临时环境变量，避免影响后续进程
        for (const auto& kv : env) {
            SetEnvironmentVariableW(Utf8ToWide(kv.first).c_str(), nullptr);
        }

        CloseHandle(hOut);
        CloseHandle(hErr);

        if (!created) {
            proc.error = std::string("启动 Python 进程失败: ") + getLastErrorMessage();
            return proc;
        }

        proc.ok = true;
        return proc;
    }

    std::string runPythonScript(const std::filesystem::path& script,
        const nlohmann::json& args, DWORD timeoutMs, const std::string& workSubdir)
    {
        namespace fs = std::filesystem;
        nlohmann::json errResult;

        PythonProcess proc = startPythonScript(script, args, workSubdir);
        if (!proc.ok) {
            errResult["error"] = proc.error;
            return errResult.dump();
        }

        // 等待完成（不在 WebView2 消息回调里再分发消息，避免重入崩溃）
        bool finished = waitForProcess(proc.pi.hProcess, timeoutMs);
        DWORD exitCode = 0;
        GetExitCodeProcess(proc.pi.hProcess, &exitCode);
        CloseHandle(proc.pi.hProcess);
        CloseHandle(proc.pi.hThread);

        if (!finished) {
            errResult["error"] = "Python 脚本执行超时，请稍后重试";
            return errResult.dump();
        }

        // 优先读取脚本写入的 output.json，避免 stdout 被依赖警告污染
        std::string output;
        try {
            std::filesystem::path jsonFile = proc.outFile.parent_path() / "output.json";
            std::ifstream ifs(jsonFile, std::ios::binary);
            if (ifs) {
                output.assign((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
            }
        }
        catch (...) {}

        // 兜底：读取标准输出日志
        if (output.empty()) {
            try {
                std::ifstream ifs(proc.stdoutFile, std::ios::binary);
                if (ifs) {
                    output.assign((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
                }
            }
            catch (...) {}
        }

        if (!output.empty()) {
            // 尝试解析，确保返回合法 JSON
            try {
                auto j = nlohmann::json::parse(sanitizeUtf8(output));
                return j.dump();
            }
            catch (...) {}
        }

        // 读取 stderr 用于诊断
        std::string errLog;
        try {
            std::ifstream efs(proc.errFile, std::ios::binary);
            if (efs) {
                errLog.assign((std::istreambuf_iterator<char>(efs)), std::istreambuf_iterator<char>());
            }
        }
        catch (...) {}

        errResult["error"] = std::string("Python 进程异常 (exit=") + std::to_string(exitCode) + "): " + (errLog.empty() ? "无输出" : sanitizeUtf8(errLog).substr(0, 400));
        return errResult.dump();
    }

    struct RewriteTask {
        HANDLE hProcess = nullptr;
        HANDLE hThread = nullptr;
        std::atomic<bool> finished{ false };
        std::string resultJson;
        std::filesystem::path outFile;
    };

    std::mutex g_rewriteTasksMutex;
    std::unordered_map<std::string, std::shared_ptr<RewriteTask>> g_rewriteTasks;

    struct ExtractTask {
        HANDLE hProcess = nullptr;
        HANDLE hThread = nullptr;
        std::atomic<bool> finished{ false };
        std::string resultJson;
        std::filesystem::path outFile;
        std::filesystem::path stdoutFile;
        std::filesystem::path errFile;
    };

    std::mutex g_extractTasksMutex;
    std::unordered_map<std::string, std::shared_ptr<ExtractTask>> g_extractTasks;

    std::mutex g_xhsLoginStatusTasksMutex;
    std::unordered_map<std::string, std::shared_ptr<RewriteTask>> g_xhsLoginStatusTasks;

    struct XiaohongshuLoginProcess {
        HANDLE hProcess = nullptr;
        HANDLE hThread = nullptr;
        std::chrono::steady_clock::time_point startTime;
        std::atomic<bool> finished{ false };
    };

    std::mutex g_xhsLoginMutex;
    std::unordered_map<std::string, std::shared_ptr<XiaohongshuLoginProcess>> g_xhsLoginProcesses;

    void monitorXiaohongshuLoginProcess(const std::string& cookiePath, std::shared_ptr<XiaohongshuLoginProcess> proc)
    {
        if (!proc || !proc->hProcess) return;
        DWORD waitResult = WaitForSingleObject(proc->hProcess, 10 * 60 * 1000); // 最多等 10 分钟
        if (waitResult == WAIT_TIMEOUT) {
            TerminateProcess(proc->hProcess, 1);
        }
        {
            std::lock_guard<std::mutex> lock(g_xhsLoginMutex);
            auto it = g_xhsLoginProcesses.find(cookiePath);
            if (it != g_xhsLoginProcesses.end()) {
                if (it->second->hProcess) {
                    CloseHandle(it->second->hProcess);
                    it->second->hProcess = nullptr;
                }
                if (it->second->hThread) {
                    CloseHandle(it->second->hThread);
                    it->second->hThread = nullptr;
                }
                it->second->finished = true;
                // 5 分钟后清理记录，避免 map 无限增长
                std::thread([cookiePath]() {
                    std::this_thread::sleep_for(std::chrono::minutes(5));
                    std::lock_guard<std::mutex> lock(g_xhsLoginMutex);
                    g_xhsLoginProcesses.erase(cookiePath);
                }).detach();
            }
        }
    }

    std::string generateTaskId()
    {
        using namespace std::chrono;
        auto ns = duration_cast<nanoseconds>(steady_clock::now().time_since_epoch()).count();
        std::random_device rd;
        std::mt19937 gen(rd());
        std::uniform_int_distribution<> dis(0, 15);
        std::string id = std::to_string(ns);
        for (int i = 0; i < 8; ++i) {
            id += "0123456789abcdef"[dis(gen)];
        }
        return id;
    }

    void monitorExtractTask(std::string taskId, HANDLE hProcess, HANDLE hThread,
        std::filesystem::path outFile, std::filesystem::path stdoutFile, std::filesystem::path errFile)
    {
        namespace fs = std::filesystem;
        bool finished = waitForProcess(hProcess, INFINITE);
        DWORD exitCode = 0;
        GetExitCodeProcess(hProcess, &exitCode);
        CloseHandle(hProcess);
        CloseHandle(hThread);

        // extract_link.py 会将最终结果写入 work_dir/output.json
        std::string output;
        try {
            std::ifstream ifs(outFile, std::ios::binary);
            if (ifs) {
                output.assign((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
            }
        }
        catch (...) {}

        // 兜底：读取 stdout 日志
        if (output.empty()) {
            try {
                std::ifstream ifs(stdoutFile, std::ios::binary);
                if (ifs) {
                    output.assign((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
                }
            }
            catch (...) {}
        }

        std::string resultJson;
        if (!output.empty()) {
            try {
                auto j = nlohmann::json::parse(sanitizeUtf8(output));
                resultJson = j.dump();
            }
            catch (...) {}
        }

        if (resultJson.empty()) {
            std::string errLog;
            try {
                std::ifstream efs(errFile, std::ios::binary);
                if (efs) {
                    errLog.assign((std::istreambuf_iterator<char>(efs)), std::istreambuf_iterator<char>());
                }
            }
            catch (...) {}
            nlohmann::json err;
            err["error"] = std::string("提取进程异常 (exit=") + std::to_string(exitCode) + "): " + (errLog.empty() ? "无输出" : sanitizeUtf8(errLog).substr(0, 400));
            resultJson = err.dump();
        }

        std::lock_guard<std::mutex> lock(g_extractTasksMutex);
        auto it = g_extractTasks.find(taskId);
        if (it != g_extractTasks.end()) {
            it->second->finished = true;
            it->second->resultJson = resultJson;
        }
    }

    std::string startExtractTask(const std::string& reqJson)
    {
        namespace fs = std::filesystem;
        nlohmann::json errResult;

        try {
            std::string reqClean = sanitizeUtf8(reqJson);
            nlohmann::json j = nlohmann::json::parse(reqClean);
            std::string url = j.value("url", "");
            if (url.empty()) {
                errResult["error"] = "缺少视频链接或文件路径";
                return errResult.dump();
            }

            fs::path exeDir = getExecutableDirectory();
            if (exeDir.empty()) {
                errResult["error"] = "无法定位程序目录";
                return errResult.dump();
            }

            fs::path projectRoot = findProjectRoot(exeDir);
            fs::path script = projectRoot / "tools" / "extract_link.py";
            if (!fs::is_regular_file(script)) {
                errResult["error"] = "未找到提取脚本: " + script.generic_string();
                return errResult.dump();
            }

            nlohmann::json args;
            args["url"] = url;

            bool useCloud = j.value("use_cloud", false);
            std::string dashscopeKey = j.value("dashscope_key", "");
            std::string workspaceId = j.value("workspace_id", "");
            if (useCloud && !dashscopeKey.empty() && !workspaceId.empty()) {
                args["use_cloud"] = true;
                args["workspace_id"] = workspaceId;
            }

            std::unordered_map<std::string, std::string> env;
            if (useCloud && !dashscopeKey.empty()) {
                env["DASHSCOPE_API_KEY"] = dashscopeKey;
            }

            PythonProcess proc = startPythonScript(script, args, "extract", env);
            if (!proc.ok) {
                errResult["error"] = proc.error;
                return errResult.dump();
            }

            std::string taskId = generateTaskId();
            auto task = std::make_shared<ExtractTask>();
            task->hProcess = proc.pi.hProcess;
            task->hThread = proc.pi.hThread;
            task->outFile = proc.outFile;
            task->stdoutFile = proc.stdoutFile;
            task->errFile = proc.errFile;
            {
                std::lock_guard<std::mutex> lock(g_extractTasksMutex);
                g_extractTasks[taskId] = task;
            }

            std::thread(monitorExtractTask, taskId, proc.pi.hProcess, proc.pi.hThread, proc.outFile, proc.stdoutFile, proc.errFile).detach();

            nlohmann::json result;
            result["taskId"] = taskId;
            result["status"] = "running";
            return result.dump();
        }
        catch (const std::exception& e) {
            errResult["error"] = std::string("参数解析失败: ") + e.what();
            return errResult.dump();
        }
    }

    std::string checkExtractTask(const std::string& reqJson)
    {
        nlohmann::json result;
        try {
            std::string reqClean = sanitizeUtf8(reqJson);
            nlohmann::json j = nlohmann::json::parse(reqClean);
            std::string taskId = j.value("taskId", "");

            std::shared_ptr<ExtractTask> task;
            {
                std::lock_guard<std::mutex> lock(g_extractTasksMutex);
                auto it = g_extractTasks.find(taskId);
                if (it == g_extractTasks.end()) {
                    result["status"] = "not_found";
                    return result.dump();
                }
                task = it->second;
            }

            if (!task->finished.load()) {
                result["status"] = "running";
                return result.dump();
            }

            {
                std::lock_guard<std::mutex> lock(g_extractTasksMutex);
                g_extractTasks.erase(taskId);
            }

            try {
                auto jout = nlohmann::json::parse(task->resultJson);
                if (jout.contains("text") && jout["text"].is_string()) {
                    result["status"] = "done";
                    result["text"] = jout["text"];
                }
                else if (jout.contains("error")) {
                    result["status"] = "error";
                    result["error"] = jout["error"];
                }
                else {
                    result["status"] = "error";
                    result["error"] = "提取结果异常";
                }
            }
            catch (...) {
                result["status"] = "error";
                result["error"] = "解析提取结果失败";
            }
            return result.dump();
        }
        catch (const std::exception& e) {
            result["status"] = "error";
            result["error"] = std::string("参数解析失败: ") + e.what();
            return result.dump();
        }
    }


    void monitorRewriteTask(std::string taskId, HANDLE hProcess, HANDLE hThread,
        std::filesystem::path outFile, std::filesystem::path errFile)
    {
        namespace fs = std::filesystem;
        bool finished = waitForProcess(hProcess, INFINITE);
        DWORD exitCode = 0;
        GetExitCodeProcess(hProcess, &exitCode);
        CloseHandle(hProcess);
        CloseHandle(hThread);

        // 脚本同时会把 JSON 结果写入 work_dir/output.json，优先读取它（可避免 stdout 中的依赖警告污染）
        std::string output;
        try {
            fs::path jsonFile = outFile.parent_path() / "output.json";
            std::ifstream ifs(jsonFile, std::ios::binary);
            if (ifs) {
                output.assign((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
            }
        }
        catch (...) {}

        // 兜底：读取 stdout 日志
        if (output.empty()) {
            try {
                std::ifstream ifs(outFile.parent_path() / "stdout.log", std::ios::binary);
                if (ifs) {
                    output.assign((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
                }
            }
            catch (...) {}
        }

        std::string resultJson;
        if (!output.empty()) {
            try {
                auto j = nlohmann::json::parse(sanitizeUtf8(output));
                // 如果进程已结束但 output.json 仍停留在 running，说明脚本异常终止
                // 没有写入错误信息，这里补一个带诊断信息的错误结果。
                if (j.value("status", "") == "running") {
                    j["status"] = "error";
                    j["error"] = std::string("任务进程异常结束 (exit=") + std::to_string(exitCode) + ")";
                }
                resultJson = j.dump();
            }
            catch (...) {}
        }

        if (resultJson.empty()) {
            std::string errLog;
            try {
                std::ifstream efs(errFile, std::ios::binary);
                if (efs) {
                    errLog.assign((std::istreambuf_iterator<char>(efs)), std::istreambuf_iterator<char>());
                }
            }
            catch (...) {}
            nlohmann::json err;
            err["error"] = std::string("Python 进程异常 (exit=") + std::to_string(exitCode) + "): " + (errLog.empty() ? "无输出" : sanitizeUtf8(errLog).substr(0, 400));
            resultJson = err.dump();
        }

        std::lock_guard<std::mutex> lock(g_rewriteTasksMutex);
        auto it = g_rewriteTasks.find(taskId);
        if (it != g_rewriteTasks.end()) {
            it->second->finished = true;
            it->second->resultJson = resultJson;
        }
    }

    void monitorXiaohongshuLoginStatusTask(std::string taskId, HANDLE hProcess, HANDLE hThread,
        std::filesystem::path outFile, std::filesystem::path errFile)
    {
        namespace fs = std::filesystem;
        bool finished = waitForProcess(hProcess, INFINITE);
        DWORD exitCode = 0;
        GetExitCodeProcess(hProcess, &exitCode);
        CloseHandle(hProcess);
        CloseHandle(hThread);

        std::string output;
        try {
            fs::path jsonFile = outFile.parent_path() / "output.json";
            std::ifstream ifs(jsonFile, std::ios::binary);
            if (ifs) {
                output.assign((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
            }
        }
        catch (...) {}

        if (output.empty()) {
            try {
                std::ifstream ifs(outFile.parent_path() / "stdout.log", std::ios::binary);
                if (ifs) {
                    output.assign((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
                }
            }
            catch (...) {}
        }

        std::string resultJson;
        if (!output.empty()) {
            try {
                auto j = nlohmann::json::parse(sanitizeUtf8(output));
                resultJson = j.dump();
            }
            catch (...) {}
        }

        if (resultJson.empty()) {
            std::string errLog;
            try {
                std::ifstream efs(errFile, std::ios::binary);
                if (efs) {
                    errLog.assign((std::istreambuf_iterator<char>(efs)), std::istreambuf_iterator<char>());
                }
            }
            catch (...) {}
            nlohmann::json err;
            err["error"] = std::string("登录状态检查进程异常 (exit=") + std::to_string(exitCode) + "): " + (errLog.empty() ? "无输出" : sanitizeUtf8(errLog).substr(0, 400));
            resultJson = err.dump();
        }

        std::lock_guard<std::mutex> lock(g_xhsLoginStatusTasksMutex);
        auto it = g_xhsLoginStatusTasks.find(taskId);
        if (it != g_xhsLoginStatusTasks.end()) {
            it->second->finished = true;
            it->second->resultJson = resultJson;
        }
    }

    std::string startModelTask(const std::string& reqJson, const std::string& mode)
    {
        namespace fs = std::filesystem;
        nlohmann::json errResult;

        try {
            std::string reqClean = sanitizeUtf8(reqJson);
            nlohmann::json j = nlohmann::json::parse(reqClean);
            std::string text = j.value("text", "");
            if (text.empty()) {
                errResult["error"] = "缺少原文案";
                return errResult.dump();
            }

            fs::path exeDir = getExecutableDirectory();
            if (exeDir.empty()) {
                errResult["error"] = "无法定位程序目录";
                return errResult.dump();
            }

            fs::path projectRoot = findProjectRoot(exeDir);
            fs::path script = projectRoot / "tools" / "rewrite_text.py";
            if (!fs::is_regular_file(script)) {
                errResult["error"] = "未找到改写脚本: " + script.generic_string();
                return errResult.dump();
            }

            nlohmann::json args;
            args["text"] = text;
            args["mode"] = mode;
            if (mode == "rewrite") {
                args["style"] = j.value("style", "default");
                args["length"] = j.value("length", "300");
            }
            if (mode == "translate") {
                args["target_lang"] = j.value("target_lang", "en");
            }

            bool useCloud = j.value("use_cloud", false);
            std::string dashscopeKey = j.value("dashscope_key", "");
            std::string workspaceId = j.value("workspace_id", "");

            std::unordered_map<std::string, std::string> env;
            if (useCloud && !dashscopeKey.empty() && !workspaceId.empty()) {
                script = projectRoot / "tools" / "rewrite_text_cloud.py";
                args["workspace_id"] = workspaceId;
                env["DASHSCOPE_API_KEY"] = dashscopeKey;
            }

            PythonProcess proc = startPythonScript(script, args, "rewrite", env);
            if (!proc.ok) {
                errResult["error"] = proc.error;
                return errResult.dump();
            }

            std::string taskId = generateTaskId();
            auto task = std::make_shared<RewriteTask>();
            task->hProcess = proc.pi.hProcess;
            task->hThread = proc.pi.hThread;
            task->outFile = proc.outFile;
            {
                std::lock_guard<std::mutex> lock(g_rewriteTasksMutex);
                g_rewriteTasks[taskId] = task;
            }

            std::thread(monitorRewriteTask, taskId, proc.pi.hProcess, proc.pi.hThread, proc.outFile, proc.errFile).detach();

            nlohmann::json result;
            result["taskId"] = taskId;
            result["status"] = "running";
            return result.dump();
        }
        catch (const std::exception& e) {
            errResult["error"] = std::string("参数解析失败: ") + e.what();
            return errResult.dump();
        }
    }

    std::string startRewriteTask(const std::string& reqJson)
    {
        return startModelTask(reqJson, "rewrite");
    }

    std::string startLegalCheckTask(const std::string& reqJson)
    {
        return startModelTask(reqJson, "legal");
    }

    std::string checkRewriteTask(const std::string& reqJson)
    {
        nlohmann::json result;
        try {
            std::string reqClean = sanitizeUtf8(reqJson);
            nlohmann::json j = nlohmann::json::parse(reqClean);
            std::string taskId = j.value("taskId", "");

            std::shared_ptr<RewriteTask> task;
            {
                std::lock_guard<std::mutex> lock(g_rewriteTasksMutex);
                auto it = g_rewriteTasks.find(taskId);
                if (it == g_rewriteTasks.end()) {
                    result["status"] = "not_found";
                    return result.dump();
                }
                task = it->second;
            }

            if (!task->finished.load()) {
                result["status"] = "running";
                return result.dump();
            }

            {
                std::lock_guard<std::mutex> lock(g_rewriteTasksMutex);
                g_rewriteTasks.erase(taskId);
            }

            try {
                auto jout = nlohmann::json::parse(task->resultJson);
                if (jout.contains("text") && jout["text"].is_string()) {
                    result["status"] = "done";
                    result["text"] = jout["text"];
                }
                else if (jout.contains("error")) {
                    result["status"] = "error";
                    result["error"] = jout["error"];
                }
                else {
                    result["status"] = "error";
                    result["error"] = "未知错误";
                }
            }
            catch (...) {
                result["status"] = "error";
                result["error"] = "结果解析失败";
            }
            return result.dump();
        }
        catch (const std::exception& e) {
            result["status"] = "error";
            result["error"] = std::string("参数解析失败: ") + e.what();
            return result.dump();
        }
    }

    std::string startVoiceTask(const std::string& reqJson)
    {
        namespace fs = std::filesystem;
        nlohmann::json errResult;

        try {
            std::string reqClean = sanitizeUtf8(reqJson);
            nlohmann::json j = nlohmann::json::parse(reqClean);
            std::string text = j.value("text", "");
            if (text.empty()) {
                errResult["error"] = "缺少文案";
                return errResult.dump();
            }

            fs::path exeDir = getExecutableDirectory();
            if (exeDir.empty()) {
                errResult["error"] = "无法定位程序目录";
                return errResult.dump();
            }

            fs::path projectRoot = findProjectRoot(exeDir);
            fs::path script = projectRoot / "tools" / "generate_voice.py";
            if (!fs::is_regular_file(script)) {
                errResult["error"] = "未找到声音生成脚本: " + script.generic_string();
                return errResult.dump();
            }

            nlohmann::json args;
            args["text"] = text;
            args["speaker"] = j.value("speaker", "female-sales");
            args["speed"] = j.value("speed", 1.0);
            args["language"] = j.value("language", "Chinese");

            bool useCloud = j.value("use_cloud", false);
            std::string dashscopeKey = j.value("dashscope_key", "");
            std::string workspaceId = j.value("workspace_id", "");

            std::unordered_map<std::string, std::string> env;
            if (useCloud && !dashscopeKey.empty() && !workspaceId.empty()) {
                script = projectRoot / "tools" / "generate_voice_cloud.py";
                args["workspace_id"] = workspaceId;
                args["model"] = "cosyvoice-v3-plus";
                if (j.contains("custom_voice_sample")) {
                    args["custom_voice_sample"] = j.value("custom_voice_sample", "");
                }
                env["DASHSCOPE_API_KEY"] = dashscopeKey;
            }
            else {
                args["model"] = j.value("model", "fast");
                args["emotion"] = j.value("emotion", "calm");
                args["emotion_intensity"] = j.value("emotion_intensity", 0.5);
            }

            PythonProcess proc = startPythonScript(script, args, "voice", env);
            if (!proc.ok) {
                errResult["error"] = proc.error;
                return errResult.dump();
            }

            std::string taskId = generateTaskId();
            auto task = std::make_shared<RewriteTask>();
            task->hProcess = proc.pi.hProcess;
            task->hThread = proc.pi.hThread;
            task->outFile = proc.outFile;
            {
                std::lock_guard<std::mutex> lock(g_rewriteTasksMutex);
                g_rewriteTasks[taskId] = task;
            }

            std::thread(monitorRewriteTask, taskId, proc.pi.hProcess, proc.pi.hThread, proc.outFile, proc.errFile).detach();

            nlohmann::json result;
            result["taskId"] = taskId;
            result["status"] = "running";
            return result.dump();
        }
        catch (const std::exception& e) {
            errResult["error"] = std::string("参数解析失败: ") + e.what();
            return errResult.dump();
        }
    }

    std::string checkVoiceTask(const std::string& reqJson)
    {
        nlohmann::json result;
        try {
            std::string reqClean = sanitizeUtf8(reqJson);
            nlohmann::json j = nlohmann::json::parse(reqClean);
            std::string taskId = j.value("taskId", "");

            std::shared_ptr<RewriteTask> task;
            {
                std::lock_guard<std::mutex> lock(g_rewriteTasksMutex);
                auto it = g_rewriteTasks.find(taskId);
                if (it == g_rewriteTasks.end()) {
                    result["status"] = "not_found";
                    return result.dump();
                }
                task = it->second;
            }

            if (!task->finished.load()) {
                result["status"] = "running";
                // 任务仍在运行，尝试从 output.json 读取进度信息
                try {
                    namespace fs = std::filesystem;
                    fs::path progressFile = task->outFile.parent_path() / "output.json";
                    std::ifstream ifs(progressFile, std::ios::binary);
                    if (ifs) {
                        std::string content((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
                        if (!content.empty()) {
                            auto jout = nlohmann::json::parse(sanitizeUtf8(content));
                            if (jout.value("status", "") == "running" && jout.contains("progress")) {
                                result["progress"] = jout["progress"];
                            }
                        }
                    }
                }
                catch (...) {}
                return result.dump();
            }

            {
                std::lock_guard<std::mutex> lock(g_rewriteTasksMutex);
                g_rewriteTasks.erase(taskId);
            }

            try {
                auto jout = nlohmann::json::parse(task->resultJson);
                if (jout.contains("audio_path") && jout["audio_path"].is_string()) {
                    result["status"] = "done";
                    result["audio_path"] = jout["audio_path"];
                    if (jout.contains("duration")) {
                        result["duration"] = jout["duration"];
                    }
                }
                else if (jout.contains("error")) {
                    result["status"] = "error";
                    result["error"] = jout["error"];
                }
                else {
                    result["status"] = "error";
                    result["error"] = "未知错误";
                }
            }
            catch (...) {
                result["status"] = "error";
                result["error"] = "结果解析失败";
            }
            return result.dump();
        }
        catch (const std::exception& e) {
            result["status"] = "error";
            result["error"] = std::string("参数解析失败: ") + e.what();
            return result.dump();
        }
    }

    static std::string stripFileUri(std::string path)
    {
        if (path.rfind("file:///", 0) == 0) {
            path = path.substr(8);
        }
        else if (path.rfind("file://", 0) == 0) {
            path = path.substr(7);
        }
        std::replace(path.begin(), path.end(), '/', '\\');
        return path;
    }

    std::string startGenerateVideoTask(const std::string& reqJson)
    {
        namespace fs = std::filesystem;
        nlohmann::json errResult;

        try {
            std::string reqClean = sanitizeUtf8(reqJson);
            nlohmann::json j = nlohmann::json::parse(reqClean);

            std::string audioPathStr = stripFileUri(j.value("audio_path", ""));
            std::string avatarValue = j.value("avatar_value", "");
            std::string avatarPathStr = stripFileUri(j.value("avatar_path", ""));
            std::string avatarTargetStr = stripFileUri(j.value("avatar_target_path", ""));

            bool useCloud = j.value("use_cloud", false);
            std::string dashscopeKey = j.value("dashscope_key", "");
            std::string wanStyle = j.value("wan_style", "speech");
            std::string wanResolution = j.value("wan_resolution", "480P");

            spdlog::info("startGenerateVideoTask: use_cloud={}, wan_style={}, wan_resolution={}",
                useCloud, wanStyle, wanResolution);

            if (audioPathStr.empty()) {
                errResult["error"] = "缺少驱动音频";
                return errResult.dump();
            }
            if (avatarValue.empty() || avatarPathStr.empty()) {
                errResult["error"] = "缺少形象图片";
                return errResult.dump();
            }

            fs::path exeDir = getExecutableDirectory();
            if (exeDir.empty()) {
                errResult["error"] = "无法定位程序目录";
                return errResult.dump();
            }

            fs::path projectRoot = findProjectRoot(exeDir);

            fs::path sourceImage;
            if (avatarValue.rfind("sample", 0) == 0) {
                fs::path thumbPath = fs::path(avatarPathStr);
                sourceImage = projectRoot / "assets" / "thumbs" / thumbPath.filename();
            }
            else {
                if (avatarTargetStr.empty()) {
                    errResult["error"] = "用户形象缺少目标路径";
                    return errResult.dump();
                }
                sourceImage = projectRoot / fs::path(avatarTargetStr);
                fs::path src = fs::path(avatarPathStr);
                if (!fs::is_regular_file(src)) {
                    errResult["error"] = "上传的形象文件不存在: " + src.generic_string();
                    return errResult.dump();
                }
                try {
                    fs::create_directories(sourceImage.parent_path());
                    fs::copy_file(src, sourceImage, fs::copy_options::overwrite_existing);
                }
                catch (const std::exception& e) {
                    errResult["error"] = std::string("复制形象文件失败: ") + e.what();
                    return errResult.dump();
                }
            }

            if (!fs::is_regular_file(sourceImage)) {
                errResult["error"] = "形象图片不存在: " + sourceImage.generic_string();
                return errResult.dump();
            }

            std::string taskId = generateTaskId();
            fs::path workBase = projectRoot / "temp" / "video" / taskId;
            fs::create_directories(workBase);

            // 复制到工作目录并使用英文文件名，避免 OpenCV 读取中文路径异常
            fs::path safeSource = workBase / "source_image.png";
            try {
                fs::copy_file(sourceImage, safeSource, fs::copy_options::overwrite_existing);
            }
            catch (const std::exception& e) {
                errResult["error"] = std::string("复制形象图片失败: ") + e.what();
                return errResult.dump();
            }

            fs::path audioPath = fs::path(audioPathStr);
            if (!audioPath.is_absolute()) {
                audioPath = projectRoot / audioPath;
            }

            fs::path outputPath = workBase / "output.mp4";

            nlohmann::json args;
            args["source_image"] = safeSource.generic_string();
            args["audio_path"] = audioPath.generic_string();
            args["output_path"] = outputPath.generic_string();
            args["work_dir"] = workBase.generic_string();

            fs::path script;
            std::unordered_map<std::string, std::string> env;
            if (useCloud && !dashscopeKey.empty()) {
                script = projectRoot / "tools" / "generate_video_cloud.py";
                args["style"] = wanStyle;
                args["resolution"] = wanResolution;
                env["DASHSCOPE_API_KEY"] = dashscopeKey;
            }
            else {
                script = projectRoot / "tools" / "generate_video.py";
                args["sadtalker_root"] = (projectRoot / "github" / "SadTalker").generic_string();
            }

            if (!fs::is_regular_file(script)) {
                errResult["error"] = "未找到视频生成脚本: " + script.generic_string();
                return errResult.dump();
            }

            PythonProcess proc = startPythonScript(script, args, "video", env);
            if (!proc.ok) {
                errResult["error"] = proc.error;
                return errResult.dump();
            }

            auto task = std::make_shared<RewriteTask>();
            task->hProcess = proc.pi.hProcess;
            task->hThread = proc.pi.hThread;
            task->outFile = proc.outFile;
            {
                std::lock_guard<std::mutex> lock(g_rewriteTasksMutex);
                g_rewriteTasks[taskId] = task;
            }

            std::thread(monitorRewriteTask, taskId, proc.pi.hProcess, proc.pi.hThread, proc.outFile, proc.errFile).detach();

            nlohmann::json result;
            result["taskId"] = taskId;
            result["status"] = "running";
            return result.dump();
        }
        catch (const std::exception& e) {
            errResult["error"] = std::string("参数解析失败: ") + e.what();
            return errResult.dump();
        }
    }

    std::string checkGenerateVideoTask(const std::string& reqJson)
    {
        nlohmann::json result;
        try {
            std::string reqClean = sanitizeUtf8(reqJson);
            nlohmann::json j = nlohmann::json::parse(reqClean);
            std::string taskId = j.value("taskId", "");

            std::shared_ptr<RewriteTask> task;
            {
                std::lock_guard<std::mutex> lock(g_rewriteTasksMutex);
                auto it = g_rewriteTasks.find(taskId);
                if (it == g_rewriteTasks.end()) {
                    result["status"] = "not_found";
                    return result.dump();
                }
                task = it->second;
            }

            if (!task->finished.load()) {
                result["status"] = "running";
                try {
                    namespace fs = std::filesystem;
                    fs::path progressFile = task->outFile.parent_path() / "output.json";
                    std::ifstream ifs(progressFile, std::ios::binary);
                    if (ifs) {
                        std::string content((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
                        if (!content.empty()) {
                            auto jout = nlohmann::json::parse(sanitizeUtf8(content));
                            if (jout.value("status", "") == "running" && jout.contains("progress")) {
                                result["progress"] = jout["progress"];
                            }
                        }
                    }
                }
                catch (...) {}
                return result.dump();
            }

            {
                std::lock_guard<std::mutex> lock(g_rewriteTasksMutex);
                g_rewriteTasks.erase(taskId);
            }

            try {
                auto jout = nlohmann::json::parse(task->resultJson);
                if (jout.contains("video_path") && jout["video_path"].is_string()) {
                    result["status"] = "done";
                    result["video_path"] = jout["video_path"];
                    if (jout.contains("poster_path") && jout["poster_path"].is_string()) {
                        result["poster_path"] = jout["poster_path"];
                    }
                    if (jout.contains("partial") && jout["partial"].is_boolean()) {
                        result["partial"] = jout["partial"].get<bool>();
                    }
                    if (jout.contains("warning") && jout["warning"].is_string()) {
                        result["warning"] = jout["warning"].get<std::string>();
                    }
                }
                else if (jout.contains("error")) {
                    result["status"] = "error";
                    result["error"] = jout["error"];
                }
                else {
                    result["status"] = "error";
                    result["error"] = "未知错误";
                }
            }
            catch (...) {
                result["status"] = "error";
                result["error"] = "结果解析失败";
            }
            return result.dump();
        }
        catch (const std::exception& e) {
            result["status"] = "error";
            result["error"] = std::string("参数解析失败: ") + e.what();
            return result.dump();
        }
    }

    std::string startCutVideoTask(const std::string& reqJson)
    {
        namespace fs = std::filesystem;
        nlohmann::json errResult;

        try {
            std::string reqClean = sanitizeUtf8(reqJson);
            nlohmann::json j = nlohmann::json::parse(reqClean);

            std::string videoPathStr = stripFileUri(j.value("video_path", ""));
            if (videoPathStr.empty()) {
                errResult["error"] = "缺少视频源";
                return errResult.dump();
            }
            fs::path videoPath = fs::path(videoPathStr);
            if (!fs::is_regular_file(videoPath)) {
                errResult["error"] = "视频文件不存在: " + videoPath.generic_string();
                return errResult.dump();
            }

            fs::path exeDir = getExecutableDirectory();
            if (exeDir.empty()) {
                errResult["error"] = "无法定位程序目录";
                return errResult.dump();
            }

            fs::path projectRoot = findProjectRoot(exeDir);
            fs::path script = projectRoot / "tools" / "video_cut.py";
            if (!fs::is_regular_file(script)) {
                errResult["error"] = "未找到剪辑脚本: " + script.generic_string();
                return errResult.dump();
            }

            std::string taskId = generateTaskId();
            fs::path workBase = projectRoot / "temp" / "video_cut" / taskId;
            fs::create_directories(workBase);

            nlohmann::json args;
            args["video_path"] = videoPath.generic_string();
            args["options"] = j.value("options", nlohmann::json::object());

            PythonProcess proc = startPythonScript(script, args, (fs::path("video_cut") / taskId).string());
            if (!proc.ok) {
                errResult["error"] = proc.error;
                return errResult.dump();
            }

            auto task = std::make_shared<RewriteTask>();
            task->hProcess = proc.pi.hProcess;
            task->hThread = proc.pi.hThread;
            task->outFile = proc.outFile;
            {
                std::lock_guard<std::mutex> lock(g_rewriteTasksMutex);
                g_rewriteTasks[taskId] = task;
            }

            std::thread(monitorRewriteTask, taskId, proc.pi.hProcess, proc.pi.hThread, proc.outFile, proc.errFile).detach();

            nlohmann::json result;
            result["taskId"] = taskId;
            result["status"] = "running";
            return result.dump();
        }
        catch (const std::exception& e) {
            errResult["error"] = std::string("参数解析失败: ") + e.what();
            return errResult.dump();
        }
    }

    std::string checkCutVideoTask(const std::string& reqJson)
    {
        nlohmann::json result;
        try {
            std::string reqClean = sanitizeUtf8(reqJson);
            nlohmann::json j = nlohmann::json::parse(reqClean);
            std::string taskId = j.value("taskId", "");

            std::shared_ptr<RewriteTask> task;
            {
                std::lock_guard<std::mutex> lock(g_rewriteTasksMutex);
                auto it = g_rewriteTasks.find(taskId);
                if (it == g_rewriteTasks.end()) {
                    result["status"] = "not_found";
                    return result.dump();
                }
                task = it->second;
            }

            if (!task->finished.load()) {
                result["status"] = "running";
                try {
                    namespace fs = std::filesystem;
                    fs::path progressFile = task->outFile.parent_path() / "output.json";
                    std::ifstream ifs(progressFile, std::ios::binary);
                    if (ifs) {
                        std::string content((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
                        if (!content.empty()) {
                            auto jout = nlohmann::json::parse(sanitizeUtf8(content));
                            if (jout.value("status", "") == "running") {
                                result["percent"] = jout.value("percent", 0);
                                result["message"] = jout.value("message", "");
                            }
                        }
                    }
                }
                catch (...) {}
                return result.dump();
            }

            {
                std::lock_guard<std::mutex> lock(g_rewriteTasksMutex);
                g_rewriteTasks.erase(taskId);
            }

            try {
                auto jout = nlohmann::json::parse(task->resultJson);
                if (jout.contains("video_path") && jout["video_path"].is_string()) {
                    result["status"] = "done";
                    result["video_path"] = jout["video_path"];
                }
                else if (jout.contains("error")) {
                    result["status"] = "error";
                    result["error"] = jout["error"];
                }
                else {
                    result["status"] = "error";
                    result["error"] = "未知错误";
                }
            }
            catch (...) {
                result["status"] = "error";
                result["error"] = "结果解析失败";
            }
            return result.dump();
        }
        catch (const std::exception& e) {
            result["status"] = "error";
            result["error"] = std::string("参数解析失败: ") + e.what();
            return result.dump();
        }
    }

    std::string startBannerTask(const std::string& reqJson, const std::string& mode)
    {
        namespace fs = std::filesystem;
        nlohmann::json errResult;
        try {
            std::string reqClean = sanitizeUtf8(reqJson);
            nlohmann::json j = nlohmann::json::parse(reqClean);

            fs::path exeDir = getExecutableDirectory();
            if (exeDir.empty()) {
                errResult["error"] = "无法定位程序目录";
                return errResult.dump();
            }
            fs::path projectRoot = findProjectRoot(exeDir);
            fs::path script = projectRoot / "tools" / "generate_banner.py";
            if (!fs::is_regular_file(script)) {
                errResult["error"] = "未找到封面脚本: " + script.generic_string();
                return errResult.dump();
            }

            if (mode == "extract_frame") {
                std::string videoPathStr = j.value("video_path", "");
                if (videoPathStr.empty()) {
                    errResult["error"] = "缺少视频源";
                    return errResult.dump();
                }
                fs::path videoPath = fs::path(videoPathStr);
                if (!fs::is_regular_file(videoPath)) {
                    errResult["error"] = "视频文件不存在: " + videoPath.generic_string();
                    return errResult.dump();
                }
            }
            else if (mode == "generate") {
                std::string coverPathStr = j.value("cover_path", "");
                if (!coverPathStr.empty()) {
                    fs::path coverPath = fs::path(coverPathStr);
                    if (!fs::is_regular_file(coverPath)) {
                        errResult["error"] = "封面图片不存在: " + coverPath.generic_string();
                        return errResult.dump();
                    }
                }
            }

            std::string taskId = generateTaskId();
            fs::path workBase = projectRoot / "temp" / "banner" / taskId;
            fs::create_directories(workBase);

            nlohmann::json args = j;
            args["mode"] = mode;
            args["output_json"] = (workBase / "output.json").generic_string();

            if (mode == "generate") {
                args["output_path"] = (workBase / "output.jpg").generic_string();
            }
            else if (mode == "extract_frame") {
                args["output_path"] = (workBase / "frame.jpg").generic_string();
            }
            else {
                errResult["error"] = "未知封面任务模式: " + mode;
                return errResult.dump();
            }

            spdlog::info("startBannerTask: mode={}, taskId={}", mode, taskId);

            PythonProcess proc = startPythonScript(script, args, (fs::path("banner") / taskId).string());
            if (!proc.ok) {
                errResult["error"] = proc.error;
                return errResult.dump();
            }

            auto task = std::make_shared<RewriteTask>();
            task->hProcess = proc.pi.hProcess;
            task->hThread = proc.pi.hThread;
            task->outFile = proc.outFile;
            {
                std::lock_guard<std::mutex> lock(g_rewriteTasksMutex);
                g_rewriteTasks[taskId] = task;
            }

            std::thread(monitorRewriteTask, taskId, proc.pi.hProcess, proc.pi.hThread, proc.outFile, proc.errFile).detach();

            nlohmann::json result;
            result["taskId"] = taskId;
            result["status"] = "running";
            return result.dump();
        }
        catch (const std::exception& e) {
            errResult["error"] = std::string("参数解析失败: ") + e.what();
            return errResult.dump();
        }
    }

    std::string checkBannerTask(const std::string& reqJson)
    {
        nlohmann::json result;
        try {
            std::string reqClean = sanitizeUtf8(reqJson);
            nlohmann::json j = nlohmann::json::parse(reqClean);
            std::string taskId = j.value("taskId", "");

            std::shared_ptr<RewriteTask> task;
            {
                std::lock_guard<std::mutex> lock(g_rewriteTasksMutex);
                auto it = g_rewriteTasks.find(taskId);
                if (it == g_rewriteTasks.end()) {
                    result["status"] = "not_found";
                    return result.dump();
                }
                task = it->second;
            }

            if (!task->finished.load()) {
                result["status"] = "running";
                try {
                    namespace fs = std::filesystem;
                    fs::path progressFile = task->outFile.parent_path() / "output.json";
                    std::ifstream ifs(progressFile, std::ios::binary);
                    if (ifs) {
                        std::string content((std::istreambuf_iterator<char>(ifs)), std::istreambuf_iterator<char>());
                        if (!content.empty()) {
                            auto jout = nlohmann::json::parse(sanitizeUtf8(content));
                            if (jout.value("status", "") == "running") {
                                result["percent"] = jout.value("percent", 0);
                                result["message"] = jout.value("message", "");
                            }
                        }
                    }
                }
                catch (...) {}
                return result.dump();
            }

            {
                std::lock_guard<std::mutex> lock(g_rewriteTasksMutex);
                g_rewriteTasks.erase(taskId);
            }

            try {
                auto jout = nlohmann::json::parse(task->resultJson);
                if (jout.contains("path") && jout["path"].is_string()) {
                    result["status"] = "done";
                    result["path"] = jout["path"];
                }
                else if (jout.contains("error")) {
                    result["status"] = "error";
                    result["error"] = jout["error"];
                }
                else {
                    result["status"] = "error";
                    result["error"] = "未知错误";
                }
            }
            catch (...) {
                result["status"] = "error";
                result["error"] = "结果解析失败";
            }
            return result.dump();
        }
        catch (const std::exception& e) {
            result["status"] = "error";
            result["error"] = std::string("参数解析失败: ") + e.what();
            return result.dump();
        }
    }
#ifdef _WIN32
    struct CurlResponse {
        long code = 0;
        std::string body;
    };

    static size_t curlWriteCallback(void* contents, size_t size, size_t nmemb, void* userp)
    {
        size_t total = size * nmemb;
        std::string* out = static_cast<std::string*>(userp);
        out->append(static_cast<char*>(contents), total);
        return total;
    }

    CurlResponse curlGet(const std::string& url, long timeoutMs = 5000)
    {
        CurlResponse resp;
        CURL* curl = curl_easy_init();
        if (!curl) return resp;
        curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curlWriteCallback);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp.body);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, timeoutMs);
        curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
        curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
        CURLcode res = curl_easy_perform(curl);
        if (res == CURLE_OK) {
            curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &resp.code);
        }
        curl_easy_cleanup(curl);
        return resp;
    }

    CurlResponse curlPost(const std::string& url, const std::string& body, const std::string& contentType = "application/json", long timeoutMs = 5000)
    {
        CurlResponse resp;
        CURL* curl = curl_easy_init();
        if (!curl) return resp;
        curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl, CURLOPT_POST, 1L);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
        struct curl_slist* headers = nullptr;
        std::string ctHeader = "Content-Type: " + contentType;
        headers = curl_slist_append(headers, ctHeader.c_str());
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curlWriteCallback);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp.body);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, timeoutMs);
        curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
        curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
        CURLcode res = curl_easy_perform(curl);
        if (res == CURLE_OK) {
            curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &resp.code);
        }
        if (headers) curl_slist_free_all(headers);
        curl_easy_cleanup(curl);
        return resp;
    }

    // --- Backend and hot-update helpers ---

    std::string getBackendBaseUrl()
    {
        std::string url = "https://kexueapp.com/voicevideo-backend";
#ifdef _WIN32
        char buf[512];
        DWORD len = GetEnvironmentVariableA("VOICEVIDEO_BACKEND_URL", buf, sizeof(buf));
        if (len > 0 && len < sizeof(buf)) {
            url = std::string(buf, len);
        }
#endif
        return url;
    }

    std::string getBackendBaseUrlJson()
    {
        nlohmann::json result;
        result["url"] = getBackendBaseUrl();
        return result.dump();
    }

    std::string readExeVersion()
    {
        namespace fs = std::filesystem;
        fs::path exeDir = getExecutableDirectory();
        fs::path versionFile = exeDir / "version.txt";
        try {
            if (fs::exists(versionFile)) {
                std::ifstream ifs(versionFile);
                std::string version;
                if (std::getline(ifs, version)) {
                    size_t start = version.find_first_not_of(" \t\r\n");
                    if (start != std::string::npos) {
                        size_t end = version.find_last_not_of(" \t\r\n");
                        return version.substr(start, end - start + 1);
                    }
                }
            }
        }
        catch (const std::exception& e) {
            spdlog::warn("Failed to read version.txt: {}", e.what());
        }
        return "0";
    }

    static size_t curlFileWriteCallback(void* ptr, size_t size, size_t nmemb, void* userdata)
    {
        FILE* fp = static_cast<FILE*>(userdata);
        if (!fp) return 0;
        return fwrite(ptr, size, nmemb, fp);
    }

    bool downloadFile(const std::string& url, const std::filesystem::path& dest)
    {
        namespace fs = std::filesystem;
        try {
            fs::create_directories(dest.parent_path());
        }
        catch (...) {}
        FILE* fp = nullptr;
        errno_t err = fopen_s(&fp, dest.string().c_str(), "wb");
        if (err != 0 || !fp) {
            spdlog::error("Failed to open destination file for download: {}", dest.string());
            return false;
        }
        CURL* curl = curl_easy_init();
        if (!curl) {
            fclose(fp);
            return false;
        }
        curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curlFileWriteCallback);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, fp);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 300000L);
        curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
        curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
        CURLcode res = curl_easy_perform(curl);
        long code = 0;
        if (res == CURLE_OK) {
            curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &code);
        }
        curl_easy_cleanup(curl);
        fclose(fp);
        if (res != CURLE_OK || code != 200) {
            spdlog::error("Download failed, curl={} http={}", static_cast<int>(res), code);
            try { fs::remove(dest); } catch (...) {}
            return false;
        }
        return true;
    }

    void writeUpdaterScript(const std::filesystem::path& scriptPath, const std::filesystem::path& exeDir, DWORD pid, const std::filesystem::path& zipPath, const std::filesystem::path& exePath)
    {
        std::ofstream ofs(scriptPath, std::ios::out | std::ios::trunc);
        if (!ofs) return;
        ofs << "param(\n";
        ofs << "    [string]$ExeDir,\n";
        ofs << "    [int]$ParentPid,\n";
        ofs << "    [string]$ZipPath,\n";
        ofs << "    [string]$ExePath\n";
        ofs << ")\n";
        ofs << "$ErrorActionPreference = 'Stop'\n";
        ofs << "function Write-ErrorLog($msg) {\n";
        ofs << "    $log = Join-Path (Split-Path -Parent $ZipPath) 'update_error.log'\n";
        ofs << "    Add-Content -Path $log -Value $msg -Encoding utf8\n";
        ofs << "}\n";
        ofs << "try {\n";
        ofs << "    while ($true) {\n";
        ofs << "        $proc = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue\n";
        ofs << "        if (-not $proc) { break }\n";
        ofs << "        Start-Sleep -Milliseconds 200\n";
        ofs << "    }\n";
        ofs << "    $extractDir = Join-Path (Split-Path -Parent $ZipPath) 'extracted'\n";
        ofs << "    if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }\n";
        ofs << "    New-Item -ItemType Directory -Path $extractDir | Out-Null\n";
        ofs << "    Expand-Archive -Path $ZipPath -DestinationPath $extractDir -Force\n";
        ofs << "    Get-ChildItem -Path $extractDir -Recurse | ForEach-Object {\n";
        ofs << "        $relative = $_.FullName.Substring($extractDir.Length + 1)\n";
        ofs << "        $dest = Join-Path $ExeDir $relative\n";
        ofs << "        if ($_.PSIsContainer) {\n";
        ofs << "            if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest | Out-Null }\n";
        ofs << "        } else {\n";
        ofs << "            $destDir = Split-Path -Parent $dest\n";
        ofs << "            if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir | Out-Null }\n";
        ofs << "            Copy-Item -Path $_.FullName -Destination $dest -Force\n";
        ofs << "        }\n";
        ofs << "    }\n";
        ofs << "    Start-Process -FilePath $ExePath -WorkingDirectory $ExeDir\n";
        ofs << "    $updateRoot = Split-Path -Parent (Split-Path -Parent $ZipPath)\n";
        ofs << "    Remove-Item -Recurse -Force $updateRoot\n";
        ofs << "} catch {\n";
        ofs << "    Write-ErrorLog $_.Exception.Message\n";
        ofs << "}\n";
    }

    void launchUpdaterAndExit(const std::filesystem::path& exeDir, DWORD pid, const std::filesystem::path& zipPath, const std::filesystem::path& exePath)
    {
        namespace fs = std::filesystem;
        fs::path scriptDir = zipPath.parent_path().parent_path();
        try { fs::create_directories(scriptDir); } catch (...) {}
        fs::path scriptPath = scriptDir / "apply_update.ps1";
        writeUpdaterScript(scriptPath, exeDir, pid, zipPath, exePath);

        std::string cmd = "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File \"";
        cmd += scriptPath.string();
        cmd += "\" \"";
        cmd += exeDir.string();
        cmd += "\" ";
        cmd += std::to_string(pid);
        cmd += " \"";
        cmd += zipPath.string();
        cmd += "\" \"";
        cmd += exePath.string();
        cmd += "\"";

        STARTUPINFOA si = { sizeof(si) };
        PROCESS_INFORMATION pi = {};
        if (CreateProcessA(nullptr, const_cast<char*>(cmd.c_str()), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
            spdlog::info("Updater launched, exiting current process");
        }
        else {
            spdlog::error("Failed to launch updater, error={}", GetLastError());
            return;
        }
        std::exit(0);
    }

    enum class MainWindowResult { Exit, Logout };
    enum class StartupResult { Proceed, Failed };

    StartupResult runStartupWindow()
    {
        bool startupReadyCalled = false;
        auto startup = largui::CreateWebView();
        if (!startup) {
            spdlog::error("Startup WebView backend creation failed");
            return StartupResult::Proceed;
        }

        int screenWidth = GetSystemMetrics(SM_CXSCREEN);
        int screenHeight = GetSystemMetrics(SM_CYSCREEN);
        int winW = 480;
        int winH = 320;
        int x = (screenWidth - winW) / 2;
        int y = (screenHeight - winH) / 2;

        if (!startup->Create("菈泽AI口播 - 登录", x, y, winW, winH, true)) {
            spdlog::error("Startup window creation failed");
            return StartupResult::Proceed;
        }
        startup->SetTitle("菈泽AI口播 - 登录");
        EnableWindowShadow(static_cast<HWND>(startup->GetNativeWindow()));

#ifdef _WIN32
        // 设置启动窗口任务栏/标题栏图标
        GdiplusInit startupGdiplusInit;
        SetWindowProductIcon(static_cast<HWND>(startup->GetNativeWindow()));
#endif

        startup->BindNativeCall("startDrag", [&startup](const std::string&) {
            startWindowDrag(startup.get());
            return std::string(R"({"ok":true})");
        });

        startup->BindNativeCall("getBackendBaseUrl", [](const std::string&) {
            return getBackendBaseUrlJson();
        });

        startup->BindNativeCall("checkUpdate", [](const std::string&) {
            std::string version = readExeVersion();
            std::string url = getBackendBaseUrl() + "/api/update/check?version=" + version;
            spdlog::info("Checking for updates, current version: {}", version);
            CurlResponse resp = curlGet(url, 5000);
            if (resp.code != 200) {
                spdlog::warn("Update check request failed, http={}", resp.code);
                nlohmann::json err;
                err["update_available"] = false;
                err["error"] = "request failed";
                return err.dump();
            }
            spdlog::info("Update check response: {}", resp.body);
            return resp.body;
        });

        startup->BindNativeCall("applyUpdate", [](const std::string& req) {
            try {
                nlohmann::json args = nlohmann::json::parse(req);
                std::string downloadUrl = args.value("download_url", "");
                std::string latestVersion = args.value("latest_version", "");
                if (downloadUrl.empty() || latestVersion.empty()) {
                    return std::string(R"({"status":"error","error":"missing parameters"})");
                }
                if (downloadUrl.rfind("http", 0) != 0) {
                    downloadUrl = getBackendBaseUrl() + downloadUrl;
                }
                namespace fs = std::filesystem;
                fs::path exeDir = getExecutableDirectory();
                fs::path root = findProjectRoot(exeDir);
                fs::path zipDir = root / "temp" / "update" / latestVersion;
                fs::path zipPath = zipDir / "VideoVoice.zip";
                spdlog::info("Downloading update package from: {}", downloadUrl);
                if (!downloadFile(downloadUrl, zipPath)) {
                    return std::string(R"({"status":"error","error":"download failed"})");
                }
                spdlog::info("Update package saved to: {}", zipPath.string());
                fs::path exePath = exeDir / "Voicevideo.exe";
                DWORD pid = GetCurrentProcessId();
                launchUpdaterAndExit(exeDir, pid, zipPath, exePath);
                return std::string(R"({"status":"updating"})");
            }
            catch (const std::exception& e) {
                spdlog::error("applyUpdate failed: {}", e.what());
                return std::string("{\"status\":\"error\",\"error\":\"") + e.what() + "\"}";
            }
        });

        startup->BindNativeCall("startupReady", [&startup, &startupReadyCalled](const std::string&) {
            spdlog::info("Startup ready, proceeding to main window");
            startupReadyCalled = true;
            HWND hwnd = static_cast<HWND>(startup->GetNativeWindow());
            if (hwnd) {
                PostMessage(hwnd, WM_CLOSE, 0, 0);
            }
            else {
                startup->Terminate();
            }
            return std::string(R"({"ok":true})");
        });

        startup->BindNativeCall("close", [&startup](const std::string&) {
            HWND hwnd = static_cast<HWND>(startup->GetNativeWindow());
            if (hwnd) PostMessage(hwnd, WM_CLOSE, 0, 0);
            return std::string(R"({"ok":true})");
        });

        startup->BindNativeCall("openUrl", [](const std::string& req) {
            try {
                nlohmann::json args = nlohmann::json::parse(req);
                std::string url = args.value("url", "");
                if (!url.empty()) {
                    ShellExecuteA(nullptr, "open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
                }
            }
            catch (...) {}
            return std::string(R"({"ok":true})");
        });

        startup->BindNativeCall("startupTrace", [](const std::string& req) {
            try {
                nlohmann::json args = nlohmann::json::parse(req);
                std::string msg = args.value("msg", "");
                if (!msg.empty()) {
                    spdlog::info("[StartupJS] {}", msg);
                }
            }
            catch (...) {}
            return std::string(R"({"ok":true})");
        });

        startup->Navigate(getPageUrl("StartUp.html"));
        spdlog::info("Loading startup UI");
        startup->Run();
        if (!startupReadyCalled) {
            spdlog::warn("Startup window closed before ready; exiting");
            return StartupResult::Failed;
        }
        return StartupResult::Proceed;
    }

    MainWindowResult runMainWindow()
    {
        auto w = largui::CreateWebView();
        if (!w) {
            spdlog::error("Main WebView backend creation failed");
            return MainWindowResult::Exit;
        }

        int screenWidth = GetSystemMetrics(SM_CXSCREEN);
        int screenHeight = GetSystemMetrics(SM_CYSCREEN);
        int winW = 1400;
        int winH = 972;
        int x = (screenWidth - winW) / 2;
        int y = (screenHeight - winH) / 2;

        if (!w->Create("菈泽AI口播", x, y, winW, winH, true)) {
            spdlog::error("Main window creation failed");
            return MainWindowResult::Exit;
        }
        w->SetTitle("菈泽AI口播");
        EnableWindowShadow(static_cast<HWND>(w->GetNativeWindow()));

#ifdef _WIN32
        // 初始化 GDI+ 并注册系统托盘图标
        GdiplusInit gdiplusInit;
        InitMainWindowTrayIcon(static_cast<HWND>(w->GetNativeWindow()));
#endif

        bool requestLogout = false;

        auto mainHwnd = [&]() -> HWND {
            return static_cast<HWND>(w->GetNativeWindow());
        };

        w->BindNativeCall("startDrag", [&w](const std::string&) {
            startWindowDrag(w.get());
            return std::string(R"({"ok":true})");
        });

        w->BindNativeCall("minimize", [&w](const std::string&) {
            minimizeWindow(w.get());
            return std::string(R"({"ok":true})");
        });

        w->BindNativeCall("close", [mainHwnd](const std::string&) {
            HWND hwnd = mainHwnd();
            if (hwnd) PostMessage(hwnd, WM_CLOSE, 0, 0);
            return std::string(R"({"ok":true})");
        });

        w->BindNativeCall("resizeWindow", [&w](const std::string& req) {
            try {
                nlohmann::json j = nlohmann::json::parse(req);
                int width = j.value("width", 1400);
                int height = j.value("height", 972);
                resizeWindow(w.get(), width, height);
            }
            catch (...) {}
            return std::string(R"({"ok":true})");
        });

        w->BindNativeCall("getPlatform", [](const std::string&) {
            return std::string(R"({"platform":"windows"})");
        });

        w->BindNativeCall("openUrl", [](const std::string& req) {
            try {
                nlohmann::json j = nlohmann::json::parse(req);
                std::string url = j.value("url", "");
                if (!url.empty()) {
                    ShellExecuteA(nullptr, "open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
                }
            }
            catch (...) {}
            return std::string(R"({"ok":true})");
        });

        w->BindNativeCall("pickFile", [mainHwnd](const std::string&) {
            HWND hwnd = mainHwnd();
            std::string path = pickFile(hwnd);
            nlohmann::json result;
            result["path"] = path;
            return result.dump();
        });

        w->BindNativeCall("openFileLocation", [](const std::string& req) {
            try {
                nlohmann::json j = nlohmann::json::parse(req);
                openFileLocation(j.value("path", ""));
            }
            catch (...) {}
            return std::string(R"({"ok":true})");
        });

        w->BindNativeCall("resolveMediaUrl", [](const std::string& req) {
            nlohmann::json result;
            try {
                nlohmann::json j = nlohmann::json::parse(req);
                std::string path = j.value("path", "");
                if (!path.empty()) {
                    std::filesystem::path p = stripFileUri(path);
                    if (!p.is_absolute()) {
                        try { p = std::filesystem::absolute(p); }
                        catch (...) {}
                    }
                    std::string url = p.generic_string();
                    std::replace(url.begin(), url.end(), '\\', '/');
                    if (!url.empty() && url[0] == '/') {
                        url = "file://" + url;
                    }
                    else {
                        url = "file:///" + url;
                    }
                    result["url"] = url;
                }
            }
            catch (const std::exception& e) {
                result["error"] = e.what();
            }
            return result.dump();
        });

        w->BindNativeCall("jsLog", [](const std::string& req) {
            try {
                nlohmann::json j = nlohmann::json::parse(req);
                std::string msg = j.value("msg", "");
                if (!msg.empty()) spdlog::info("[JS] {}", msg);
            }
            catch (...) {}
            return std::string(R"({"ok":true})");
        });

        w->BindNativeCall("getBackendBaseUrl", [](const std::string&) {
            return getBackendBaseUrlJson();
        });

        w->BindNativeCall("logout", [&requestLogout, mainHwnd](const std::string&) {
            requestLogout = true;
            HWND hwnd = mainHwnd();
            if (hwnd) PostMessage(hwnd, WM_CLOSE, 0, 0);
            return std::string(R"({"ok":true})");
        });

        // Core feature calls
        w->BindNativeCall("extractFromLink", [](const std::string& req) { return startExtractTask(req); });
        w->BindNativeCall("checkExtractTask", [](const std::string& req) { return checkExtractTask(req); });

        w->BindNativeCall("rewriteText", [](const std::string& req) { return startRewriteTask(req); });
        w->BindNativeCall("legalCheckText", [](const std::string& req) { return startLegalCheckTask(req); });
        w->BindNativeCall("checkRewriteTask", [](const std::string& req) { return checkRewriteTask(req); });
        w->BindNativeCall("generateVoice", [](const std::string& req) { return startVoiceTask(req); });
        w->BindNativeCall("checkVoiceTask", [](const std::string& req) { return checkVoiceTask(req); });
        w->BindNativeCall("generateVideo", [](const std::string& req) { return startGenerateVideoTask(req); });
        w->BindNativeCall("checkVideoTask", [](const std::string& req) { return checkGenerateVideoTask(req); });
        w->BindNativeCall("getAudioDuration", [](const std::string& req) { return getAudioDurationJson(req); });
        w->BindNativeCall("cutVideo", [](const std::string& req) { return startCutVideoTask(req); });
        w->BindNativeCall("checkCutTask", [](const std::string& req) { return checkCutVideoTask(req); });
        w->BindNativeCall("generateBanner", [](const std::string& req) { return startBannerTask(req, "generate"); });
        w->BindNativeCall("extractBannerFrame", [](const std::string& req) { return startBannerTask(req, "extract_frame"); });
        w->BindNativeCall("checkBannerTask", [](const std::string& req) { return checkBannerTask(req); });

        // Publish / login stubs (to be implemented)
        auto notImplemented = [](const std::string&) {
            return std::string(R"({"status":"not_implemented"})");
        };
        w->BindNativeCall("getXiaohongshuLoginStatus", notImplemented);
        w->BindNativeCall("getXiaohongshuQrcode", notImplemented);
        w->BindNativeCall("publishXiaohongshu", notImplemented);
        w->BindNativeCall("checkXiaohongshuTask", notImplemented);
        w->BindNativeCall("getXiaohongshuLoginStatusAsync", notImplemented);
        w->BindNativeCall("checkXiaohongshuLoginStatusTask", notImplemented);
        w->BindNativeCall("startXiaohongshuLogin", notImplemented);
        w->BindNativeCall("stopXiaohongshuLogin", notImplemented);
        w->BindNativeCall("getDouyinLoginStatus", notImplemented);
        w->BindNativeCall("getDouyinQrcode", notImplemented);
        w->BindNativeCall("publishDouyin", notImplemented);
        w->BindNativeCall("checkDouyinTask", notImplemented);
        w->BindNativeCall("getKuaishouLoginStatus", notImplemented);
        w->BindNativeCall("getKuaishouQrcode", notImplemented);
        w->BindNativeCall("publishKuaishou", notImplemented);
        w->BindNativeCall("checkKuaishouTask", notImplemented);

        w->Navigate(getPageUrl("LinkVideoExtract.html"));
        spdlog::info("Loading main UI");

        w->Run();
        spdlog::info("Main window closed");
        return requestLogout ? MainWindowResult::Logout : MainWindowResult::Exit;
    }

    void runAdminWindow()
    {
        auto w = largui::CreateWebView();
        if (!w) {
            spdlog::error("Admin WebView backend creation failed");
            return;
        }

        int screenWidth = GetSystemMetrics(SM_CXSCREEN);
        int screenHeight = GetSystemMetrics(SM_CYSCREEN);
        int winW = 680;
        int winH = 520;
        int x = (screenWidth - winW) / 2;
        int y = (screenHeight - winH) / 2;

        if (!w->Create("激活码管理", x, y, winW, winH, true)) {
            spdlog::error("Admin window creation failed");
            return;
        }
        w->SetTitle("激活码管理");
        EnableWindowShadow(static_cast<HWND>(w->GetNativeWindow()));

        w->BindNativeCall("startDrag", [&w](const std::string&) {
            startWindowDrag(w.get());
            return std::string(R"({"ok":true})");
        });

        w->BindNativeCall("close", [&w](const std::string&) {
            HWND hwnd = static_cast<HWND>(w->GetNativeWindow());
            if (hwnd) PostMessage(hwnd, WM_CLOSE, 0, 0);
            return std::string(R"({"ok":true})");
        });

        w->BindNativeCall("getBackendBaseUrl", [](const std::string&) {
            return getBackendBaseUrlJson();
        });

        w->BindNativeCall("copyToClipboard", [](const std::string& req) {
            nlohmann::json out;
            try {
                nlohmann::json args = nlohmann::json::parse(req);
                std::string text = args.value("text", "");
                out["ok"] = CopyTextToClipboard(text);
            }
            catch (...) {
                out["ok"] = false;
            }
            return out.dump();
        });

        w->BindNativeCall("saveCsvFile", [](const std::string& req) -> std::string {
            nlohmann::json out;
            try {
                nlohmann::json args = nlohmann::json::parse(req);
                std::string content = args.value("content", "");
                std::string defaultName = args.value("defaultName", "activation_codes.csv");
                std::string path = ShowSaveCsvDialog(defaultName);
                if (!path.empty()) {
                    std::ofstream ofs(path, std::ios::binary);
                    if (ofs) {
                        // UTF-8 BOM for Excel compatibility
                        const unsigned char bom[] = { 0xEF, 0xBB, 0xBF };
                        ofs.write(reinterpret_cast<const char*>(bom), 3);
                        ofs.write(content.c_str(), content.size());
                        ofs.close();
                        out["ok"] = true;
                        out["path"] = path;
                    }
                    else {
                        out["ok"] = false;
                        out["error"] = "无法写入文件";
                    }
                }
                else {
                    out["ok"] = false;
                    out["error"] = "用户取消";
                }
            }
            catch (const std::exception& e) {
                out["ok"] = false;
                out["error"] = e.what();
            }
            return out.dump();
        });

        w->Navigate(getPageUrl("Admin.html"));
        spdlog::info("Loading admin UI");
        w->Run();
        spdlog::info("Admin window closed");
    }

    bool isXiaohongshuServiceRunning(int port = 18060)
    {
        // 小红书 MCP 服务只暴露 /mcp 端点，通过 JSON-RPC initialize 探测
        std::string body = R"({"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"voicevideo","version":"1.0"}},"id":1})";
        std::string url = "http://localhost:" + std::to_string(port) + "/mcp";
        CurlResponse resp = curlPost(url, body, "application/json", 3000);
        return resp.code == 200;
    }

    std::filesystem::path findXiaohongshuMcpBinary(const std::filesystem::path& projectRoot)
    {
        namespace fs = std::filesystem;
        const wchar_t* name = L"xiaohongshu-mcp-windows-amd64.exe";
        fs::path localdep = projectRoot / "localdep" / "xiaohongshu-mcp" / name;
        if (fs::is_regular_file(localdep)) return localdep;
        return {};
    }

    std::filesystem::path findXiaohongshuLoginBinary(const std::filesystem::path& projectRoot)
    {
        namespace fs = std::filesystem;
        const wchar_t* name = L"xiaohongshu-login-windows-amd64.exe";
        fs::path localdep = projectRoot / "localdep" / "xiaohongshu-mcp" / name;
        if (fs::is_regular_file(localdep)) return localdep;
        return {};
    }

    std::filesystem::path getXiaohongshuCookiePath(const std::filesystem::path& binDir)
    {
        return binDir / "data" / "cookies.json";
    }

    std::filesystem::path getXiaohongshuCookiePath(const std::filesystem::path& binDir, const std::string& accountId)
    {
        if (accountId.empty()) return getXiaohongshuCookiePath(binDir);
        return binDir / "data" / ("cookies." + accountId + ".json");
    }

    std::filesystem::path findSystemBrowserExecutable()
    {
        namespace fs = std::filesystem;
        const wchar_t* candidates[] = {
            L"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
            L"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
            L"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            L"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        };
        for (const wchar_t* c : candidates) {
            if (fs::is_regular_file(c)) return c;
        }

        // 在 PATH 中继续查找 Edge / Chrome
        DWORD size = GetEnvironmentVariableW(L"PATH", nullptr, 0);
        if (size > 0) {
            std::wstring pathEnv(size - 1, L'\0');
            GetEnvironmentVariableW(L"PATH", pathEnv.data(), size);
            std::wstringstream ss(pathEnv);
            std::wstring dir;
            while (std::getline(ss, dir, L';')) {
                if (dir.empty()) continue;
                fs::path edge = fs::path(dir) / L"msedge.exe";
                if (fs::is_regular_file(edge)) return edge;
                fs::path chrome = fs::path(dir) / L"chrome.exe";
                if (fs::is_regular_file(chrome)) return chrome;
            }
        }
        return {};
    }

    bool isValidCookieFile(const std::filesystem::path& p)
    {
        namespace fs = std::filesystem;
        if (!fs::is_regular_file(p)) return false;
        try {
            return fs::file_size(p) > 10;
        }
        catch (...) {
            return false;
        }
    }

    std::filesystem::path findExistingXiaohongshuCookie(const std::filesystem::path& binDir)
    {
        namespace fs = std::filesystem;
        fs::path preferred = getXiaohongshuCookiePath(binDir);
        if (isValidCookieFile(preferred)) return preferred;

        fs::path fallback = binDir / "cookies.json";
        if (isValidCookieFile(fallback)) return fallback;

        // 登录工具旧版本可能使用系统临时目录
        wchar_t tempPath[MAX_PATH];
        DWORD tempLen = GetTempPathW(MAX_PATH, tempPath);
        if (tempLen > 0 && tempLen < MAX_PATH) {
            fs::path tmpCookie = fs::path(tempPath) / "cookies.json";
            if (isValidCookieFile(tmpCookie)) return tmpCookie;
        }
        return {};
    }

    bool hasXiaohongshuCookie(const std::filesystem::path& binDir)
    {
        return !findExistingXiaohongshuCookie(binDir).empty();
    }

    bool hasXiaohongshuCookie(const std::filesystem::path& binDir, const std::filesystem::path& cookiePath)
    {
        if (!cookiePath.empty() && isValidCookieFile(cookiePath)) return true;
        return !findExistingXiaohongshuCookie(binDir).empty();
    }

    bool runXiaohongshuLoginTool(const std::filesystem::path& loginBin, const std::filesystem::path& cookiePath, std::string& outError)
    {
        namespace fs = std::filesystem;
        fs::path binDir = loginBin.parent_path();

        // 登录工具需要界面，不能 CREATE_NO_WINDOW
        SetEnvironmentVariableA("COOKIES_PATH", cookiePath.generic_string().c_str());

        std::wstring cmdLine = L"\"" + loginBin.wstring() + L"\"";
        cmdLine += L" -cookie \"" + cookiePath.wstring() + L"\"";
        std::filesystem::path browser = findSystemBrowserExecutable();
        if (!browser.empty()) {
            cmdLine += L" -bin \"" + browser.wstring() + L"\"";
        }
        PROCESS_INFORMATION pi = {};
        STARTUPINFOW si = {};
        si.cb = sizeof(si);

        BOOL created = CreateProcessW(nullptr, cmdLine.data(), nullptr, nullptr, TRUE,
            CREATE_NEW_PROCESS_GROUP, nullptr, binDir.wstring().c_str(), &si, &pi);

        if (!created) {
            outError = std::string("启动小红书登录工具失败: ") + getLastErrorMessage();
            return false;
        }

        outError.clear();
        // 等待登录工具结束（用户扫码完成）
        DWORD waitResult = WaitForSingleObject(pi.hProcess, 10 * 60 * 1000); // 最多等 10 分钟
        if (waitResult == WAIT_TIMEOUT) {
            TerminateProcess(pi.hProcess, 1);
            outError = "小红书登录工具超时，请重新尝试";
        }

        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);

        if (!outError.empty()) return false;
        return isValidCookieFile(cookiePath);
    }

    std::shared_ptr<XiaohongshuLoginProcess> startXiaohongshuLoginToolDetached(
        const std::filesystem::path& loginBin,
        const std::filesystem::path& cookiePath, std::string& outError)
    {
        namespace fs = std::filesystem;
        fs::path binDir = loginBin.parent_path();
        fs::path dataDir = binDir / "data";
        try {
            fs::create_directories(dataDir);
        }
        catch (const std::exception& e) {
            outError = std::string("创建工作目录失败: ") + e.what();
            return nullptr;
        }

        // 设置 cookie 路径环境变量
        SetEnvironmentVariableA("COOKIES_PATH", cookiePath.generic_string().c_str());

        std::wstring cmdLine = L"\"" + loginBin.wstring() + L"\"";
        cmdLine += L" -cookie \"" + cookiePath.wstring() + L"\"";
        std::filesystem::path browser = findSystemBrowserExecutable();
        if (!browser.empty()) {
            cmdLine += L" -bin \"" + browser.wstring() + L"\"";
        }
        PROCESS_INFORMATION pi = {};
        STARTUPINFOW si = {};
        si.cb = sizeof(si);

        BOOL created = CreateProcessW(nullptr, cmdLine.data(), nullptr, nullptr, TRUE,
            CREATE_NEW_PROCESS_GROUP, nullptr, binDir.wstring().c_str(), &si, &pi);

        if (!created) {
            outError = std::string("启动小红书登录工具失败: ") + getLastErrorMessage();
            return nullptr;
        }

        auto proc = std::make_shared<XiaohongshuLoginProcess>();
        proc->hProcess = pi.hProcess;
        proc->hThread = pi.hThread;
        proc->startTime = std::chrono::steady_clock::now();
        proc->finished = false;

        spdlog::info("[xiaohongshu] login tool started, pid={}, cookiePath={}",
            static_cast<int>(pi.dwProcessId), cookiePath.generic_string());

        outError.clear();
        return proc;
    }

    bool ensureXiaohongshuService(const std::filesystem::path& projectRoot,
        int servicePort, const std::filesystem::path& cookiePath, std::string& outError)
    {
        namespace fs = std::filesystem;
        if (isXiaohongshuServiceRunning(servicePort)) return true;

        fs::path bin = findXiaohongshuMcpBinary(projectRoot);
        if (bin.empty() || !fs::is_regular_file(bin)) {
            fs::path expected = projectRoot / "localdep" / "xiaohongshu-mcp";
            fs::path setupScript = projectRoot / "tools" / "setup_xiaohongshu_mcp.ps1";
            outError = std::string("未找到小红书发布服务。\n请按以下步骤部署：\n")
                + "1. 在 PowerShell 中运行部署脚本：\n   " + setupScript.string() + "\n"
                + "   或手动从 https://github.com/xpzouying/xiaohongshu-mcp/releases/latest 下载\n"
                + "   xiaohongshu-mcp-windows-amd64.zip 并解压到：\n   " + expected.string() + "\n"
                + "2. 重启本程序后再试。";
            return false;
        }

        fs::path binDir = bin.parent_path();
        fs::path dataDir = binDir / "data";
        try {
            fs::create_directories(dataDir);
        }
        catch (const std::exception& e) {
            outError = std::string("创建工作目录失败: ") + e.what();
            return false;
        }

        fs::path effectiveCookiePath = cookiePath.empty() ? getXiaohongshuCookiePath(binDir) : cookiePath;

        // 如果没有 cookie，先尝试运行登录工具（阻塞等待用户扫码）
        if (!isValidCookieFile(effectiveCookiePath)) {
            fs::path loginBin = findXiaohongshuLoginBinary(projectRoot);
            if (loginBin.empty() || !fs::is_regular_file(loginBin)) {
                outError = "未找到小红书登录工具 xiaohongshu-login-windows-amd64.exe，请重新部署完整 zip 包。";
                return false;
            }
            std::string loginError;
            if (!runXiaohongshuLoginTool(loginBin, effectiveCookiePath, loginError)) {
                outError = loginError.empty() ? "小红书登录未完成或失败" : loginError;
                return false;
            }
        }

        fs::path logFile = dataDir / ("service." + std::to_string(servicePort) + ".log");

        SetEnvironmentVariableA("COOKIES_PATH", effectiveCookiePath.generic_string().c_str());

        SECURITY_ATTRIBUTES sa = {};
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = TRUE;
        sa.lpSecurityDescriptor = nullptr;

        HANDLE hLog = CreateFileW(logFile.wstring().c_str(), GENERIC_WRITE, FILE_SHARE_READ, &sa,
            CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);

        STARTUPINFOW si = {};
        si.cb = sizeof(si);
        if (hLog != INVALID_HANDLE_VALUE) {
            si.dwFlags = STARTF_USESTDHANDLES;
            si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            si.hStdOutput = hLog;
            si.hStdError = hLog;
        }

        std::wstring cmdLine = L"\"" + bin.wstring() + L"\" -port :" + std::to_wstring(servicePort);
        PROCESS_INFORMATION pi = {};
        BOOL created = CreateProcessW(nullptr, cmdLine.data(), nullptr, nullptr, TRUE,
            CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP, nullptr, binDir.wstring().c_str(), &si, &pi);

        if (hLog != INVALID_HANDLE_VALUE) CloseHandle(hLog);

        if (!created) {
            outError = std::string("启动小红书服务失败: ") + getLastErrorMessage();
            return false;
        }

        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);

        for (int i = 0; i < 120; ++i) {
            if (isXiaohongshuServiceRunning(servicePort)) return true;
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
        }

        outError = "小红书服务启动超时，请检查 localdep/xiaohongshu-mcp/data/service.log";
        return false;
    }

    // 旧签名兼容：默认端口 18060、默认 cookie 文件
    bool ensureXiaohongshuService(const std::filesystem::path& projectRoot, std::string& outError)
    {
        namespace fs = std::filesystem;
        fs::path bin = findXiaohongshuMcpBinary(projectRoot);
        fs::path cookiePath = bin.empty() ? fs::path() : getXiaohongshuCookiePath(bin.parent_path());
        return ensureXiaohongshuService(projectRoot, 18060, cookiePath, outError);
    }

    std::filesystem::path findNodeExecutable()
    {
        namespace fs = std::filesystem;
        const wchar_t* name = L"node.exe";
        std::vector<fs::path> candidates = {
            L"C:\\Program Files\\nodejs\\node.exe",
            L"C:\\Program Files (x86)\\nodejs\\node.exe",
        };
        DWORD size = GetEnvironmentVariableW(L"PATH", nullptr, 0);
        if (size > 0) {
            std::wstring pathEnv(size - 1, L'\0');
            GetEnvironmentVariableW(L"PATH", pathEnv.data(), size);
            std::wstringstream ss(pathEnv);
            std::wstring dir;
            while (std::getline(ss, dir, L';')) {
                if (dir.empty()) continue;
                fs::path p = fs::path(dir) / name;
                if (fs::is_regular_file(p)) return p;
            }
        }
        for (const auto& c : candidates) {
            if (fs::is_regular_file(c)) return c;
        }
        return name;
    }

    bool isDouyinServiceRunning()
    {
        CurlResponse resp = curlGet("http://localhost:18062/health", 3000);
        return resp.code == 200;
    }

    std::filesystem::path findDouyinMcpEntry(const std::filesystem::path& projectRoot)
    {
        namespace fs = std::filesystem;
        fs::path localdep = projectRoot / "localdep" / "douyin-mcp" / "server-playwright.js";
        if (fs::is_regular_file(localdep)) return localdep;
        fs::path github = projectRoot / "github" / "douyin-mcp" / "server-playwright.js";
        if (fs::is_regular_file(github)) return github;
        return {};
    }

    bool ensureDouyinService(const std::filesystem::path& projectRoot, std::string& outError)
    {
        namespace fs = std::filesystem;
        if (isDouyinServiceRunning()) return true;

        fs::path entry = findDouyinMcpEntry(projectRoot);
        if (entry.empty() || !fs::is_regular_file(entry)) {
            outError = "未找到抖音发布服务，请先运行 tools/setup_douyin_mcp.ps1 部署 localdep/douyin-mcp/";
            return false;
        }

        fs::path entryDir = entry.parent_path();
        fs::path dataDir = entryDir / "data";
        try {
            fs::create_directories(dataDir);
        }
        catch (const std::exception& e) {
            outError = std::string("创建工作目录失败: ") + e.what();
            return false;
        }

        fs::path cookiePath = dataDir / "cookies.json";
        fs::path logFile = dataDir / "service.log";

        SetEnvironmentVariableA("COOKIES_PATH", cookiePath.generic_string().c_str());

        SECURITY_ATTRIBUTES sa = {};
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = TRUE;
        sa.lpSecurityDescriptor = nullptr;

        HANDLE hLog = CreateFileW(logFile.wstring().c_str(), GENERIC_WRITE, FILE_SHARE_READ, &sa,
            CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);

        STARTUPINFOW si = {};
        si.cb = sizeof(si);
        if (hLog != INVALID_HANDLE_VALUE) {
            si.dwFlags = STARTF_USESTDHANDLES;
            si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            si.hStdOutput = hLog;
            si.hStdError = hLog;
        }

        fs::path nodeExe = findNodeExecutable();
        std::wstring cmdLine = L"\"" + nodeExe.wstring() + L"\" \"" + entry.wstring() + L"\"";

        PROCESS_INFORMATION pi = {};
        BOOL created = CreateProcessW(nullptr, cmdLine.data(), nullptr, nullptr, TRUE,
            CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP, nullptr, entryDir.wstring().c_str(), &si, &pi);

        if (hLog != INVALID_HANDLE_VALUE) CloseHandle(hLog);

        if (!created) {
            outError = std::string("启动抖音服务失败: ") + getLastErrorMessage();
            return false;
        }

        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);

        for (int i = 0; i < 120; ++i) {
            if (isDouyinServiceRunning()) return true;
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
        }

        outError = "抖音服务启动超时，请检查 localdep/douyin-mcp/data/service.log";
        return false;
    }

    // ---------- 快手服务 ----------
    bool isKuaishouServiceRunning()
    {
        CurlResponse resp = curlGet("http://localhost:18063/health", 3000);
        return resp.code == 200;
    }

    std::filesystem::path findKuaishouMcpEntry(const std::filesystem::path& projectRoot)
    {
        namespace fs = std::filesystem;
        fs::path localdep = projectRoot / "localdep" / "social-auto-upload" / "kuaishou_mcp_service.py";
        if (fs::is_regular_file(localdep)) return localdep;
        fs::path github = projectRoot / "github" / "social-auto-upload" / "kuaishou_mcp_service.py";
        if (fs::is_regular_file(github)) return github;
        return {};
    }

    std::filesystem::path findKuaishouPythonExe(const std::filesystem::path& entry)
    {
        namespace fs = std::filesystem;
        // 优先使用服务自己的 venv
        fs::path venv = entry.parent_path() / ".venv" / "Scripts" / "python.exe";
        if (fs::is_regular_file(venv)) return venv;
        // 回退到项目 localdep/python
        fs::path projectRoot = entry.parent_path().parent_path().parent_path();
        fs::path localdepPython = projectRoot / "localdep" / "python" / "python.exe";
        if (fs::is_regular_file(localdepPython)) return localdepPython;
        return {};
    }

    bool ensureKuaishouService(const std::filesystem::path& projectRoot, std::string& outError)
    {
        namespace fs = std::filesystem;
        if (isKuaishouServiceRunning()) return true;

        fs::path entry = findKuaishouMcpEntry(projectRoot);
        if (entry.empty() || !fs::is_regular_file(entry)) {
            outError = "未找到快手发布服务，请先运行 tools/setup_kuaishou_mcp.ps1 部署 localdep/social-auto-upload/";
            return false;
        }

        fs::path entryDir = entry.parent_path();
        fs::path dataDir = entryDir / "data";
        try {
            fs::create_directories(dataDir);
        }
        catch (const std::exception& e) {
            outError = std::string("创建工作目录失败: ") + e.what();
            return false;
        }

        fs::path logFile = dataDir / "service.log";

        SECURITY_ATTRIBUTES sa = {};
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = TRUE;
        sa.lpSecurityDescriptor = nullptr;

        HANDLE hLog = CreateFileW(logFile.wstring().c_str(), GENERIC_WRITE, FILE_SHARE_READ, &sa,
            CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);

        STARTUPINFOW si = {};
        si.cb = sizeof(si);
        if (hLog != INVALID_HANDLE_VALUE) {
            si.dwFlags = STARTF_USESTDHANDLES;
            si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            si.hStdOutput = hLog;
            si.hStdError = hLog;
        }

        fs::path pythonExe = findKuaishouPythonExe(entry);
        if (pythonExe.empty()) {
            if (hLog != INVALID_HANDLE_VALUE) CloseHandle(hLog);
            outError = "未找到 Python 解释器，请确认服务已部署";
            return false;
        }

        std::wstring cmdLine = L"\"" + pythonExe.wstring() + L"\" \"" + entry.wstring() + L"\"";

        PROCESS_INFORMATION pi = {};
        BOOL created = CreateProcessW(nullptr, cmdLine.data(), nullptr, nullptr, TRUE,
            CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP, nullptr, entryDir.wstring().c_str(), &si, &pi);

        if (hLog != INVALID_HANDLE_VALUE) CloseHandle(hLog);

        if (!created) {
            outError = std::string("启动快手服务失败: ") + getLastErrorMessage();
            return false;
        }

        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);

        for (int i = 0; i < 120; ++i) {
            if (isKuaishouServiceRunning()) return true;
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
        }

        outError = "快手服务启动超时，请检查 localdep/social-auto-upload/data/service.log";
        return false;
    }

#endif

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

    spdlog::info("===== TEST NEW BUILD =====");
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

#ifdef _WIN32
    // 程序启动时自动在桌面创建快捷方式（使用 exe 内置图标）
    CreateDesktopShortcutIfNeeded();
#endif

    if (HasCommandLineFlag(L"--admin")) {
        spdlog::info("Running in admin mode");
        runAdminWindow();
        curl_global_cleanup();
        spdlog::info("Voicevideo admin mode exited");
        return 0;
    }

    while (true) {
        if (runStartupWindow() != StartupResult::Proceed) {
            spdlog::info("Exiting because startup gate did not complete");
            break;
        }

        auto mainResult = runMainWindow();
        if (mainResult == MainWindowResult::Exit) {
            break;
        }
        spdlog::info("Returning to startup gate after logout");
    }

    curl_global_cleanup();
    spdlog::info("Voicevideo exited");
    return 0;
}
