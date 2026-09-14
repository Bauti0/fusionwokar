import { useEffect, useRef } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ============================================================
// useDialogA11y — accesibilidad para modales
// Al abrirse: mueve el foco al primer elemento interactivo
// (o al elemento pasado en initialFocusRef).
// Mientras está abierto: atrapa Tab dentro del diálogo y lo
// cierra con Escape.
// Al cerrarse: devuelve el foco al elemento que lo abrió.
//
// Uso:
//   const dialogRef = useDialogA11y({ onClose, isActive });
//   <div className="modal" ref={dialogRef} tabIndex={-1} ...>
// ============================================================
export default function useDialogA11y({ onClose, isActive = true, initialFocusRef } = {}) {
  const ref = useRef(null);

  useEffect(() => {
    if (!isActive || !ref.current) return;
    const dialog = ref.current;
    const opener = document.activeElement;

    // Mueve el foco adentro apenas se abre
    const initial = initialFocusRef?.current;
    if (initial && !initial.disabled && dialog.contains(initial)) {
      initial.focus();
    } else {
      const focusables = () =>
        Array.from(dialog.querySelectorAll(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null || el === document.activeElement
        );
      (focusables()[0] || dialog).focus();
    }

    function onKeyDown(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose?.();
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Devuelve el foco al elemento que abrió el modal
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [isActive]); // eslint-disable-line react-hooks/exhaustive-deps

  return ref;
}
