import { useEffect, useRef, useState } from "react";
import { buildComandaHtml, buildTicketHtml } from "../utils/ticketHtml.js";
import ConfirmModal from "./ui/ConfirmModal.jsx";

// ============================================================
// TicketPrint — imprime el ticket de cocina/entrega en 58mm.
// Abre una ventana con el documento listo y dispara print()
// (la impresora térmica debe estar configurada como predeterminada)
// Prop `variant`:
//   "ticket"  → ticket completo para la bolsa del pedido (importes, cliente, etc.)
//   "comanda" → comanda para la cocina, SOLO cantidades y nombre del producto
//
// El HTML de los dos documentos vive en src/utils/ticketHtml.js: ahí se limpian
// los caracteres que la térmica no puede imprimir (acentos, ×, ·, emojis) y se
// ordenan los ítems de mayor a menor cantidad. Acá solo se abre la ventana.
// ============================================================

export default function TicketPrint({ order, onClose, variant = "ticket" }) {
  const done = useRef(false);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const win = window.open("", "_blank", "width=300,height=600");
    if (!win) {
      setBlocked(true);
      return;
    }
    win.document.write(variant === "comanda" ? buildComandaHtml(order) : buildTicketHtml(order));
    // document.close() cierra el documento y da por terminado lo que se está
    // escribiendo. NO es lo mismo que window.close(): cerrar la ventana acá
    // mataba el print() de abajo y el ticket no salía.
    win.document.close();
    const t = setTimeout(() => {
      win.focus();
      win.print();
      setTimeout(() => win.close(), 300);
      setTimeout(() => onClose(), 200);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (blocked) {
    return (
      <ConfirmModal
        title="No se pudo imprimir"
        message="Permití las ventanas emergentes para este sitio y volvé a intentarlo."
        cancelText={null}
        confirmText="Entendido"
        onConfirm={() => {}}
        onClose={onClose}
      />
    );
  }

  return null;
}