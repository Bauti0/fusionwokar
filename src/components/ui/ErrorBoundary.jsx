// ============================================================
// ErrorBoundary — Componente de clase para atrapar errores de React
// Props:
//   - fallback: ReactNode | (error, reset) => ReactNode
//   - onError: (error, errorInfo) => void  (además del console.error interno)
//   - resetKeys: array de valores; cuando cambian, el boundary se resetea solo
// ============================================================
import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // Siempre logueamos para no esconder fallas
    console.error("ErrorBoundary caught:", error, errorInfo?.componentStack);
    this.setState({ errorInfo });
    // Callback opcional del padre
    if (this.props.onError) {
      try {
        this.props.onError(error, errorInfo);
      } catch (e) {
        console.error("ErrorBoundary onError callback failed:", e);
      }
    }
  }

  reset() {
    this.setState({ hasError: false, error: null, errorInfo: null });
  }

  // Reseteo automático cuando cambian las resetKeys (ej. la ruta)
  componentDidUpdate(prevProps) {
    if (this.props.resetKeys && prevProps.resetKeys) {
      const changed = this.props.resetKeys.some(
        (key, i) => key !== prevProps.resetKeys[i]
      );
      if (changed && this.state.hasError) {
        this.reset();
      }
    }
  }

  render() {
    const { hasError, error, errorInfo } = this.state;
    const { fallback, children } = this.props;

    if (hasError) {
      // Si fallback es una función, la llamamos con error y reset
      if (typeof fallback === "function") {
        return fallback(error, this.reset, errorInfo);
      }
      return fallback;
    }
    return children;
  }
}

// Hook auxiliar para usar en componentes funcionales (si se necesita)
// No es obligatorio, pero puede ser útil para resetear desde dentro
export function useErrorReset() {
  // Se usa con un ref al ErrorBoundary padre si hace falta
  return () => {};
}