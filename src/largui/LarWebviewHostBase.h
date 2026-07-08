#pragma once

#include "CLarWebview.h"
#include <mutex>
#include <string>
#include <vector>

// LarWebviewHostBase - WebView2 宿主基类
//
// 职责：
//   1. 维护 WebView2 前端就绪状态与待执行 JS 脚本队列。
//   2. 提供线程安全的 ExecuteVoidScript()：未就绪时入队，就绪后立即执行。
//   3. 提供 FlushPendingScripts()：前端 ready 时一次性刷出队列。
//
// 设计原因：
//   Dashboard 中多个 Lar*Webview 都重复实现了同样的 m_webViewReady / m_pendingScripts /
//   m_pendingMutex / ExecuteVoidScript / FlushPendingScripts 逻辑。提取到基类后，
//   各子类只需关注业务相关的 JS 接口与 WebMessage 分发。
class LarWebviewHostBase : public largui::CLarWebview
{
protected:
    explicit LarWebviewHostBase(const char* logTag);
    ~LarWebviewHostBase();

    // 执行无需回调的 JS 脚本。若前端尚未就绪，则排队等待 ready 后自动刷出。
    void ExecuteVoidScript(const std::wstring& script);

    // 前端就绪时调用：把之前排队的脚本全部执行，并标记为就绪。
    void FlushPendingScripts();

    // 重置就绪状态并清空队列。通常在页面导航后使用。
    void ResetScriptQueue();

    // 手动标记队列为就绪（一般不需要，FlushPendingScripts 已包含此操作）。
    void SetScriptQueueReady();

    // 查询队列是否已处于就绪状态。
    bool IsScriptQueueReady() const { return m_webViewReady != FALSE; }

    const char* GetLogTag() const { return m_logTag.c_str(); }

private:
    std::string m_logTag;
    BOOL m_webViewReady = FALSE;
    std::vector<std::wstring> m_pendingScripts;
    std::mutex m_pendingMutex;
};
