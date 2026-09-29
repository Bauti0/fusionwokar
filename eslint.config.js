import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

const RULES = {
  // Deliberadamente en "warn" y no en "error": el proyecto entra al lint
  // con deuda previa. Con "error" la primera corrida falla y el gate queda
  // muerto el día uno. Se bajan a "error" cuando la deuda se haya limpiado.
  "no-unused-vars": "warn",
  // no-undef SI va en "error": un identificador no definido siempre es un
  // ReferenceError en runtime, nunca una cuestion de estilo. La primera
  // corrida de este lint encontro dos (AdminSales.jsx y useDialogA11y.js),
  // ambos rompian la app en runtime y ninguno se veia leyendo el codigo.
  "no-undef": "error",
  // El codebase usa `catch {}` vacío a propósito en ~15 lugares.
  "no-empty": ["error", { allowEmptyCatch: true }],
  // Deuda preexistente, visible pero no bloqueante.
  "no-useless-assignment": "warn",
  "no-misleading-character-class": "warn",
};

// eslint-plugin-react-hooks@7 trae un preset recomendado con reglas nuevas
// (las del React Compiler) que marcan patrones legitimos y muy usados en este
// codigo: setState al montar para pedir datos, refs sincronizadas en render,
// Date.now() para calcular el minimo de un datepicker. Puestas en "error"
// rompen el gate el primer dia sin senalar un bug.
//
// Se eligio a mano en vez de usar ...reactHooks.configs.recommended.rules:
//   rules-of-hooks  -> "error": romper las reglas de hooks SI es un bug.
//                      Hoy hay 0 violaciones, asi que el gate sigue verde.
//   exhaustive-deps -> "warn": pillo closures rancios, pero hay varios
//                      intencionales (ver los eslint-disable-line del repo).
//   el resto         -> apagadas por ahora. Se pueden ir encendiendo de a
//                      una conforme se limpie la deuda.
const REACT_HOOKS_RULES = {
  "react-hooks/rules-of-hooks": "error",
  "react-hooks/exhaustive-deps": "warn",
  "react-hooks/set-state-in-effect": "off",
  "react-hooks/refs": "off",
  "react-hooks/purity": "off",
};

export default [
  {
    ignores: ["dist/**", "node_modules/**", "public/**"],
  },

  js.configs.recommended,

  // ---- Cliente (React) -------------------------------------------------
  {
    files: ["src/**/*.{js,jsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...RULES,
      ...REACT_HOOKS_RULES,
    },
  },

  // ---- Servidor (Node) -------------------------------------------------
  {
    files: ["server/**/*.js", "server/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...RULES,
      // El servidor loguea a propósito: es el único canal de observabilidad.
      "no-console": "off",
    },
  },

  // ---- Tests -----------------------------------------------------------
  {
    files: ["test/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: { ...RULES, "no-console": "off" },
  },

  // ---- Config ----------------------------------------------------------
  {
    files: ["*.config.js", "*.config.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: { ...RULES, "no-console": "off" },
  },
];
