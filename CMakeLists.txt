cmake_minimum_required(VERSION 3.16)

# 如果支持，请为 MSVC 编译器启用热重载。
if (POLICY CMP0141)
  cmake_policy(SET CMP0141 NEW)
  set(CMAKE_MSVC_DEBUG_INFORMATION_FORMAT "$<IF:$<AND:$<C_COMPILER_ID:MSVC>,$<CXX_COMPILER_ID:MSVC>>,$<$<CONFIG:Debug,RelWithDebInfo>:EditAndContinue>,$<$<CONFIG:Debug,RelWithDebInfo>:ProgramDatabase>>")
endif()

# 让 vcpkg 安装目录固定到源码根目录的 vcpkg_installed，避免每个 build 目录都复制一份。
# 在 CMakePresets.json 中也设置了同名变量；这里作为命令行直接配置时的兜底。
if (NOT DEFINED VCPKG_INSTALLED_DIR)
    set(VCPKG_INSTALLED_DIR "${CMAKE_CURRENT_SOURCE_DIR}/vcpkg_installed" CACHE PATH "vcpkg installed directory")
endif()

project("Voicevideo")

# 强制把所有配置的可执行文件输出到源码主目录的 build/，
# 这样无论是命令行 Ninja 还是 Visual Studio CMake 都会生成到同一位置。
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/build")
foreach(_CFG IN ITEMS Debug Release RelWithDebInfo MinSizeRel)
    set(CMAKE_RUNTIME_OUTPUT_DIRECTORY_${_CFG} "${CMAKE_CURRENT_SOURCE_DIR}/build")
endforeach()

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

    # 生成图标资源文件（使用产品 Logo）
    set(VOICEVIDEO_LOGO_ICO "${CMAKE_CURRENT_SOURCE_DIR}/assets/logo/LAZERAGENT_256.ico")
    configure_file(
        "${CMAKE_CURRENT_SOURCE_DIR}/src/Voicevideo.rc.in"
        "${CMAKE_CURRENT_BINARY_DIR}/Voicevideo.rc"
        @ONLY
    )
    list(APPEND VOICEVIDEO_SOURCES "${CMAKE_CURRENT_BINARY_DIR}/Voicevideo.rc")
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

# 每次构建前先清理旧的 exe 和 assets，避免 Visual Studio 调试时运行到旧版本。
# POST_BUILD 会重新复制最新的 assets/tools。
add_custom_command(
    TARGET Voicevideo PRE_BUILD
    COMMAND ${CMAKE_COMMAND} -E remove "$<TARGET_FILE:Voicevideo>"
    COMMAND ${CMAKE_COMMAND} -E remove_directory "$<TARGET_FILE_DIR:Voicevideo>/assets"
    COMMAND ${CMAKE_COMMAND} -E remove_directory "$<TARGET_FILE_DIR:Voicevideo>/tools"
    COMMENT "Cleaning old executable and assets before build"
)

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
        dwmapi
        gdiplus
        comctl32
    )
endif()

# 构建期确保改写模型已下载（优先使用 localdep/python，其次 .venv）
set(VOICEVIDEO_PYTHON "${CMAKE_CURRENT_SOURCE_DIR}/localdep/python/python.exe")
if(NOT EXISTS "${VOICEVIDEO_PYTHON}")
    set(VOICEVIDEO_PYTHON "${CMAKE_CURRENT_SOURCE_DIR}/.venv/Scripts/python.exe")
endif()
if(NOT EXISTS "${VOICEVIDEO_PYTHON}")
    set(VOICEVIDEO_PYTHON "python")
endif()

add_custom_command(
    TARGET Voicevideo POST_BUILD
    COMMAND "${VOICEVIDEO_PYTHON}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ensure_rewrite_model.py"
    COMMENT "Ensuring rewrite model is present"
)

add_custom_command(
    TARGET Voicevideo POST_BUILD
    COMMAND "${VOICEVIDEO_PYTHON}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ensure_tts_model.py"
    COMMENT "Ensuring TTS models are present"
)

add_custom_command(
    TARGET Voicevideo POST_BUILD
    COMMAND "${VOICEVIDEO_PYTHON}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ensure_video_model.py"
    COMMENT "Ensuring SadTalker video models are present"
)

add_custom_command(
    TARGET Voicevideo POST_BUILD
    COMMAND "${VOICEVIDEO_PYTHON}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/ensure_dashscope_deps.py"
    COMMENT "Ensuring DashScope cloud dependencies are present"
)

# 复制前端资源到输出目录：先删除旧 assets 再复制，保证前端改动每次构建都生效
set(ASSETS_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/assets")
set(ASSETS_OUTPUT_DIR "$<TARGET_FILE_DIR:Voicevideo>/assets")

add_custom_command(
    TARGET Voicevideo POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E remove_directory "${ASSETS_OUTPUT_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${ASSETS_SOURCE_DIR}"
            "${ASSETS_OUTPUT_DIR}"
    COMMENT "Copying assets to output directory"
)

# 复制 Python 提取脚本到输出目录
set(TOOLS_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/tools")
set(TOOLS_OUTPUT_DIR "$<TARGET_FILE_DIR:Voicevideo>/tools")

add_custom_command(
    TARGET Voicevideo POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E remove_directory "${TOOLS_OUTPUT_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${TOOLS_SOURCE_DIR}"
            "${TOOLS_OUTPUT_DIR}"
    COMMENT "Copying tools to output directory"
)

# 注意：localdep 不再在构建时同步到输出目录。
# 开发阶段 exe 直接使用源码主目录下的 localdep；
# 发布前请手动将 localdep 复制到 exe 同级目录。
