import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isOpenAtTime, nextOpening, toWallclock, outsideHoursMessage } from "../src/utils/schedule.js";
import { BRANCHES } from "../src/data/branches.js";

// Todas las fechas se construyen con el constructor local
// `new Date(y, m, d, h, min)`. Eso hace que los tests sean independientes de
// la zona horaria del runtime: prueban la aritmetica de ventanas, no la
// maquina donde corren. El caso "el server corre en UTC y el cliente en
// Argentina" lo cubre toWallclock, que recibe la zona explicita.
//
// Ancla: 2026-01-04 es domingo (getDay() === 0).
//   dia 0 = domingo ... dia 4 = jueves, dia 5 = viernes, dia 6 = sabado
const at = (day, hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2026, 0, 4 + day, h, m, 0, 0);
};

describe("ancla de fechas", () => {
  it("2026-01-04 es domingo", () => {
    assert.equal(at(0, "12:00").getDay(), 0);
  });

  it("day 5 es viernes", () => {
    assert.equal(at(5, "12:00").getDay(), 5);
  });
});

// Necochea abre todos los dias 11:00-15:00 y 19:30-23:30.
describe("isOpenAtTime — necochea (todos los dias)", () => {
  it("abre a las 12:00", () => {
    assert.equal(isOpenAtTime("necochea", at(3, "12:00")), true);
  });

  it("el inicio de ventana es inclusivo", () => {
    assert.equal(isOpenAtTime("necochea", at(3, "11:00")), true);
  });

  it("un minuto antes de abrir esta cerrado", () => {
    assert.equal(isOpenAtTime("necochea", at(3, "10:59")), false);
  });

  it("el cierre de ventana es exclusivo: 15:00 esta cerrado", () => {
    assert.equal(isOpenAtTime("necochea", at(3, "15:00")), false);
  });

  it("un minuto antes de cerrar sigue abierto", () => {
    assert.equal(isOpenAtTime("necochea", at(3, "14:59")), true);
  });

  it("abre la segunda ventana a las 19:30 exacto", () => {
    assert.equal(isOpenAtTime("necochea", at(3, "19:30")), true);
  });

  it("a las 23:30 ya esta cerrado", () => {
    assert.equal(isOpenAtTime("necochea", at(3, "23:30")), false);
  });

  it("a las 23:29 todavia esta abierto", () => {
    assert.equal(isOpenAtTime("necochea", at(3, "23:29")), true);
  });

  it("el almuerzo y la cena no se tocan: 18:00 esta cerrado", () => {
    assert.equal(isOpenAtTime("necochea", at(3, "18:00")), false);
  });
});

// Tandil: dom-jue 11:30-15:30 y 19:00-23:00; vie-sab 11:30-15:30 y 19:30-23:30.
describe("isOpenAtTime — tandil (dias de semana distintos)", () => {
  it("jueves a las 19:15 abre con la ventana de dia de semana", () => {
    assert.equal(isOpenAtTime("tandil", at(4, "19:15")), true);
  });

  it("jueves a las 19:45 sigue abierto: la ventana de dia de semana llega hasta las 23:00", () => {
    // Ojo con este dato: el jueves de Tandil abre 19:00-23:00, no 19:30-23:30.
    // El unico momento en que jueves y viernes se distinguen es ANTES de las 19:30.
    assert.equal(isOpenAtTime("tandil", at(4, "19:45")), true);
  });

  it("jueves a las 23:00 cerro la ventana de dia de semana", () => {
    assert.equal(isOpenAtTime("tandil", at(4, "23:00")), false);
  });

  it("viernes a las 19:15 todavia esta cerrado: la ventana arranca 19:30", () => {
    assert.equal(isOpenAtTime("tandil", at(5, "19:15")), false);
  });

  it("viernes a las 19:45 abre con la ventana de fin de semana", () => {
    assert.equal(isOpenAtTime("tandil", at(5, "19:45")), true);
  });

  it("sabado a las 19:45 abre con la ventana de fin de semana", () => {
    assert.equal(isOpenAtTime("tandil", at(6, "19:45")), true);
  });

  it("domingo a las 11:45 abre", () => {
    assert.equal(isOpenAtTime("tandil", at(0, "11:45")), true);
  });

  it("a las 15:30 cerra el almuerzo", () => {
    assert.equal(isOpenAtTime("tandil", at(0, "15:30")), false);
  });
});

describe("isOpenAtTime — sucursales sin ventanas", () => {
  it("una sucursal desconocida no bloquea el checkout", () => {
    // Sin ventanas definidas no se bloquea: el server no debe frenar un pedido
    // de una sucursal que todavia no cargo su horario.
    assert.equal(isOpenAtTime("no-existe", at(3, "03:00")), true);
  });

  it("no explota con una clave heredada del prototipo", () => {
    // MENUS/BRANCHES son object literals: "constructor" y "toString" son
    // truthy. La funcion tiene que seguir devolviendo algo, no tirar.
    assert.equal(isOpenAtTime("constructor", at(3, "03:00")), true);
    assert.equal(isOpenAtTime("toString", at(3, "03:00")), true);
  });
});

describe("nextOpening", () => {
  it("devuelve null para una sucursal sin ventanas", () => {
    assert.equal(nextOpening("no-existe", at(3, "12:00")), null);
  });

  it("si la ventana de hoy todavia no empezo, devuelve la de hoy", () => {
    // Domingo 10:00 en necochea: la ventana arranca a las 11:00 del mismo dia.
    const next = nextOpening("necochea", at(0, "10:00"));
    assert.notEqual(next, null);
    assert.equal(next.getDay(), 0, "deberia ser el mismo dia");
    assert.equal(next.getHours(), 11);
    assert.equal(next.getMinutes(), 0);
  });

  it("si la ventana de hoy ya empezo, devuelve la siguiente ventana de HOY si todavia no paso", () => {
    // Domingo 12:00 en necochea: estamos dentro de la ventana del almuerzo, pero
    // la de la noche (19:30) todavia viene. La proxima apertura es HOY, no manana:
    // el local abre de noche hoy y el cartel deberia decir eso.
    const next = nextOpening("necochea", at(0, "12:00"));
    assert.notEqual(next, null);
    assert.equal(next.getDay(), 0, "deberia ser hoy");
    assert.equal(next.getHours(), 19);
    assert.equal(next.getMinutes(), 30);
  });

  it("cuando no queda ninguna ventana hoy, salta al dia siguiente", () => {
    // Domingo 23:45: la ventana de noche cerro a las 23:30. No hay nada mas
    // hoy, asi que la proxima apertura es la del lunes a las 11:00.
    const next = nextOpening("necochea", at(0, "23:45"));
    assert.notEqual(next, null);
    assert.equal(next.getDay(), 1);
    assert.equal(next.getHours(), 11);
  });

  it("siempre devuelve un instante futuro", () => {
    for (const day of [0, 1, 2, 3, 4, 5, 6]) {
      for (const hhmm of ["03:00", "10:00", "12:00", "18:00", "23:45"]) {
        const from = at(day, hhmm);
        const next = nextOpening("necochea", from);
        assert.ok(next > from, `necochea dia=${day} ${hhmm} devolvio algo no futuro`);
      }
    }
  });

  it("devuelve una hora de apertura valida para tandil", () => {
    const next = nextOpening("tandil", at(3, "12:00"));
    assert.notEqual(next, null);
    assert.ok(isOpenAtTime("tandil", next), "la proxima apertura deberia caer dentro de una ventana");
  });
});

// ---------------------------------------------------------------------
// BUG-04: el mensaje de "elegí otra fecha" que devuelve el server por
// una fecha programada fuera de horario estaba escrito a mano y
// hardcodeaba la cena de Tandil como si fuera todos los días 19:00-23:00.
// El bug era peor que un texto feo: el servidor SI rechazaba bien el
// viernes a las 19:15 (la ventana de fin de semana arranca 19:30), y
// después le decía al cliente "podés pedir de 19:00 a 23:00". O sea,
// el mensaje contradecía el rechazo que acababa de hacer. El texto sale
// ahora de openWindows, así que no puede volver a mentir.
// ---------------------------------------------------------------------
describe("outsideHoursMessage — el texto sale de openWindows", () => {
  it("necochea dice los horarios de siempre, todos los días", () => {
    assert.equal(
      outsideHoursMessage("necochea"),
      "Elegí una fecha y hora dentro de nuestros horarios. Podemos recibir tu pedido todos los días 11:00 a 15:00 y 19:30 a 23:30."
    );
  });

  it("tandil distingue la cena de día de semana de la de fin de semana", () => {
    assert.equal(
      outsideHoursMessage("tandil"),
      "Elegí una fecha y hora dentro de nuestros horarios. Podemos recibir tu pedido Dom–Jue 11:30 a 15:30 y 19:00 a 23:00 · Vie y Sáb 11:30 a 15:30 y 19:30 a 23:30."
    );
  });

  it("tandil NO dice 'todos los días': la cena cambia según el día", () => {
    // Si algún día el mensaje vuelve a decir "todos los días", el cliente
    // vuelve a recibir una ventana que no corresponde al día que eligió.
    assert.doesNotMatch(outsideHoursMessage("tandil"), /todos los días/);
  });

  it("tandil muestra las dos cenas: la de día de semana y la de fin de semana", () => {
    const msg = outsideHoursMessage("tandil");
    assert.match(msg, /Dom–Jue/, "avisa el tramo dom-jue");
    assert.match(msg, /19:00 a 23:00/, "cena de día de semana");
    assert.match(msg, /Vie y Sáb/, "avisa el tramo vie-sáb");
    assert.match(msg, /19:30 a 23:30/, "cena de fin de semana");
  });

  it("el texto menciona TODAS las ventanas de openWindows, sin inventar ninguna", () => {
    // El invariante que ata el mensaje a la fuente de verdad: si alguien
    // agrega, cambia o saca una ventana en branches.js, el texto la sigue.
    for (const branchId of Object.keys(BRANCHES)) {
      const msg = outsideHoursMessage(branchId);
      for (const w of BRANCHES[branchId].openWindows) {
        assert.ok(
          msg.includes(`${w.from} a ${w.to}`),
          `${branchId}: el mensaje no menciona la ventana ${w.from} a ${w.to}`
        );
      }
    }
  });

  it("tandil abre los 7 dias pero con cena distinta: el texto no los agrupa", () => {
    // Este es el caso exacto del BUG-04 y merece quedar escrito: Tandil abre
    // TODOS los dias (los days de sus ventanas cubren 0..6), asi que un
    // mensaje generado "con la logica de Necochea" digamos "todos los dias
    // 11:30 a 15:30 y 19:00 a 23:30" y estaria mal en viernes y sabado. Lo
    // que separa a Tandil de Necochea no es la cobertura semanal sino que la
    // cena se corre: por eso el texto NO puede decir "todos los dias".
    const days = new Set(BRANCHES.tandil.openWindows.flatMap((w) => w.days));
    assert.strictEqual(days.size, 7, "tandil abre los 7 dias: la cobertura no es lo que cambia");
    const cenas = BRANCHES.tandil.openWindows.filter((w) => w.from > "15:00").map((w) => `${w.from}-${w.to}`);
    assert.deepStrictEqual(cenas, ["19:00-23:00", "19:30-23:30"], "las dos cenas son distintas");
    assert.doesNotMatch(outsideHoursMessage("tandil"), /todos los días/);
  });

  it("una sucursal sin ventanas no rompe ni inventa horarios", () => {
    const msg = outsideHoursMessage("no-existe");
    assert.equal(msg, "Elegí una fecha y hora dentro de nuestros horarios.");
    assert.doesNotMatch(msg, /\d{2}:\d{2}/, "no puede inventar un horario");
  });
});

describe("toWallclock", () => {
  // Argentina es UTC-3 todo el ano (no aplica horario de verano).
  it("convierte un instante UTC a la hora de Buenos Aires", () => {
    const local = toWallclock(new Date("2026-01-15T12:00:00Z"));
    assert.equal(local.getHours(), 9);
    assert.equal(local.getMinutes(), 0);
    assert.equal(local.getDate(), 15);
  });

  it("la medianoche de Buenos Aires no se corre de dia", () => {
    // 03:00 UTC = 00:00 en Buenos Aires. Intl con hour12:false puede devolver
    // "24" en vez de "0" segun la version de ICU; el codigo lo normaliza.
    const local = toWallclock(new Date("2026-01-15T03:00:00Z"));
    assert.equal(local.getHours(), 0);
    assert.equal(local.getMinutes(), 0);
  });

  it("respeta la zona horaria que se le pasa", () => {
    const utc = toWallclock(new Date("2026-01-15T12:00:00Z"), "UTC");
    assert.equal(utc.getHours(), 12);
  });

  it("no le importa la zona del runtime: da el mismo numero siempre", () => {
    // Este es el contrato que hace que el server pueda validar horarios en
    // Buenos Aires aunque corra en UTC.
    const expected = 9;
    const local = toWallclock(new Date("2026-01-15T12:00:00Z"));
    assert.equal(local.getHours(), expected);
    assert.equal(
      local.getTime() - new Date(local.getFullYear(), local.getMonth(), local.getDate(), 9, 0, 0).getTime(),
      0,
    );
  });
});
