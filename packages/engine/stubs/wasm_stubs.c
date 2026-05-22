// Stubs for Odin js_wasm32 + Emscripten link.
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

// Linked as odin_env..write via build.sh -Wl,--defsym (see build.sh).
void odin_env_write_impl(uint32_t fd, uint32_t ptr, uint32_t len) {
    (void)fd;
    (void)ptr;
    (void)len;
}

ssize_t write(int fd, const void *buf, size_t count) {
    (void)fd;
    (void)buf;
    return (ssize_t)count;
}
