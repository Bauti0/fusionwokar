import { useEffect, useRef, useState } from "react";
import { buildComandaHtml, buildTicketHtml } from "../utils/ticketHtml.js";
import { buildCashTicketHtml } from "../utils/cashTicketHtml.js";
import { adminSales } from "../api.js";
import ConfirmModal from "./ui/ConfirmModal.jsx";

// ============================================================
// TicketPrint — imprime documentos en la impresora térmica de 58mm.
// Abre una ventana con el documento listo y dispara print()
// (la impresora térmica debe estar configurada como predeterminada)
// Prop `variant`:
//   "ticket"  → ticket completo para la bolsa del pedido (importes, cliente, etc.)
//   "comanda" → comanda para la cocina, SOLO cantidades y nombre del producto
//   "cierre"  → ticket del cierre de caja (prop `cash`, el cierre con la forma
//               que devuelve GET /api/admin/cash-register)
//
// El HTML de los dos primeros vive en src/utils/ticketHtml.js: ahí se limpian
// los caracteres que la térmica no puede imprimir (acentos, ×, ·, emojis) y se
// ordenan los ítems de mayor a menor cantidad. El del cierre está en
// src/utils/cashTicketHtml.js. Acá solo se abre la ventana.
//
// En "cierre" la ventana se abre SIEMPRE primero, antes de cualquier await:
// si se abriera después del fetch, Safari y otros navegadores la bloquean.
// El desglose del turno se pide recién cuando la ventana ya está abierta y,
// si falla, el ticket sale igual con la nota "Desglose no disponible".
// ============================================================

export default function TicketPrint({ order, onClose, variant = "ticket", cash }) {
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

    // Cierre: ventana ya abierta → fetch del desglose → escribir el HTML.
    // `alive` evita tocar la ventana si el panel se desmonta entretanto.
    if (variant === "cierre") {
      let alive = true;
      let t;
      (async () => {
        let sales = null;
        try {
          sales = await adminSales({ branch: cash.branch, from: cash.openedAt, to: cash.closedAt });
        } catch {
          sales = null; // sin desglose: el ticket sale igual (lo resuelve la función pura)
        }
        if (!alive) return;
        win.document.write(buildCashTicketHtml({ cash, sales }));
        win.document.close();
        t = setTimeout(() => {
          win.focus();
          win.print();
          setTimeout(() => win.close(), 300);
          setTimeout(() => onClose(), 200);
        }, 400);
      })();
      return () => {
        alive = false;
        clearTimeout(t);
      };
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
