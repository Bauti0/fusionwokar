import { useState } from "react";
import { BRAND, BRANCHES, BRANCH_LIST } from "../data/branches.js";
import { isValidPhone } from "../utils/validation.js";
import { IconBowlSteam, IconChopsticks, HeroMotif } from "./ui/icons.jsx";

// ============================================================
// Portada / Landing
// 1) Elegir sucursal  2) Nombre + celular  3) Entrar al menú
// Si ya hay datos guardados del cliente no se vuelven a pedir
// (solo se muestran con opción "Cambiar").
// También permite "Solo ver menú" sin registrarse.
// ============================================================
export default function Landing({ onStart, initialBranch, customer }) {
  const [branchId, setBranchId] = useState(initialBranch || "");
  const [name, setName] = useState(customer?.name || "");
  const [phone, setPhone] = useState(customer?.phone || "");
  const [editData, setEditData] = useState(!customer);
  const [error, setError] = useState("");

  function handleStart(e) {
    e.preventDefault();
    if (!branchId) {
      setError("Elegí la sucursal para continuar.");
      return;
    }
    const usingSaved = customer && !editData;
    const finalName = usingSaved ? customer.name : name.trim();
    const finalPhone = usingSaved ? customer.phone : phone.trim();
    if (!finalName || !finalPhone) {
      setError("Completá tu nombre y tu celular para arrancar el pedido.");
      return;
    }
    if (!isValidPhone(finalPhone)) {
      setError("El celular no parece válido. Ej: 2262 555555.");
      return;
    }
    onStart({ branchId, customer: { name: finalName, phone: finalPhone } });
  }

  function handleBrowseOnly(e) {
    e.preventDefault();
    if (!branchId) {
      setError("Elegí la sucursal para ver su menú.");
      return;
    }
    onStart({ branchId, customer: null, browseOnly: true });
  }

  return (
    <div className="landing">
      <div className="landing__hero">
        <HeroMotif className="landing__motif" />
        <div className="landing__heroInner">
          <p className="landing__kicker">Pedí directo, sin intermediarios</p>
          <div className="landing__logo">
            <span className="landing__logoRing" aria-hidden="true" />
            <img src={BRAND.logo} alt={`Logo ${BRAND.name}`} />
          </div>
          <h1 className="landing__title">
            Fusión <span>Wok</span>
          </h1>
          <p className="landing__slogan">{BRAND.slogan}</p>
          <p className="landing__specialties">
            {BRAND.specialties.split(" · ").map((item) => (
              <span key={item} className="landing__chip">{item}</span>
            ))}
          </p>
          <div className="landing__socials">
            <a href="https://instagram.com/fusionwok.ar" target="_blank" rel="noreferrer">
              Instagram
            </a>
            <a href="https://www.tiktok.com/@fusionwok.ar" target="_blank" rel="noreferrer">
              TikTok
            </a>
            <a href={BRAND.linktree} target="_blank" rel="noreferrer">
              Linktree
            </a>
          </div>
        </div>
      </div>

      <div className="landing__card">
        <form onSubmit={handleStart}>
          <h2>Arrancá tu pedido</h2>
          <p className="step">
            {customer && !editData
              ? "Elegí tu local y confirmamos con tus datos guardados."
              : "Sin contraseñas. Solo elegí tu local y dejá tus datos."}
          </p>

          <div className="field">
            <label>Sucursal</label>
            <div className="branch-select">
              {BRANCH_LIST.map((b) => (
                <button
                  type="button"
                  key={b.id}
                  className={`branch-option ${branchId === b.id ? "branch-option--active" : ""}`}
                  style={{ "--branch-accent": b.accentColor }}
                  onClick={() => setBranchId(b.id)}
                >
                  <IconBowlSteam className="branch-icon" />
                  <span className="branch-copy">
                    <span className="branch-name">{b.name}</span>
                    <span className="branch-meta">{b.address}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          {customer && !editData ? (
            <div className="field">
              <label>Tus datos</label>
              <div className="landing__saved">
                <span>
                  <strong>{customer.name}</strong> · {customer.phone}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setEditData(true)}
                >
                  Cambiar
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="field">
                <label htmlFor="landing-name">Nombre</label>
                <input
                  id="landing-name"
                  type="text"
                  placeholder="Tu nombre"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="field">
                <label htmlFor="landing-phone">Celular</label>
                <input
                  id="landing-phone"
                  type="tel"
                  inputMode="tel"
                  placeholder={branchId && BRANCHES[branchId]?.areaCode ? `Ej: ${BRANCHES[branchId].areaCode} 555555` : "Ej: 2262 555555"}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
            </>
          )}

          {error && <div className="form-error">{error}</div>}

          <div className="landing__actions">
            <button type="submit" className="btn btn--primary btn--block">
              Empezar mi pedido
            </button>
            <button type="button" className="btn btn--ghost btn--block" onClick={handleBrowseOnly}>
              Solo ver menú
            </button>
          </div>

          <p className="landing__trust">
            <span>🔒 Pagás seguro</span>
            <span>✅ Confirmás al instante</span>
            <span>🛵 Seguís tu pedido en vivo</span>
          </p>

          <p className="landing__footer">
            <IconChopsticks className="landing__footerIcon" />
            Delivery y take away en {BRANCH_LIST.map((b) => b.name).join(" y ")}
          </p>
        </form>
      </div>
    </div>
  );
}
