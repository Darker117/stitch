# Native on-device runtimes of the StitchDevice plugin (built by Gradle's externalNativeBuild):
#   libstitch_llama.so  llama.cpp: GGUF chat models (device/text/GgufEngine.kt)
#   libstitch_sd.so     stable-diffusion.cpp: .safetensors / .ckpt / .gguf image checkpoints (device/image/SdCppEngine.kt)
# Both share one ggml with dynamically loaded backends: libggml-cpu-android_*.so (one per ARM feature level; the best
# one for the phone is picked at run time) and libggml-vulkan.so (GPU, when the build machine could stage it).
# Sources live in android/.native (scripts/native.mjs); Gradle passes their paths from android/.native/build.json.
cmake_minimum_required(VERSION 3.22)

# ggml is unusably slow unoptimised, so native code is always a Release build (debug APKs included).
set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)

project(stitch_native C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(STITCH_LLAMA_DIR "" CACHE PATH "llama.cpp sources (android/.native/src/llama.cpp)")
set(STITCH_SDCPP_DIR "" CACHE PATH "stable-diffusion.cpp sources (android/.native/src/stable-diffusion.cpp)")
option(STITCH_VULKAN "Build ggml's Vulkan backend" OFF)
set(STITCH_SPIRV_HEADERS "" CACHE PATH "SPIRV-Headers include dir (Vulkan backend)")

if (NOT EXISTS "${STITCH_LLAMA_DIR}/CMakeLists.txt" OR NOT EXISTS "${STITCH_SDCPP_DIR}/include/stable-diffusion.h")
    message(FATAL_ERROR "The native runtimes aren't staged: run `node scripts/native.mjs` in mobile/ (npm run apk does it).")
endif()

# stable-diffusion.cpp needs longer tensor names than ggml's default 64 bytes. ggml_tensor's layout must be identical
# in every library that shares it, so the whole build uses 160.
add_compile_definitions(GGML_MAX_NAME=160)

# --- ggml + llama.cpp ------------------------------------------------------------------------------------------------
set(BUILD_SHARED_LIBS      ON  CACHE BOOL "" FORCE)
set(GGML_BACKEND_DL        ON  CACHE BOOL "" FORCE)
set(GGML_CPU_ALL_VARIANTS  ON  CACHE BOOL "" FORCE)
set(GGML_NATIVE            OFF CACHE BOOL "" FORCE)
# OpenMP (the NDK's libomp.so, which AGP packages): on the Pixel 8a it matched ggml's own thread pool for llama.cpp and
# made stable-diffusion.cpp up to 1.8x faster (fp16 SD 1.5 at 384 px: 11.5 vs 18-21 s per step).
set(GGML_OPENMP            ON  CACHE BOOL "" FORCE)
set(GGML_LLAMAFILE         OFF CACHE BOOL "" FORCE)
set(GGML_CPU_KLEIDIAI      ON  CACHE BOOL "" FORCE)
set(GGML_CCACHE            OFF CACHE BOOL "" FORCE)
set(GGML_VULKAN            ${STITCH_VULKAN} CACHE BOOL "" FORCE)
if (STITCH_VULKAN)
    include_directories(${STITCH_SPIRV_HEADERS})
    # ggml-vulkan calls Vulkan 1.1 entry points that libvulkan.so exports from API 28 on; link that stub. The backend is
    # only loaded when a model asks for the GPU, so older Androids simply don't get the GPU path.
    set(Vulkan_LIBRARY "${CMAKE_SYSROOT}/usr/lib/${CMAKE_LIBRARY_ARCHITECTURE}/28/libvulkan.so" CACHE FILEPATH "" FORCE)
endif()
set(LLAMA_BUILD_COMMON     ON  CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS      OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS      OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES   OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER     OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_APP        OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_UI         OFF CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL          OFF CACHE BOOL "" FORCE)
set(LLAMA_SUBPROCESS       OFF CACHE BOOL "" FORCE)
add_subdirectory(${STITCH_LLAMA_DIR} llama.cpp)

# --- stable-diffusion.cpp (static, against llama.cpp's ggml) --------------------------------------------------------
set(SD ${STITCH_SDCPP_DIR})
set(SD_WEBP OFF CACHE BOOL "" FORCE)
set(SD_WEBM OFF CACHE BOOL "" FORCE)
add_subdirectory(${SD}/thirdparty sd-thirdparty)   # zip, oniguruma, utf8proc (object libraries)

file(GLOB SD_SOURCES CONFIGURE_DEPENDS
    ${SD}/src/*.cpp
    ${SD}/src/conditioning/*.cpp
    ${SD}/src/core/*.cpp
    ${SD}/src/extensions/*.cpp
    ${SD}/src/model/*/*.cpp
    ${SD}/src/pipeline/*.cpp
    ${SD}/src/runtime/*.cpp
    ${SD}/src/model_io/*.cpp
    ${SD}/src/tokenizers/*.cpp)
add_library(stable-diffusion STATIC ${SD_SOURCES} sd_vocab.cpp $<TARGET_OBJECTS:zip>)
set_target_properties(stable-diffusion PROPERTIES POSITION_INDEPENDENT_CODE ON)
# Upstream ggml mode: sd.cpp's own ggml fork adds INT8 "convrot" and native FP8 kernels, which phone models don't use.
target_compile_definitions(stable-diffusion PUBLIC SD_USE_UPSTREAM_GGML)
set_property(SOURCE ${SD}/src/version.cpp APPEND PROPERTY COMPILE_DEFINITIONS SDCPP_BUILD_COMMIT=stitch SDCPP_BUILD_VERSION=stitch)
target_include_directories(stable-diffusion
    PUBLIC ${SD} ${SD}/src ${SD}/include ${SD}/thirdparty
    PRIVATE ${SD}/src/core ${SD}/src/tokenizers/vocab ${STITCH_LLAMA_DIR}/ggml/src)
target_link_libraries(stable-diffusion PUBLIC ggml ggml-base PRIVATE onig sd-utf8proc)

# --- JNI libraries ----------------------------------------------------------------------------------------------------
find_library(log-lib log)

add_library(stitch_llama SHARED llama_jni.cpp stitch_backends.cpp)
target_include_directories(stitch_llama PRIVATE ${STITCH_LLAMA_DIR}/common ${STITCH_LLAMA_DIR}/include ${STITCH_LLAMA_DIR}/ggml/include)
target_link_libraries(stitch_llama PRIVATE llama llama-common ggml ggml-base ${log-lib})
set_target_properties(stitch_llama PROPERTIES CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON)

add_library(stitch_sd SHARED sd_jni.cpp stitch_backends.cpp)
target_include_directories(stitch_sd PRIVATE ${STITCH_LLAMA_DIR}/ggml/include)
target_link_libraries(stitch_sd PRIVATE stable-diffusion ggml ggml-base ${log-lib})
set_target_properties(stitch_sd PROPERTIES CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON)
