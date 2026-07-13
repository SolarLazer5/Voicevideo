# 增量同步 localdep 到生成目录，避免每次构建都复制整个 2GB+ 目录。
# 用法：cmake -P tools/sync_localdep.cmake <src> <dst>
#
# 同步策略：
# 1. 如果目标目录的 .stamp 文件存在，且其修改时间不早于源目录的 .stamp 文件，则跳过。
# 2. 否则使用 copy_directory_if_different 进行增量复制（只复制有变化的文件）。
# 3. 同步完成后在目标目录生成/更新 .stamp。

set(src "${CMAKE_ARGV3}")
set(dst "${CMAKE_ARGV4}")

if (NOT src OR NOT dst)
    message(FATAL_ERROR "Usage: cmake -P sync_localdep.cmake <src> <dst>")
endif()

set(srcStamp "${src}/.stamp")
set(dstStamp "${dst}/.stamp")

# 源目录不存在就不处理（允许用户不打包 localdep 进行开发）
if (NOT EXISTS "${src}")
    message(STATUS "localdep source does not exist, skipping")
    return()
endif()

set(needsSync TRUE)

if (EXISTS "${dstStamp}" AND EXISTS "${srcStamp}")
    file(TIMESTAMP "${dstStamp}" dstTime "%s")
    file(TIMESTAMP "${srcStamp}" srcTime "%s")
    if (dstTime AND srcTime AND dstTime GREATER_EQUAL srcTime)
        set(needsSync FALSE)
    endif()
endif()

if (NOT needsSync)
    message(STATUS "localdep is up-to-date, skipping copy")
    return()
endif()

message(STATUS "Syncing localdep to output directory...")
file(MAKE_DIRECTORY "${dst}")
execute_process(
    COMMAND "${CMAKE_COMMAND}" -E copy_directory_if_different "${src}" "${dst}"
    RESULT_VARIABLE syncResult
)

if (NOT syncResult EQUAL 0)
    message(FATAL_ERROR "Failed to sync localdep to ${dst}")
endif()

file(TOUCH "${dstStamp}")
message(STATUS "localdep sync finished")
