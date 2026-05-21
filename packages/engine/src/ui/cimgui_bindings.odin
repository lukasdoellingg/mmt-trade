// cimgui bindings (subset).
//
// The full cimgui surface area is enormous; we expose only what the
// terminal needs: docking, window/panel/menu primitives, basic widgets, and
// the per-frame begin/end calls. Sokol-Imgui (sokol_imgui.h) is wired
// through emcc in `packages/engine/build.sh` once Phase 5 turns on the
// full link target.
//
// All function pointers resolve at link time via `-I vendor/cimgui` +
// `--whole-archive` of cimgui.cpp + imgui*.cpp. The wrappers below stay
// `c`-call-convention and never allocate.
package ui

ImGuiWindowFlags :: enum u32 {
    None                = 0,
    NoTitleBar          = 1 << 0,
    NoResize            = 1 << 1,
    NoMove              = 1 << 2,
    NoScrollbar         = 1 << 3,
    NoScrollWithMouse   = 1 << 4,
    NoCollapse          = 1 << 5,
    NoBackground        = 1 << 7,
    MenuBar             = 1 << 10,
    NoBringToFrontOnFocus = 1 << 13,
    NoDocking           = 1 << 21,
}

ImGuiConfigFlags :: enum u32 {
    None                  = 0,
    NavEnableKeyboard     = 1 << 0,
    NavEnableGamepad      = 1 << 1,
    DockingEnable         = 1 << 6,
    ViewportsEnable       = 1 << 10,
}

ImGuiDockNodeFlags :: enum u32 {
    None                = 0,
    PassthruCentralNode = 1 << 3,
}

ImGuiID :: distinct u32

ImVec2 :: struct {
    x: f32,
    y: f32,
}

ImVec4 :: struct {
    x: f32,
    y: f32,
    z: f32,
    w: f32,
}

@(default_calling_convention="c")
foreign {
    @(link_name="mmt_imgui_enable_docking")
    mmt_imgui_enable_docking :: proc() ---

    @(link_name="igCreateContext")
    create_context :: proc(shared_font_atlas: rawptr) -> rawptr ---

    @(link_name="igDestroyContext")
    destroy_context :: proc(context_ptr: rawptr) ---

    @(link_name="igNewFrame")
    new_frame :: proc() ---

    @(link_name="igRender")
    render :: proc() ---

    @(link_name="igBegin")
    begin :: proc(name: cstring, p_open: ^bool, flags: u32) -> bool ---

    @(link_name="igEnd")
    end :: proc() ---

    @(link_name="igBeginMainMenuBar")
    begin_main_menu_bar :: proc() -> bool ---

    @(link_name="igEndMainMenuBar")
    end_main_menu_bar :: proc() ---

    @(link_name="igButton")
    button :: proc(label: cstring, size: ImVec2) -> bool ---

    @(link_name="igCheckbox")
    checkbox :: proc(label: cstring, value: ^bool) -> bool ---

    @(link_name="igTextUnformatted")
    text :: proc(label: cstring) ---

    @(link_name="igDockSpaceOverViewport")
    dockspace_over_viewport :: proc(viewport: rawptr, flags: u32, window_class: rawptr, dock_id: ImGuiID) -> ImGuiID ---

    @(link_name="igGetMainViewport")
    get_main_viewport :: proc() -> rawptr ---

    @(link_name="igSaveIniSettingsToMemory")
    save_ini_settings_to_memory :: proc(out_ini_size: ^u32) -> cstring ---

    @(link_name="igLoadIniSettingsFromMemory")
    load_ini_settings_from_memory :: proc(ini_data: cstring, ini_size: u32) ---
}

imgui_enable_docking :: proc "contextless" () {
    mmt_imgui_enable_docking()
}

imgui_main_dockspace :: proc "contextless" () {
    viewport := get_main_viewport()
    _ = dockspace_over_viewport(viewport, u32(ImGuiDockNodeFlags.PassthruCentralNode), nil, 0)
}
