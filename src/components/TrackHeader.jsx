import { useNavigate } from "react-router-dom";
import Header from "./Header.jsx";
import { BRANCHES, BRANCH_LIST } from "../data/branches.js";

// ============================================================
// TrackHeader — envoltorio de <Header> para /track y /track/:num
// Estas páginas viven fuera de StoreApp (no hay carrito activo),
// así que usamos la última sucursal conocida solo para mostrar
// el mismo header de marca, y mandamos todas las acciones a "/".
// ============================================================
export default function TrackHeader() {
  const navigate = useNavigate();
  let branch = BRANCH_LIST[0];
  try {
    const lastId = localStorage.getItem("fw.lastBranch");
    if (lastId && BRANCHES[lastId]) branch = BRANCHES[lastId];
  } catch {
    /* localStorage no disponible */
  }

  if (!branch) return null;

  return (
    <Header
      branch={branch}
      cartCount={0}
      onHome={() => navigate("/")}
      onHistory={() => navigate("/")}
      onCart={() => navigate("/")}
    />
  );
}
