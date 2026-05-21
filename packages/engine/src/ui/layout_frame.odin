// MMT.gg workspace chrome via ImGui (top bar, tool rail, dock hints).
package ui

import "../app"

@(private="file")
TOPBAR_LABEL :: "MMT-Trade"

layout_frame_draw :: proc "contextless" (layout: ^app.LayoutMetrics, delta_seconds: f32) {
    _ = layout
    _ = delta_seconds

    imgui_main_dockspace()

    if begin_main_menu_bar() {
        text(TOPBAR_LABEL)
        button("1m", ImVec2{ x = 28, y = 0 })
        button("1h", ImVec2{ x = 28, y = 0 })
        button("4h", ImVec2{ x = 28, y = 0 })
        end_main_menu_bar()
    }
}
