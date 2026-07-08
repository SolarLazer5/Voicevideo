#include "ILarWebView.h"

#ifdef _WIN32
#include "CLarWebview.h"
#else
#include "LarWebViewMacOS.h"
#endif

namespace largui {

std::unique_ptr<ILarWebView> CreateWebView()
{
#ifdef _WIN32
    static bool s_registered = false;
    if (!s_registered)
    {
        CLarWebview::Reg(GetModuleHandleW(nullptr));
        s_registered = true;
    }
    return std::make_unique<CLarWebview>();
#else
    return std::make_unique<LarWebViewMacOS>();
#endif
}

} // namespace largui
