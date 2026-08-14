/**
 * 时长口径共享常量(design D6):相邻消息间隔超过该值计为一次活跃中断,
 * 间隔不记入 active_ms。主进程(memory/duration)与前端 lane(timeline 块高)
 * 共同引用,口径唯一。
 */
export const IDLE_GAP_MS = 5 * 60 * 1000;

/** 时间线断口阈值:相邻消息间隔超过该值,渲染时切分为独立段(仅影响显示切块,不影响 active_ms 口径)。 */
export const SEGMENT_BREAK_GAP_MS = 15 * 60 * 1000;
