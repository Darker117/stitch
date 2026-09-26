// A `glslc` stand-in for building llama.cpp's Vulkan shaders with Khronos' glslang release binary.
// ggml's vulkan-shaders-gen (and its CMake feature tests) call shaderc's glslc; the Android NDK's glslc is too old for
// ggml's shaders and shaderc publishes no binaries, while glslang does. This translates glslc's options:
//   -fshader-stage=compute → -S comp        --target-env=vulkanX → --target-env vulkanX (implies -V)
//   -MD -MF <f> → --depfile <f>      -o - → stdout      -O / -D… / -g / input → as is
// and enables GL_GOOGLE_include_directive the way glslc does (as a preamble).
// glslang prints diagnostics on stdout; they are forwarded to stderr when compilation fails (glslc's behaviour, and
// what vulkan-shaders-gen and CMake look at). The glslang binary is found next to this executable (or $GLSLANG).
// Built by scripts/native.mjs with the build machine's C++ compiler.
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <string>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#else
#include <sys/wait.h>
#include <unistd.h>
#include <climits>
#endif

static std::string self_dir(const char* argv0) {
#ifdef _WIN32
    char buf[MAX_PATH];
    DWORD n = GetModuleFileNameA(nullptr, buf, MAX_PATH);
    std::string p(buf, n);
#else
    char buf[PATH_MAX];
    ssize_t n = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
    std::string p = n > 0 ? std::string(buf, (size_t)n) : std::string(argv0);
#endif
    size_t cut = p.find_last_of("/\\");
    return cut == std::string::npos ? std::string(".") : p.substr(0, cut);
}

#ifdef _WIN32
static std::string quote(const std::string& a) {
    if (!a.empty() && a.find_first_of(" \t\"") == std::string::npos) return a;
    std::string out = "\"";
    size_t slashes = 0;
    for (char c : a) {
        if (c == '\\') { slashes++; continue; }
        if (c == '"') out.append(slashes * 2 + 1, '\\');
        else out.append(slashes, '\\');
        slashes = 0;
        out += c;
    }
    out.append(slashes * 2, '\\');
    return out + "\"";
}

// Runs the command, returning its exit code and combined stdout.
static int run(const std::vector<std::string>& args, std::string& output) {
    std::string cmd;
    for (const auto& a : args) cmd += (cmd.empty() ? "" : " ") + quote(a);
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
    HANDLE rd = nullptr, wr = nullptr;
    if (!CreatePipe(&rd, &wr, &sa, 0)) return 127;
    SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);
    STARTUPINFOA si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = wr;
    si.hStdError = wr;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    PROCESS_INFORMATION pi{};
    std::vector<char> line(cmd.begin(), cmd.end());
    line.push_back('\0');
    if (!CreateProcessA(nullptr, line.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
        CloseHandle(rd);
        CloseHandle(wr);
        output = "glslc-shim: could not start " + args[0] + "\n";
        return 127;
    }
    CloseHandle(wr);
    char buf[4096];
    DWORD got = 0;
    while (ReadFile(rd, buf, sizeof(buf), &got, nullptr) && got > 0) output.append(buf, got);
    CloseHandle(rd);
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return (int)code;
}
#else
static int run(const std::vector<std::string>& args, std::string& output) {
    int fds[2];
    if (pipe(fds) != 0) return 127;
    pid_t pid = fork();
    if (pid == 0) {
        dup2(fds[1], 1);
        dup2(fds[1], 2);
        close(fds[0]);
        close(fds[1]);
        std::vector<char*> argv;
        for (const auto& a : args) argv.push_back(const_cast<char*>(a.c_str()));
        argv.push_back(nullptr);
        execv(argv[0], argv.data());
        _exit(127);
    }
    close(fds[1]);
    char buf[4096];
    ssize_t n;
    while ((n = read(fds[0], buf, sizeof(buf))) > 0) output.append(buf, (size_t)n);
    close(fds[0]);
    int status = 0;
    waitpid(pid, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
#endif

int main(int argc, char** argv) {
    const char* env = std::getenv("GLSLANG");
#ifdef _WIN32
    std::string glslang = env ? env : self_dir(argv[0]) + "\\glslang.exe";
#else
    std::string glslang = env ? env : self_dir(argv[0]) + "/glslang";
#endif
    std::vector<std::string> args{glslang, "--preamble-text", "#extension GL_GOOGLE_include_directive : require"};
    std::string out, tmp;
    bool to_stdout = false;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--version") {
            std::string text;
            int code = run({glslang, "--version"}, text);
            std::cout << "glslc-shim over " << text;
            return code;
        } else if (a.rfind("-fshader-stage=", 0) == 0) {
            std::string stage = a.substr(15);
            args.push_back("-S");
            args.push_back(stage == "compute" ? "comp" : stage == "vertex" ? "vert" : stage == "fragment" ? "frag" : stage);
        } else if (a.rfind("--target-env=", 0) == 0) {
            args.push_back("--target-env");
            args.push_back(a.substr(13));
        } else if (a == "-MD") {
            // glslang writes the depfile given by -MF.
        } else if (a == "-MF" && i + 1 < argc) {
            args.push_back("--depfile");
            args.push_back(argv[++i]);
        } else if (a == "-o" && i + 1 < argc) {
            out = argv[++i];
        } else {
            args.push_back(a);
        }
    }
    if (out == "-") {
        to_stdout = true;
        char name[64];
        std::snprintf(name, sizeof(name), "glslc-shim-%d.spv", (int)(
#ifdef _WIN32
            GetCurrentProcessId()
#else
            getpid()
#endif
        ));
        const char* t = std::getenv("TEMP");
        if (!t) t = std::getenv("TMPDIR");
        tmp = std::string(t ? t : ".") + "/" + name;
        out = tmp;
    }
    if (!out.empty()) {
        args.push_back("-o");
        args.push_back(out);
    }
    std::string text;
    int code = run(args, text);
    if (code != 0) {
        std::cerr << text;
        if (text.empty()) std::cerr << "glslc-shim: glslang failed with exit code " << code << "\n";
    }
    if (to_stdout) {
        std::ifstream f(tmp, std::ios::binary);
        std::string spv((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
#ifdef _WIN32
        _setmode(_fileno(stdout), _O_BINARY);
#endif
        std::fwrite(spv.data(), 1, spv.size(), stdout);
        f.close();
        std::remove(tmp.c_str());
    }
    return code;
}
