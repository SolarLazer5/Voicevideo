#include "LarWebviewHostBase.h"
#include <spdlog/spdlog.h>

LarWebviewHostBase::LarWebviewHostBase(const char* logTag)
    : m_logTag(logTag ? logTag : "LarWebviewHostBase")
{
}

LarWebviewHostBase::~LarWebviewHostBase()
{
}

void LarWebviewHostBase::ExecuteVoidScript(const std::wstring& script)
{
    {
        std::lock_guard<std::mutex> lock(m_pendingMutex);
        if (!m_webViewReady)
        {
            m_pendingScripts.push_back(script);
            return;
        }
    }

    if (!IsInitialized())
        return;

    ExecuteScriptW(script, [this](HRESULT hr, const std::wstring& result) {
        if (FAILED(hr))
        {
            spdlog::warn("[{}] ExecuteScript failed, hr={:08x}", m_logTag, hr);
        }
    });
}

void LarWebviewHostBase::FlushPendingScripts()
{
    std::vector<std::wstring> scripts;
    {
        std::lock_guard<std::mutex> lock(m_pendingMutex);
        m_webViewReady = TRUE;
        scripts = std::move(m_pendingScripts);
    }
    for (const auto& script : scripts)
        ExecuteVoidScript(script);
}

void LarWebviewHostBase::ResetScriptQueue()
{
    std::lock_guard<std::mutex> lock(m_pendingMutex);
    m_webViewReady = FALSE;
    m_pendingScripts.clear();
}

void LarWebviewHostBase::SetScriptQueueReady()
{
    std::lock_guard<std::mutex> lock(m_pendingMutex);
    m_webViewReady = TRUE;
}
