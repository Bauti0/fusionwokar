import { useEffect, useState } from "react";
import { BRAND, BRANCH_LIST, phonePlaceholderFor } from "../data/branches.js";
import { SOCIAL } from "../data/social.js";
import { isValidPhone } from "../utils/validation.js";
import { isNowOpen, closedLabel, arClockLabel } from "../utils/schedule.js";
import { getPause } from "../api.js";
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
  // Estado de pausa de pedidos por sucursal ({ <id>: { paused, until, message } }).
  // Se pide SOLO al mostrar la portada (endpoint público chico), para avisar
  // "Pausado" antes de que el cliente entre al menú. Si falla, no se muestra
  // nada: el menú sigue avisando igual.
  const [pauses, setPauses] = useState({});
  useEffect(() => {
    let alive = true;
    getPause()
      .then((d) => alive && setPauses(d.branches || {}))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

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
      // El ejemplo va por sucursal: antes estaba fijo en el de Necochea.
      setError(`El celular no parece válido. ${phonePlaceholderFor(branchId)}.`);
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
            {SOCIAL.instagram && (
              <a
                href={SOCIAL.instagram}
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Instagram de Fusión Wok"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  width="24"
                  height="24"
                  fill="currentColor"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M7.75 2h8.5A5.75 5.75 0 0122 7.75v8.5A5.75 5.75 0 0116.25 22h-8.5A5.75 5.75 0 012 16.25v-8.5A5.75 5.75 0 017.75 2zm0 1.5A4.25 4.25 0 003.5 7.75v8.5A4.25 4.25 0 007.75 20.5h8.5A4.25 4.25 0 0020.5 16.25v-8.5A4.25 4.25 0 0016.25 3.5h-8.5zm8.75 2a1 1 0 110 2 1 1 0 010-2zm-4.5 1.25a4.75 4.75 0 110 9.5 4.75 4.75 0 010-9.5zm0 1.5a3.25 3.25 0 100 6.5 3.25 3.25 0 000-6.5z" />
                </svg>
              </a>
            )}
            {SOCIAL.tiktok && (
              <a
                href={SOCIAL.tiktok}
                target="_blank"
                rel="noreferrer noopener"
                aria-label="TikTok de Fusión Wok"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 16 16"
                  width="24"
                  height="24"
                  fill="currentColor"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M9 0h1.98c.144.715.54 1.617 1.235 2.512C12.895 3.389 13.797 4 15 4v2c-1.753 0-3.07-.814-4-1.829V11a5 5 0 1 1-5-5v2a3 3 0 1 0 3 3z" />
                </svg>
              </a>
            )}
            {SOCIAL.linktree && (
              <a
                href={SOCIAL.linktree}
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Linktree de Fusión Wok"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 256 256"
                  width="24"
                  height="24"
                  fill="currentColor"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M136,160v72a8,8,0,0,1-16,0V160a8,8,0,0,1,16,0Zm72-64H147.31l42.35-42.34a8,8,0,0,0-11.32-11.32L136,84.69V24a8,8,0,0,0-16,0V84.69L77.66,42.34A8,8,0,0,0,66.34,53.66L108.69,96H48a8,8,0,0,0,0,16h60.69L66.34,154.34a8,8,0,0,0,11.32,11.32L128,115.31l50.34,50.35a8,8,0,0,0,11.32-11.32L147.31,112H208a8,8,0,0,0,0-16Z" />
                </svg>
              </a>
            )}
          </div>
        </div>
      </div>

      <div className="landing__card">
        <form onSubmit={handleStart}>
          <h2>Arrancá tu pedido</h2>
          <p className="step">
            {customer && !editData
              ? "Elegí tu local y confirmamos con tus datos guardados."
              : "Sin contraseñas. Dejá tus datos y listo."}
          </p>

          <div className="field">
            <label className="landing__branchLabel">Elegí tu sucursal</label>
            <div className="branch-select">
              {BRANCH_LIST.map((b) => {
                const pause = pauses[b.id];
                const paused = !!pause?.paused;
                // El estado por tarjeta: "Pausado" (con la hora de vuelta si la
                // hay) reemplaza a abierto/cerrado, y el puntito queda gris: la
                // pausa no es ni abierto ni cerrado, es "no estamos tomando
                // pedidos por ahora".
                const statusText = paused
                  ? `Pausado${pause.until ? ` · Volvemos a las ${arClockLabel(pause.until)}` : ""}`
                  : isNowOpen(b.id)
                    ? "Abierto ahora"
                    : (closedLabel(b.id) || "Cerrado hoy");
                return (
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
                    <span className={`branch-status ${!paused && isNowOpen(b.id) ? "is-open" : ""}`}>
                      <span className="branch-status__dot" aria-hidden="true" />
                      {statusText}
                    </span>
                  </span>
                </button>
                );
              })}
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
                  placeholder={phonePlaceholderFor(branchId)}
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
