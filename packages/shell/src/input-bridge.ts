/**
 * SharedArrayBuffer ring for JS → WASM input (see app/input_bridge.odin).
 */

export const INPUT_RING_SLOT_COUNT = 256;
export const INPUT_RING_SLOT_BYTES = 32;
export const INPUT_RING_HEADER_BYTES = 16;

export const InputEventType = {
  MouseMove: 1,
  MouseDown: 2,
  MouseUp: 3,
  MouseLeave: 4,
  Wheel: 5,
  KeyDown: 6,
  KeyUp: 7,
  Resize: 8,
  Focus: 9,
  Blur: 10,
} as const;

export type InputEventTypeValue = (typeof InputEventType)[keyof typeof InputEventType];

export interface InputRingViews {
  buffer: SharedArrayBuffer;
  headerU32: Uint32Array;
  slotsF32: Float32Array;
}

export function createInputRing(): InputRingViews {
  const totalBytes = INPUT_RING_HEADER_BYTES + INPUT_RING_SLOT_COUNT * INPUT_RING_SLOT_BYTES;
  const buffer = new SharedArrayBuffer(totalBytes);
  const headerU32 = new Uint32Array(buffer, 0, 4);
  const slotsF32 = new Float32Array(
    buffer,
    INPUT_RING_HEADER_BYTES,
    (INPUT_RING_SLOT_COUNT * INPUT_RING_SLOT_BYTES) / 4,
  );
  headerU32[2] = INPUT_RING_SLOT_COUNT;
  headerU32[3] = INPUT_RING_SLOT_COUNT - 1;
  return { buffer, headerU32, slotsF32 };
}

export class InputBridge {
  private writeIndex = 0;

  constructor(
    private readonly headerU32: Uint32Array,
    private readonly slotsF32: Float32Array,
  ) {}

  static fromViews(views: InputRingViews): InputBridge {
    return new InputBridge(views.headerU32, views.slotsF32);
  }

  push(
    eventType: InputEventTypeValue,
    flagsAndButtons: number,
    x: number,
    y: number,
    deltaX = 0,
    deltaY = 0,
    keyCode = 0,
  ): void {
    const mask = this.headerU32[3]!;
    const slotIndex = this.writeIndex & mask;
    const baseFloat = (slotIndex * INPUT_RING_SLOT_BYTES) / 4;
    this.slotsF32[baseFloat + 0] = eventType;
    this.slotsF32[baseFloat + 1] = flagsAndButtons;
    this.slotsF32[baseFloat + 2] = x;
    this.slotsF32[baseFloat + 3] = y;
    this.slotsF32[baseFloat + 4] = deltaX;
    this.slotsF32[baseFloat + 5] = deltaY;
    this.slotsF32[baseFloat + 6] = keyCode;
    this.slotsF32[baseFloat + 7] = 0;
    this.writeIndex += 1;
    Atomics.store(this.headerU32, 0, this.writeIndex);
  }
}

export function attachCanvasInput(canvas: HTMLCanvasElement, bridge: InputBridge): () => void {
  const rect = (): DOMRect => canvas.getBoundingClientRect();

  const onMove = (event: MouseEvent): void => {
    const bounds = rect();
    bridge.push(
      InputEventType.MouseMove,
      event.buttons,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
    );
  };
  const onDown = (event: MouseEvent): void => {
    const bounds = rect();
    bridge.push(
      InputEventType.MouseDown,
      event.buttons,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
    );
  };
  const onUp = (event: MouseEvent): void => {
    const bounds = rect();
    bridge.push(
      InputEventType.MouseUp,
      event.buttons,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
    );
  };
  const onLeave = (): void => {
    bridge.push(InputEventType.MouseLeave, 0, 0, 0);
  };
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const bounds = rect();
    bridge.push(
      InputEventType.Wheel,
      0,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      event.deltaX,
      event.deltaY,
    );
  };

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mouseup', onUp);
  canvas.addEventListener('mouseleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  return () => {
    canvas.removeEventListener('mousemove', onMove);
    canvas.removeEventListener('mousedown', onDown);
    canvas.removeEventListener('mouseup', onUp);
    canvas.removeEventListener('mouseleave', onLeave);
    canvas.removeEventListener('wheel', onWheel);
  };
}
