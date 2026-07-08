#include "LarWebViewMacOS.h"
#include <spdlog/spdlog.h>

namespace largui {

bool LarWebViewMacOS::Create(const std::string& title, int x, int y,
                             int width, int height, bool frameless)
{
    spdlog::warn("[LarWebViewMacOS] macOS WebView 后端尚未实现");
    return false;
}

void LarWebViewMacOS::ExecuteScript(const std::string& script, ScriptCallback cb)
{
    if (cb) cb(false, "");
}

} // namespace largui
