#define _GNU_SOURCE
#include <dlfcn.h>
#include <signal.h>
#include <stddef.h>
#include <sys/select.h>
#include <unistd.h>

static int interrupted = 0;

/* Delivers interruption at the OS read boundary, before read can block. */
ssize_t read(int descriptor, void *buffer, size_t size)
{
    ssize_t (*real_read)(int, void *, size_t) = dlsym(RTLD_NEXT, "read");
    if (!interrupted && isatty(descriptor)) {
        interrupted = 1;
        raise(SIGINT);
    }
    return real_read(descriptor, buffer, size);
}

/* Delivers a pending interruption immediately before atomic signal-aware waiting. */
int pselect(int count, fd_set *readers, fd_set *writers, fd_set *exceptions,
    const struct timespec *timeout, const sigset_t *mask)
{
    int (*real_pselect)(int, fd_set *, fd_set *, fd_set *, const struct timespec *,
        const sigset_t *) = dlsym(RTLD_NEXT, "pselect");
    if (!interrupted) {
        interrupted = 1;
        raise(SIGINT);
    }
    return real_pselect(count, readers, writers, exceptions, timeout, mask);
}
