// Sokol Dear ImGui backend (C++ / imgui.h), no sokol_app dependency.
#define SOKOL_GLES3
#define SOKOL_IMPL
#define SOKOL_IMGUI_IMPL
#define SOKOL_IMGUI_NO_SOKOL_APP

#include "sokol_gfx.h"
#include "imgui.h"
#include "sokol_imgui.h"

extern "C" void mmt_imgui_enable_docking(void) {
    ImGuiIO &io = ImGui::GetIO();
    io.ConfigFlags |= ImGuiConfigFlags_DockingEnable;
}
