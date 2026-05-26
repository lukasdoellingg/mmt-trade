/**
 * Fixed positioning for topbar dropdowns teleported to document.body
 * (avoids overflow clipping on .topbar).
 */
import { nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue';

export type DropdownAnchorStyle = {
  top: string;
  left?: string;
  right?: string;
  minWidth?: string;
};

export function useDropdownAnchor(
  open: Ref<boolean>,
  anchorEl: Ref<HTMLElement | null>,
  align: 'left' | 'right' = 'left',
): Ref<DropdownAnchorStyle> {
  const pos = ref<DropdownAnchorStyle>({ top: '0px', left: '0px' });
  let stopLayout: (() => void) | null = null;

  function refresh(): void {
    const el = anchorEl.value;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const top = `${r.bottom + 3}px`;
    if (align === 'right') {
      pos.value = {
        top,
        right: `${Math.max(0, window.innerWidth - r.right)}px`,
        minWidth: `${Math.max(r.width, 160)}px`,
      };
    } else {
      pos.value = {
        top,
        left: `${r.left}px`,
        minWidth: `${Math.max(r.width, 160)}px`,
      };
    }
  }

  watch(open, (isOpen) => {
    if (stopLayout) {
      stopLayout();
      stopLayout = null;
    }
    if (!isOpen) return;
    nextTick(() => {
      refresh();
      const onLayout = () => refresh();
      window.addEventListener('resize', onLayout, { passive: true });
      const topbar = anchorEl.value?.closest('.topbar');
      topbar?.addEventListener('scroll', onLayout, { passive: true });
      stopLayout = () => {
        window.removeEventListener('resize', onLayout);
        topbar?.removeEventListener('scroll', onLayout);
      };
    });
  });

  onBeforeUnmount(() => {
    stopLayout?.();
    stopLayout = null;
  });

  return pos;
}
