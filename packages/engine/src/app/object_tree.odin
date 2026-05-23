// Terminal object tree — workspace → chart pane → mounts / stream refs.
package app

import "../data"
import "../net"

MAX_CHART_PANES :: 16
MAX_SCRIPT_MOUNTS_PER_PANE :: 8
INVALID_STREAM_SLOT :: -1
INVALID_SCRIPT_MOUNT :: -1
MAX_SCRIPT_ID_BYTES :: 32
MAX_RUNTIME_ID_BYTES :: 32

ScriptMountNode :: struct {
    localIdLength:        i32,
    localIdBytes:         [24]u8,
    scriptIdLength:       i32,
    scriptIdBytes:        [MAX_SCRIPT_ID_BYTES]u8,
    runtimeIdLength:      i32,
    runtimeIdBytes:       [MAX_RUNTIME_ID_BYTES]u8,
    createToken:          i32,
    isVisible:            bool,
    isReady:              bool,
}

ChartPaneNode :: struct {
    paneId:               i32,
    isActive:             bool,
    symbolPair:           string,
    timeframeUiKey:       string,
    timeframeSeconds:     i32,
    heatmapStreamSlot:    i32,
    obHeatmapLayerEnabled: bool,
    footprintLayerEnabled: bool,
    scriptMounts:         [MAX_SCRIPT_MOUNTS_PER_PANE]ScriptMountNode,
    scriptMountCount:     i32,
}

ObjectTree :: struct {
    chartPanes:           [MAX_CHART_PANES]ChartPaneNode,
    activeChartPaneCount: i32,
}

@(private="file")
object_tree_singleton: ObjectTree

object_tree :: proc "contextless" () -> ^ObjectTree {
    return &object_tree_singleton
}

object_tree_init :: proc "contextless" (tree: ^ObjectTree) {
    for index in 0..<MAX_CHART_PANES {
        tree.chartPanes[index].paneId = -1
        tree.chartPanes[index].isActive = false
        tree.chartPanes[index].heatmapStreamSlot = INVALID_STREAM_SLOT
        tree.chartPanes[index].obHeatmapLayerEnabled = false
        tree.chartPanes[index].footprintLayerEnabled = false
        tree.chartPanes[index].scriptMountCount = 0
    }
    tree.activeChartPaneCount = 0
}

@(private)
copy_bytes :: proc "contextless" (dest: ^u8, dest_cap: int, src: string) -> i32 {
    count := min(len(src), dest_cap)
    for index in 0..<count {
        dest[index] = src[index]
    }
    return i32(count)
}

// Register a script mount slot (create_runtime pending until runtime_id assigned).
chart_pane_attach_script :: proc "contextless" (
    tree: ^ObjectTree,
    pane_id: i32,
    local_id: string,
    script_id: string,
    create_token: i32,
) -> i32 {
    for index in 0..<MAX_CHART_PANES {
        pane := &tree.chartPanes[index]
        if pane.paneId != pane_id { continue }
        if pane.scriptMountCount >= MAX_SCRIPT_MOUNTS_PER_PANE { return INVALID_SCRIPT_MOUNT }
        slot_index := pane.scriptMountCount
        mount := &pane.scriptMounts[slot_index]
        mount.localIdLength = copy_bytes(&mount.localIdBytes[0], 24, local_id)
        mount.scriptIdLength = copy_bytes(&mount.scriptIdBytes[0], MAX_SCRIPT_ID_BYTES, script_id)
        mount.runtimeIdLength = 0
        mount.createToken = create_token
        mount.isVisible = true
        mount.isReady = false
        pane.scriptMountCount += 1
        return i32(slot_index)
    }
    return INVALID_SCRIPT_MOUNT
}

chart_pane_set_script_runtime_id :: proc "contextless" (
    tree: ^ObjectTree,
    pane_id: i32,
    local_id: string,
    runtime_id: string,
) {
    for index in 0..<MAX_CHART_PANES {
        pane := &tree.chartPanes[index]
        if pane.paneId != pane_id { continue }
        for mount_index in 0..<pane.scriptMountCount {
            mount := &pane.scriptMounts[mount_index]
            if mount.localIdLength != i32(len(local_id)) { continue }
            match := true
            for byte_index in 0..<len(local_id) {
                if mount.localIdBytes[byte_index] != local_id[byte_index] { match = false; break }
            }
            if !match { continue }
            mount.runtimeIdLength = copy_bytes(&mount.runtimeIdBytes[0], MAX_RUNTIME_ID_BYTES, runtime_id)
            mount.isReady = true
            return
        }
        return
    }
}

chart_pane_detach_script :: proc "contextless" (
    tree: ^ObjectTree,
    pane_id: i32,
    local_id: string,
) {
    for index in 0..<MAX_CHART_PANES {
        pane := &tree.chartPanes[index]
        if pane.paneId != pane_id { continue }
        for mount_index in 0..<pane.scriptMountCount {
            mount := &pane.scriptMounts[mount_index]
            if mount.localIdLength != i32(len(local_id)) { continue }
            match := true
            for byte_index in 0..<len(local_id) {
                if mount.localIdBytes[byte_index] != local_id[byte_index] { match = false; break }
            }
            if !match { continue }
            last := pane.scriptMountCount - 1
            if mount_index < last {
                pane.scriptMounts[mount_index] = pane.scriptMounts[last]
            }
            pane.scriptMountCount -= 1
            return
        }
        return
    }
}

// Symbol/TF change — drop script runtime ids (JS recreates via create_runtime).
chart_pane_clear_script_runtimes :: proc "contextless" (tree: ^ObjectTree, pane_id: i32) {
    for index in 0..<MAX_CHART_PANES {
        pane := &tree.chartPanes[index]
        if pane.paneId != pane_id { continue }
        for mount_index in 0..<pane.scriptMountCount {
            pane.scriptMounts[mount_index].runtimeIdLength = 0
            pane.scriptMounts[mount_index].isReady = false
        }
        return
    }
}

chart_pane_register :: proc "contextless" (
    tree: ^ObjectTree,
    pane_id: i32,
    symbol_pair: string,
    timeframe_ui_key: string,
) -> bool {
    for index in 0..<MAX_CHART_PANES {
        if tree.chartPanes[index].paneId >= 0 { continue }
        pane := &tree.chartPanes[index]
        pane.paneId = pane_id
        pane.isActive = true
        pane.symbolPair = symbol_pair
        pane.timeframeUiKey = timeframe_ui_key
        pane.timeframeSeconds = net.mmt_timeframe_seconds_from_ui_key(timeframe_ui_key)
        pane.heatmapStreamSlot = INVALID_STREAM_SLOT
        tree.activeChartPaneCount += 1
        return true
    }
    return false
}

chart_pane_unregister :: proc "contextless" (tree: ^ObjectTree, pane_id: i32) {
    hub := net.feed_hub()
    for index in 0..<MAX_CHART_PANES {
        pane := &tree.chartPanes[index]
        if pane.paneId != pane_id { continue }
        if pane.heatmapStreamSlot != INVALID_STREAM_SLOT {
            net.feed_hub_release_stream(hub, pane.heatmapStreamSlot)
        }
        pane.paneId = -1
        pane.isActive = false
        pane.heatmapStreamSlot = INVALID_STREAM_SLOT
        tree.activeChartPaneCount -= 1
        return
    }
}

chart_pane_set_active :: proc "contextless" (tree: ^ObjectTree, pane_id: i32, active: bool) {
    hub := net.feed_hub()
    for index in 0..<MAX_CHART_PANES {
        pane := &tree.chartPanes[index]
        if pane.paneId != pane_id { continue }
        if pane.isActive == active { return }
        pane.isActive = active
        if active && pane.obHeatmapLayerEnabled {
            chart_pane_sync_heatmap_stream(tree, pane)
        } else if !active && pane.heatmapStreamSlot != INVALID_STREAM_SLOT {
            net.feed_hub_release_stream(hub, pane.heatmapStreamSlot)
            pane.heatmapStreamSlot = INVALID_STREAM_SLOT
        }
        return
    }
}

chart_pane_set_ob_heatmap :: proc "contextless" (tree: ^ObjectTree, pane_id: i32, enabled: bool) {
    for index in 0..<MAX_CHART_PANES {
        pane := &tree.chartPanes[index]
        if pane.paneId != pane_id { continue }
        pane.obHeatmapLayerEnabled = enabled
        if enabled && pane.isActive {
            chart_pane_sync_heatmap_stream(tree, pane)
        } else if !enabled && pane.heatmapStreamSlot != INVALID_STREAM_SLOT {
            net.feed_hub_release_stream(net.feed_hub(), pane.heatmapStreamSlot)
            pane.heatmapStreamSlot = INVALID_STREAM_SLOT
        }
        return
    }
}

@(private)
chart_pane_sync_heatmap_stream :: proc "contextless" (tree: ^ObjectTree, pane: ^ChartPaneNode) {
    hub := net.feed_hub()
    if pane.heatmapStreamSlot != INVALID_STREAM_SLOT {
        net.feed_hub_release_stream(hub, pane.heatmapStreamSlot)
        pane.heatmapStreamSlot = INVALID_STREAM_SLOT
    }
    if !pane.obHeatmapLayerEnabled || !pane.isActive { return }
    pane.heatmapStreamSlot = net.feed_hub_acquire_heatmap_agg(
        hub,
        net.FEED_HUB_DEFAULT_AGG_EXCHANGES,
        pane.symbolPair,
        pane.timeframeSeconds,
    )
}

chart_pane_refresh_context :: proc "contextless" (
    tree: ^ObjectTree,
    pane_id: i32,
    symbol_pair: string,
    timeframe_ui_key: string,
) {
    for index in 0..<MAX_CHART_PANES {
        pane := &tree.chartPanes[index]
        if pane.paneId != pane_id { continue }
        if pane.heatmapStreamSlot != INVALID_STREAM_SLOT {
            net.feed_hub_release_stream(net.feed_hub(), pane.heatmapStreamSlot)
            pane.heatmapStreamSlot = INVALID_STREAM_SLOT
        }
        pane.symbolPair = symbol_pair
        pane.timeframeUiKey = timeframe_ui_key
        pane.timeframeSeconds = net.mmt_timeframe_seconds_from_ui_key(timeframe_ui_key)
        chart_pane_clear_script_runtimes(tree, pane_id)
        if pane.isActive && pane.obHeatmapLayerEnabled {
            chart_pane_sync_heatmap_stream(tree, pane)
        }
        return
    }
}
