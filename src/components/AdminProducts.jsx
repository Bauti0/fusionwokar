import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  adminProducts,
  adminCreateProduct,
  adminUpdateProduct,
  adminToggleProduct,
  adminDeleteProduct,
  adminMoveProduct,
  adminCreateCategory,
  adminRenameCategory,
  adminDeleteCategory,
  adminMoveCategory,
  adminRenameGroup,
  adminDeleteGroup,
  adminUploadImage,
} from "../api.js";
import { BRANCH_LIST } from "../data/branches.js";
import { formatPrice } from "../utils/format.js";
import useDialogA11y from "../hooks/useDialogA11y.js";
import Dropdown from "./ui/Dropdown.jsx";
import PromptModal from "./ui/PromptModal.jsx";
import ConfirmModal from "./ui/ConfirmModal.jsx";
import Tooltip from "./ui/Tooltip.jsx";

// ============================================================
// AdminProducts — edición del menú desde el panel
// - Agregar / editar / ocultar / eliminar / reordenar productos
// - CRUD de categorías y grupos (crear, renombrar, eliminar, reordenar)
// - Imágenes de producto (subida → /uploads/products)
// - Búsqueda por nombre dentro de la sucursal seleccionada
// ============================================================

const EMPTY_FORM = {
  branch: "",
  categoryId: "",
  categoryName: "",
  groupName: "",
  name: "",
  price: "",
  description: "",
  image: "",
};

function slugify(text) {
  return (
    String(text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "categoria"
  );
}

export default function AdminProducts() {
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [branchId, setBranchId] = useState(BRANCH_LIST[0]?.id || "");
  const [editing, setEditing] = useState(null); // null | { product } | { isNew: true, groupName }
  const [form, setForm] = useState(EMPTY_FORM);
  const [newCategory, setNewCategory] = useState(false);
  // Prompt de categoría/grupo: null | { mode: "create" } |
  // { mode: "category", cat } | { mode: "group", group, cat }
  const [catPrompt, setCatPrompt] = useState(null);
  // Confirmación de borrado: null | { title, message, onConfirm }
  const [confirmState, setConfirmState] = useState(null);
  const [query, setQuery] = useState("");
  const [uploading, setUploading] = useState(false);
  const [dragProductId, setDragProductId] = useState(null);
  const [overProductId, setOverProductId] = useState(null);
  const [dragCatId, setDragCatId] = useState(null);
  const [overCatId, setOverCatId] = useState(null);
  const fileRef = useRef(null);
  const dialogRef = useDialogA11y({ onClose: closeModal, isActive: !!editing });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminProducts();
      setBranches(data.branches);
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const branch = useMemo(() => branches.find((b) => b.branchId === branchId) || null, [branches, branchId]);

  function openAdd(groupName = "") {
    setEditing({ isNew: true, groupName });
    setForm({
      ...EMPTY_FORM,
      branch: branchId,
      categoryId: branch?.categories?.[0]?.id || "",
      categoryName: "",
      groupName: groupName || "",
    });
    setNewCategory(false);
  }

  function openEdit(product) {
    setEditing({ product });
    setForm({
      branch: product.branch,
      categoryId: product.categoryId,
      categoryName: product.categoryName,
      groupName: product.groupName,
      name: product.name,
      price: String(product.price),
      description: product.description || "",
      image: product.image || "",
    });
    setNewCategory(false);
  }

  function closeModal() {
    setEditing(null);
  }

  async function handleSave(e) {
    e.preventDefault();
    setError("");
    const payload = {
      branch: form.branch,
      categoryId: form.categoryId,
      categoryName: form.categoryName || (newCategory ? form.categoryName : undefined),
      groupName: form.groupName,
      name: form.name,
      price: Number(form.price),
      description: form.description,
      image: form.image,
    };
    if (newCategory && !form.categoryName) {
      setError("Escribí el nombre de la nueva categoría");
      return;
    }
    if (!newCategory && !form.categoryId) {
      setError("Elegí una categoría");
      return;
    }
    if (!form.name.trim()) {
      setError("El nombre es obligatorio");
      return;
    }
    const price = Number(form.price);
    if (form.price === "" || isNaN(price) || price < 0) {
      setError("Precio inválido");
      return;
    }
    try {
      if (editing?.product) {
        await adminUpdateProduct(editing.product.id, payload);
      } else {
        await adminCreateProduct(payload);
      }
      closeModal();
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleToggle(product) {
    try {
      await adminToggleProduct(product.id, !product.available);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function handleDelete(product) {
    setConfirmState({
      title: "Eliminar producto",
      message: `¿Eliminar "${product.name}" del menú?`,
      confirmText: "Eliminar",
      onConfirm: async () => {
        await adminDeleteProduct(product.id);
        await load();
      },
    });
  }

  async function handleMoveProduct(product, dir) {
    try {
      await adminMoveProduct(product.id, dir);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function openAddCategory() {
    setCatPrompt({ mode: "create" });
  }

  function openRenameCategory(cat) {
    setCatPrompt({ mode: "category", cat });
  }

  async function submitCategoryPrompt(name) {
    if (catPrompt.mode === "create") {
      await adminCreateCategory({ branch: branchId, name });
      return;
    }
    if (catPrompt.mode === "category") {
      if (name === catPrompt.cat.name) return; // sin cambios
      await adminRenameCategory(catPrompt.cat.rowId ?? catPrompt.cat.id, name);
      return;
    }
    // Renombrar grupo
    await adminRenameGroup({
      branch: branchId,
      categoryId: catPrompt.cat.id,
      oldName: catPrompt.group.name || "",
      newName: name,
    });
  }

  function handleDeleteCategory(cat) {
    setConfirmState({
      title: "Eliminar categoría",
      message: `¿Eliminar la categoría "${cat.name}" y TODOS sus productos?`,
      confirmText: "Eliminar todo",
      onConfirm: async () => {
        await adminDeleteCategory(cat.rowId ?? cat.id);
        await load();
      },
    });
  }

  async function handleMoveCategory(cat, dir) {
    try {
      await adminMoveCategory(cat.rowId ?? cat.id, dir);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function applyMoveSteps(id, steps, dir, moveFn) {
    try {
      for (let i = 0; i < steps; i++) {
        await moveFn(id, dir);
      }
      await load();
    } catch (err) {
      setError(err.message);
      try {
        await load();
      } catch {}
    }
  }

  function handleProductDrop(fromId, toId, list) {
    const from = list.findIndex((x) => x.id === fromId);
    const to = list.findIndex((x) => x.id === toId);
    if (from === -1 || to === -1 || from === to) return;
    const steps = Math.abs(from - to);
    const dir = from < to ? "down" : "up";
    applyMoveSteps(fromId, steps, dir, adminMoveProduct);
  }

  function handleCategoryDrop(fromId, toId, list) {
    const from = list.findIndex((x) => (x.rowId ?? x.id) === fromId);
    const to = list.findIndex((x) => (x.rowId ?? x.id) === toId);
    if (from === -1 || to === -1 || from === to) return;
    const steps = Math.abs(from - to);
    const dir = from < to ? "down" : "up";
    applyMoveSteps(fromId, steps, dir, (id, d) => adminMoveCategory(id, d));
  }

  function openRenameGroup(group, cat) {
    setCatPrompt({ mode: "group", group, cat });
  }

  function handleDeleteGroup(group, cat) {
    const label = group.name || "Sin grupo";
    setConfirmState({
      title: "Eliminar grupo",
      message: `¿Eliminar el grupo "${label}" y TODOS sus productos?`,
      confirmText: "Eliminar todo",
      onConfirm: async () => {
        await adminDeleteGroup({ branch: branchId, categoryId: cat.id, name: group.name || "" });
        await load();
      },
    });
  }

  async function handleUploadImage(file) {
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
      setError("Formato de imagen no soportado (PNG, JPG, WEBP, GIF)");
      return;
    }
    if (file.size > 1.5 * 1024 * 1024) {
      setError("La imagen supera 1.5 MB");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await adminUploadImage(dataUrl);
      setForm((f) => ({ ...f, image: res.url }));
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // Las categorías del formulario salen de la sucursal del FORMULARIO (form.branch),
  // no de la sucursal seleccionada en el filtro superior: si cambia el filtro
  // mientras el modal está abierto no se ofrecen categorías de otra sucursal.
  const formBranch = branches.find((b) => b.branchId === form.branch) || null;
  const availableCategories = formBranch?.categories || [];

  // Búsqueda por nombre de producto (dentro de la sucursal seleccionada)
  const q = query.trim().toLowerCase();
  const visibleCategories = useMemo(() => {
    if (!q) return branch?.categories || [];
    const cats = [];
    for (const cat of branch?.categories || []) {
      const groups = cat.groups
        .map((g) => ({ ...g, products: g.products.filter((p) => p.name.toLowerCase().includes(q)) }))
        .filter((g) => g.products.length > 0);
      if (groups.length) cats.push({ ...cat, groups });
    }
    return cats;
  }, [branch, q]);

  const resultCount = visibleCategories.reduce((acc, cat) => acc + cat.groups.reduce((a, g) => a + g.products.length, 0), 0);

  return (
    <div className="admin-products">
      <div className="admin-products__toolbar">
        <div className="admin-products__controls">
          <Dropdown
            value={branchId}
            onChange={setBranchId}
            options={BRANCH_LIST.map((b) => ({ value: b.id, label: b.name }))}
          />
          <input
            type="search"
            className="admin-search"
            placeholder="🔎 Buscar producto…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn btn--ghost btn--sm" onClick={openAddCategory}>➕ Categoría</button>
        </div>
        <button className="btn btn--primary btn--sm" onClick={() => openAdd()}>➕ Agregar producto</button>
      </div>

      {error && <div className="form-error">{error}</div>}

      {loading && !branches.length ? (
        <p className="hint">Cargando productos…</p>
      ) : !branch ? (
        <div className="admin-empty">No hay menú para esta sucursal.</div>
      ) : (
        <div className="admin-products__list">
          {q && (
            <p className="hint">
              {resultCount} resultado{resultCount !== 1 ? "s" : ""} para «{query.trim()}»
            </p>
          )}
          {visibleCategories.map((cat) => (
            <section className="admin-cat" key={cat.id}>
              <div
                className={`admin-cat__head ${dragCatId === (cat.rowId ?? cat.id) ? "is-dragging" : ""} ${overCatId === (cat.rowId ?? cat.id) ? "is-drop-target" : ""}`}
                draggable={!q}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", String(cat.rowId ?? cat.id));
                  e.dataTransfer.effectAllowed = "move";
                  setDragCatId(cat.rowId ?? cat.id);
                }}
                onDragOver={(e) => {
                  if (dragCatId && dragCatId !== (cat.rowId ?? cat.id)) {
                    e.preventDefault();
                    setOverCatId(cat.rowId ?? cat.id);
                  }
                }}
                onDragLeave={() => setOverCatId((cur) => (cur === (cat.rowId ?? cat.id) ? null : cur))}
                onDrop={(e) => {
                  e.preventDefault();
                  handleCategoryDrop(dragCatId, cat.rowId ?? cat.id, visibleCategories);
                }}
                onDragEnd={() => {
                  setDragCatId(null);
                  setOverCatId(null);
                }}
              >
                <h4 className="admin-cat__name">{cat.name}</h4>
                <div className="admin-cat__actions">
                  <Tooltip label="Mover arriba">
                    <button className="btn btn--ghost btn--sm" onClick={() => handleMoveCategory(cat, "up")} aria-label={`Mover categoría ${cat.name} arriba`}>↑</button>
                  </Tooltip>
                  <Tooltip label="Mover abajo">
                    <button className="btn btn--ghost btn--sm" onClick={() => handleMoveCategory(cat, "down")} aria-label={`Mover categoría ${cat.name} abajo`}>↓</button>
                  </Tooltip>
                  <button className="btn btn--ghost btn--sm" onClick={() => openRenameCategory(cat)} aria-label={`Renombrar categoría ${cat.name}`}>✏️</button>
                  <button className="btn btn--danger btn--sm" onClick={() => handleDeleteCategory(cat)} aria-label={`Eliminar categoría ${cat.name}`}>🗑️</button>
                </div>
              </div>
              {cat.groups.map((group, gi) => (
                <div className="admin-group" key={gi}>
                  <div className="admin-group__head">
                    <span className="admin-group__name">{group.name || "Sin grupo"}</span>
                    {group.name && (
                      <span className="admin-group__actions">
                        <button className="btn btn--ghost btn--sm" onClick={() => openRenameGroup(group, cat)}>✏️ Renombrar</button>
                        <button className="btn btn--danger btn--sm" onClick={() => handleDeleteGroup(group, cat)}>🗑️ Eliminar grupo</button>
                      </span>
                    )}
                  </div>
                  {group.products.map((p) => (
                    <div
                    className={`admin-product ${p.available ? "" : "is-hidden"} ${dragProductId === p.id ? "is-dragging" : ""} ${overProductId === p.id ? "is-drop-target" : ""}`}
                    key={p.id}
                    draggable={!q}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", String(p.id));
                      e.dataTransfer.effectAllowed = "move";
                      setDragProductId(p.id);
                    }}
                    onDragOver={(e) => {
                      if (dragProductId && dragProductId !== p.id) {
                        e.preventDefault();
                        setOverProductId(p.id);
                      }
                    }}
                    onDragLeave={() => setOverProductId((cur) => (cur === p.id ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault();
                      handleProductDrop(dragProductId, p.id, group.products);
                    }}
                    onDragEnd={() => {
                      setDragProductId(null);
                      setOverProductId(null);
                    }}
                  >
                      <div className="admin-product__info">
                        <div className="admin-product__title">
                          <strong>{p.name}</strong>
                          <span className="admin-product__price">{formatPrice(p.price)}</span>
                        </div>
                        <span className={`badge ${p.available ? "badge--pay-ok" : ""}`}>
                          {p.available ? "Visible" : "Oculto"}
                        </span>
                      </div>
                      <div className="admin-product__actions">
                        <Tooltip label="Mover arriba">
                          <button className="btn btn--ghost btn--sm" onClick={() => handleMoveProduct(p, "up")} aria-label={`Mover ${p.name} arriba`}>↑</button>
                        </Tooltip>
                        <Tooltip label="Mover abajo">
                          <button className="btn btn--ghost btn--sm" onClick={() => handleMoveProduct(p, "down")} aria-label={`Mover ${p.name} abajo`}>↓</button>
                        </Tooltip>
                        <button className="btn btn--ghost btn--sm" onClick={() => openEdit(p)}>✏️ Editar</button>
                        <button
                          className="btn btn--ghost btn--sm"
                          onClick={() => handleToggle(p)}
                          title={p.available ? "Ocultar del menú" : "Mostrar en el menú"}
                        >
                          {p.available ? "🙈 Ocultar" : "👁️ Mostrar"}
                        </button>
                        <button className="btn btn--danger btn--sm" onClick={() => handleDelete(p)}>🗑️ Eliminar</button>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          ))}
          {visibleCategories.length === 0 && (
            <div className="admin-empty">
              {q
                ? `No se encontró ningún producto con «${query.trim()}».`
                : "Esta sucursal no tiene productos todavía."}
            </div>
          )}
        </div>
      )}

      {catPrompt && (
        <PromptModal
          title={
            catPrompt.mode === "create"
              ? "Nueva categoría"
              : catPrompt.mode === "category"
                ? "Renombrar categoría"
                : "Renombrar grupo"
          }
          label={catPrompt.mode === "group" ? "Nombre del grupo" : "Nombre de la categoría"}
          placeholder={catPrompt.mode === "create" ? "Ej: Platos calientes" : ""}
          initial={
            catPrompt.mode === "create"
              ? ""
              : catPrompt.mode === "category"
                ? catPrompt.cat.name
                : catPrompt.group.name || ""
          }
          confirmText={catPrompt.mode === "create" ? "Crear" : "Guardar cambios"}
          emptyError={`Escribí el nombre ${catPrompt.mode === "group" ? "del grupo" : "de la categoría"}`}
          maxLength={120}
          onSubmit={async (name) => {
            await submitCategoryPrompt(name);
            await load();
          }}
          onClose={() => setCatPrompt(null)}
        />
      )}

      {confirmState && (
        <ConfirmModal
          variant="danger"
          title={confirmState.title}
          message={confirmState.message}
          confirmText={confirmState.confirmText}
          onConfirm={confirmState.onConfirm}
          onClose={() => setConfirmState(null)}
        />
      )}

      {editing && (
        <div className="modal-backdrop" onClick={closeModal}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="product-modal-title"
            ref={dialogRef}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal__head">
              <h3 id="product-modal-title">{editing?.product ? "Editar producto" : "Nuevo producto"}</h3>
              <button className="modal__close" onClick={closeModal} aria-label="Cerrar">✕</button>
            </div>
            <form className="modal__body" onSubmit={handleSave}>
              <div className="field">
                <label htmlFor="prod-branch">Sucursal</label>
                <Dropdown
                  value={form.branch}
                  onChange={(v) => setForm({ ...form, branch: v })}
                  options={BRANCH_LIST.map((b) => ({ value: b.id, label: b.name }))}
                  disabled={!!editing?.product}
                  ariaLabel="Sucursal del producto"
                />
              </div>

              <div className="field">
                <label htmlFor="prod-cat">Categoría</label>
                {newCategory ? (
                  <input
                    id="prod-cat"
                    type="text"
                    placeholder="Nombre de la nueva categoría"
                    value={form.categoryName}
                    onChange={(e) => setForm({ ...form, categoryName: e.target.value, categoryId: slugify(e.target.value) })}
                  />
                ) : (
                  <Dropdown
                    value={form.categoryId}
                    onChange={(v) => {
                      const cat = availableCategories.find((c) => c.id === v);
                      setForm({ ...form, categoryId: v, categoryName: cat?.name || "" });
                    }}
                    options={availableCategories.map((c) => ({ value: c.id, label: c.name }))}
                    ariaLabel="Categoría del producto"
                  />
                )}
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setNewCategory((v) => !v)}
                >
                  {newCategory ? "Usar categoría existente" : "➕ Nueva categoría"}
                </button>
              </div>

              <div className="field">
                <label htmlFor="prod-group">Grupo (subcategoría, opcional)</label>
                <input
                  id="prod-group"
                  type="text"
                  placeholder="Ej: Chow Fan (Arroz)"
                  value={form.groupName}
                  onChange={(e) => setForm({ ...form, groupName: e.target.value })}
                />
              </div>

              <div className="field">
                <label htmlFor="prod-name">Nombre</label>
                <input
                  id="prod-name"
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>

              <div className="field">
                <label htmlFor="prod-price">Precio (ARS)</label>
                <input
                  id="prod-price"
                  type="number"
                  min="0"
                  step="100"
                  required
                  value={form.price}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                />
              </div>

              <div className="field">
                <label htmlFor="prod-desc">Descripción</label>
                <textarea
                  id="prod-desc"
                  rows="3"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>

              <div className="field">
                <label>Imagen</label>
                <div className="admin-product__image">
                  {form.image ? (
                    <>
                      <img src={form.image} alt="" className="admin-product__preview" />
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setForm({ ...form, image: "" })}
                      >
                        Quitar imagen
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => fileRef.current?.click()}
                      disabled={uploading}
                    >
                      {uploading ? "Subiendo…" : "📷 Subir imagen"}
                    </button>
                  )}
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    hidden
                    onChange={(e) => handleUploadImage(e.target.files?.[0])}
                  />
                </div>
              </div>

              {error && <div className="form-error">{error}</div>}

              <div className="modal__footer">
                <button type="submit" className="btn btn--primary btn--block">
                  {editing?.product ? "Guardar cambios" : "Agregar producto"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}