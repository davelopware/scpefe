#include "password_input.hpp"
#include <cstdio>

#ifdef _WIN32
#include <windows.h>
#include <io.h>
#else
#include <cerrno>
#include <csignal>
#include <fcntl.h>
#include <termios.h>
#include <sys/select.h>
#include <unistd.h>
#endif

namespace {

#ifndef _WIN32
volatile std::sig_atomic_t interrupted = 0;

void interrupt_prompt(int signal)
{
    interrupted = signal;
}
#endif

} // namespace

PasswordInput::~PasswordInput() { clear(); }

void PasswordInput::clear() noexcept
{
    volatile std::uint8_t *bytes = bytes_.data();
    for (std::size_t i = 0; i < bytes_.size(); ++i) bytes[i] = 0;
    size_ = 0;
}

scpefe_status PasswordInput::read(bool from_stdin)
{
    clear();
#ifdef _WIN32
    if (!from_stdin) {
        HANDLE input = CreateFileW(L"CONIN$", GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
        DWORD mode = 0;
        if (input == INVALID_HANDLE_VALUE || !GetConsoleMode(input, &mode)) {
            if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
            return SCPEFE_STATUS_HOST_ERROR;
        }
        if (!SetConsoleMode(input, (mode | ENABLE_LINE_INPUT)
            & ~(ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT))) {
            CloseHandle(input);
            return SCPEFE_STATUS_HOST_ERROR;
        }
        std::fputs("Password: ", stderr);
        std::fflush(stderr);
        std::array<wchar_t, 4098> wide{};
        DWORD count = 0;
        const bool read_ok = ReadConsoleW(input, wide.data(),
            static_cast<DWORD>(wide.size()), &count, nullptr) != 0;
        const bool restored = SetConsoleMode(input, mode) != 0;
        CloseHandle(input);
        std::fputc('\n', stderr);
        while (count && (wide[count - 1] == L'\r' || wide[count - 1] == L'\n')) --count;
        bool interrupted_read = false;
        for (DWORD i = 0; i < count; ++i)
            if (wide[i] == 3 || wide[i] == 4 || wide[i] == 26) interrupted_read = true;
        const int size = read_ok && restored && !interrupted_read && count
            ? WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide.data(),
                static_cast<int>(count), reinterpret_cast<char *>(bytes_.data()),
                4096, nullptr, nullptr) : 0;
        SecureZeroMemory(wide.data(), wide.size() * sizeof(wchar_t));
        if (size <= 0) { clear(); return SCPEFE_STATUS_HOST_ERROR; }
        size_ = static_cast<std::size_t>(size);
        return SCPEFE_STATUS_OK;
    }
#else
    int descriptor = STDIN_FILENO;
    termios original{};
    constexpr int signals[]{SIGINT, SIGTERM, SIGHUP, SIGQUIT};
    std::array<struct sigaction, 4> previous{};
    sigset_t signal_set{}, previous_mask{};
    if (!from_stdin) {
        descriptor = open("/dev/tty", O_RDWR | O_CLOEXEC | O_NONBLOCK);
        if (descriptor < 0) return SCPEFE_STATUS_HOST_ERROR;
        if (descriptor >= FD_SETSIZE || tcgetattr(descriptor, &original) != 0) {
            close(descriptor);
            return SCPEFE_STATUS_HOST_ERROR;
        }
        sigemptyset(&signal_set);
        for (int signal : signals) sigaddset(&signal_set, signal);
        if (sigprocmask(SIG_BLOCK, &signal_set, &previous_mask) != 0) {
            close(descriptor);
            return SCPEFE_STATUS_HOST_ERROR;
        }
        interrupted = 0;
        struct sigaction handler{};
        handler.sa_handler = interrupt_prompt;
        sigemptyset(&handler.sa_mask);
        std::size_t installed = 0;
        for (; installed < previous.size(); ++installed)
            if (sigaction(signals[installed], &handler, &previous[installed]) != 0) break;
        termios hidden = original;
        hidden.c_lflag &= ~(ECHO | ECHONL);
        if (installed != previous.size() || tcsetattr(descriptor, TCSAFLUSH, &hidden) != 0) {
            for (std::size_t i = 0; i < installed; ++i) sigaction(signals[i], &previous[i], nullptr);
            sigprocmask(SIG_SETMASK, &previous_mask, nullptr);
            close(descriptor);
            return SCPEFE_STATUS_HOST_ERROR;
        }
        const char prompt[] = "Password: ";
        if (write(descriptor, prompt, sizeof(prompt) - 1) < 0) interrupted = SIGINT;
    }
#endif
    scpefe_status status = SCPEFE_STATUS_OK;
    for (;;) {
#ifdef _WIN32
        const int count = _read(0, bytes_.data() + size_, 1);
#else
        if (!from_stdin && interrupted) { status = SCPEFE_STATUS_HOST_ERROR; break; }
        if (!from_stdin) {
            fd_set ready;
            FD_ZERO(&ready);
            FD_SET(descriptor, &ready);
            // Signals stay blocked between the flag check and the read.
            // pselect atomically unmasks them while waiting for terminal input.
            const auto available = pselect(descriptor + 1, &ready, nullptr,
                nullptr, nullptr, &previous_mask);
            if (available < 0 && errno == EINTR) continue;
            if (available < 0) { status = SCPEFE_STATUS_HOST_ERROR; break; }
        }
        const auto count = ::read(descriptor, bytes_.data() + size_, 1);
        if (!from_stdin && count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        if (count < 0 && errno == EINTR && (from_stdin || !interrupted)) continue;
#endif
        if (count < 0) { status = SCPEFE_STATUS_HOST_ERROR; break; }
        if (count == 0 || bytes_[size_] == '\n') break;
        if (++size_ == bytes_.size()) { status = SCPEFE_STATUS_LIMIT_EXCEEDED; break; }
    }
#ifndef _WIN32
    if (!from_stdin) {
        sigprocmask(SIG_BLOCK, &signal_set, nullptr);
        if (tcsetattr(descriptor, TCSAFLUSH, &original) != 0) status = SCPEFE_STATUS_HOST_ERROR;
        for (std::size_t i = 0; i < previous.size(); ++i) sigaction(signals[i], &previous[i], nullptr);
        sigprocmask(SIG_SETMASK, &previous_mask, nullptr);
        const char newline = '\n';
        (void)write(descriptor, &newline, 1);
        close(descriptor);
    }
#endif
    if (size_ && bytes_[size_ - 1] == '\r') --size_;
    if (size_ > 4096) status = SCPEFE_STATUS_LIMIT_EXCEEDED;
    if (!size_ && status == SCPEFE_STATUS_OK) status = SCPEFE_STATUS_INVALID_ARGUMENT;
    if (status != SCPEFE_STATUS_OK) clear();
    return status;
}
