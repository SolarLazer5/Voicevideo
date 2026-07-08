cmake_minimum_required(VERSION 3.16)

# 如果支持，请为 MSVC 编译器启用热重载。
if (POLICY CMP0141)
  cmake_policy(SET CMP0141 NEW)
  set(CMAKE_MSVC_DEBUG_INFORMATION_FORMAT "$<IF:$<AND:$<C_COMPILER_ID:MSVC>,$<CXX_COMPILER_ID:MSVC>>,$<$<CONFIG:Debug,RelWithDebInfo>:EditAndContinue>,$<$<CONFIG:Debug,RelWithDebInfo>:ProgramDatabase>>")
endif()

project("Voicevideo")

# vcpkg 依赖包
find_package(CURL REQUIRED)
find_package(fmt CONFIG REQUIRED)
find_package(unofficial-sodium CONFIG REQUIRED)
find_package(minizip CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)
find_package(ZLIB REQUIRED)
find_package(spdlog CONFIG REQUIRED)
if (WIN32)
    find_package(unofficial-webview2 CONFIG REQUIRED)
endif()

# 源代码
set(VOICEVIDEO_SOURCES
    "src/Voicevideo.cpp"
    "src/Voicevideo.h"
)

# LarGui 跨平台 WebView 封装
set(LARGUI_SOURCES
    "src/largui/ILarWebView.h"
    "src/largui/LarWebViewFactory.cpp"
    "src/largui/LarWebviewHostBase.cpp"
    "src/largui/LarWebviewHostBase.h"
)

if (WIN32)
    list(APPEND LARGUI_SOURCES
        "src/largui/CLarWebview.cpp"
        "src/largui/CLarWebview.h"
    )
    list(APPEND VOICEVIDEO_SOURCES "src/Voicevideo.exe.manifest")
else()
    list(APPEND LARGUI_SOURCES
        "src/largui/LarWebViewMacOS.cpp"
        "src/largui/LarWebViewMacOS.h"
    )
endif()

add_executable(Voicevideo ${VOICEVIDEO_SOURCES} ${LARGUI_SOURCES})

if (CMAKE_VERSION VERSION_GREATER 3.12)
  set_property(TARGET Voicevideo PROPERTY CXX_STANDARD 20)
endif()

if (WIN32)
    set_target_properties(Voicevideo PROPERTIES LINK_FLAGS "/SUBSYSTEM:WINDOWS /ENTRY:mainCRTStartup")
endif()

# 链接 vcpkg 库与 LarGui 所需系统库
target_link_libraries(Voicevideo PRIVATE
    CURL::libcurl
    fmt::fmt
    unofficial-sodium::sodium
    $<IF:$<TARGET_EXISTS:MINIZIP::minizip>,MINIZIP::minizip,MINIZIP::minizipstatic>
    nlohmann_json::nlohmann_json
    ZLIB::ZLIB
    spdlog::spdlog
)

if (WIN32)
    target_link_libraries(Voicevideo PRIVATE
        unofficial::webview2::webview2
        advapi32
        ole32
        shell32
        shlwapi
        user32
        version
        gdi32
        comdlg32
        uuid
    )
endif()

# 复制前端资源到输出目录
set(ASSETS_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/assets")
set(ASSETS_OUTPUT_DIR "$<TARGET_FILE_DIR:Voicevideo>/assets")

add_custom_command(
    TARGET Voicevideo POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${ASSETS_SOURCE_DIR}"
            "${ASSETS_OUTPUT_DIR}"
    COMMENT "Copying assets to output directory"
)
