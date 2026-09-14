// ============================================================
// Switch — reemplazo propio de <input type="checkbox"> como
// toggle, con la estética de píldora de la marca.
//
// Uso:
//   <Switch
//     checked={includePending}
//     onChange={setIncludePending}
//     label="Incluir MP sin pagar"
//   />
// ============================================================
export default function Switch({ checked, onChange, label, id }) {
  return (
    <label className="switch" htmlFor={id}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        id={id}
        className={`switch__track ${checked ? "switch__track--on" : ""}`}
        onClick={() => onChange?.(!checked)}
      >
        <span className="switch__thumb" />
      </button>
      <span className="switch__label">{label}</span>
    </label>
  );
}
